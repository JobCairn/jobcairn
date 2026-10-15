import crypto from "node:crypto";
import dns from "node:dns";
import type http from "node:http";
import https from "node:https";
import net from "node:net";
import { Readable } from "node:stream";
import identity from "@careeros/brand/identity.json" with { type: "json" };

/** The only image types "Load images" will show. SVG is left out on purpose: it can carry script. */
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Fixed and generic, so the request says nothing about the person or the app. */
export const IMAGE_USER_AGENT = "Mozilla/5.0";
const MAX_URL_LENGTH = 4096;

export interface FetchInit {
  redirect: "manual"; credentials: "omit"; referrerPolicy: "no-referrer"; cache: "no-store";
  headers: Record<string, string>; signal: AbortSignal;
}
export type Fetcher = (url: string, init: FetchInit) => Promise<Response>;

export interface ImageCacheEntry { type: string; body: Buffer }
/** Where fetched images are kept. Keys are `imageCacheKey(url)` (a SHA-256 hex digest), never the URL itself. */
export interface ImageCache { get(key: string): ImageCacheEntry | undefined; set(key: string, value: ImageCacheEntry): unknown }

export class ImageFetchError extends Error {
  constructor(message: string) { super(message); this.name = "ImageFetchError"; }
}
const HTTPS_ONLY = "Images load over https only.";
const NOT_ALLOWED = "That image address isn't allowed: it points at this computer or a private network.";
const NOT_IMAGE = `That address isn't an image ${identity.name} will show.`;
const TOO_BIG = "The image is larger than 5 MB.";
const TOO_SLOW = "The image took too long to load.";

// --- addresses ------------------------------------------------------------------------------------

const BLOCKED_V4 = new net.BlockList();
for (const [a, p] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) BLOCKED_V4.addSubnet(a, p, "ipv4");

// IPv6 must be global unicast (2000::/3), which already rules out ::, ::1, IPv4-mapped (::ffff:0:0/96),
// IPv4-compatible, unique-local fc00::/7, link-local fe80::/10, site-local and multicast ff00::/8.
// Inside 2000::/3, the ranges below can still reach an IPv4 or a non-public network, so they are refused too.
const GLOBAL_V6 = new net.BlockList();
GLOBAL_V6.addSubnet("2000::", 3, "ipv6");
const BLOCKED_V6 = new net.BlockList();
for (const [a, p] of [["2001::", 32], ["2001:db8::", 32], ["2001:10::", 28], ["2001:20::", 28], ["2002::", 16], ["3fff::", 20]] as const) BLOCKED_V6.addSubnet(a, p, "ipv6");
const NAT64 = new net.BlockList();
NAT64.addSubnet("64:ff9b::", 96, "ipv6");
NAT64.addSubnet("64:ff9b:1::", 48, "ipv6");

/**
 * True for any address an image fetch must never reach: private, loopback, link-local,
 * unique-local, multicast, unspecified, CGNAT 100.64/10, documentation and benchmark ranges,
 * IPv4-mapped or -translated IPv6, 6to4 and Teredo, and anything that isn't an IP address at all.
 */
export function isBlockedAddress(ip: string): boolean {
  if (typeof ip !== "string" || ip.includes("%")) return true; // a zone id means link-local
  const kind = net.isIP(ip);
  if (kind === 4) return BLOCKED_V4.check(ip, "ipv4");
  if (kind === 6) {
    // BlockList.check() also matches IPv4-mapped forms against v4 rules, so check NAT64 first and
    // then require global unicast.
    if (NAT64.check(ip, "ipv6")) return true;
    return !GLOBAL_V6.check(ip, "ipv6") || BLOCKED_V6.check(ip, "ipv6");
  }
  return true;
}

/**
 * Parses and checks one image address: https only, no user name or password, port 443, a
 * dotted public host name or a public IP literal. The WHATWG URL parser turns decimal, octal and
 * hex IPv4 forms (2130706433, 0177.0.0.1, 0x7f.1) into dotted form first, so they get the same check.
 */
export function checkImageUrl(u: string): URL {
  if (typeof u !== "string" || u.length > MAX_URL_LENGTH) throw new ImageFetchError(HTTPS_ONLY);
  let url: URL;
  try { url = new URL(u); } catch { throw new ImageFetchError(HTTPS_ONLY); }
  if (url.protocol !== "https:" || url.username || url.password) throw new ImageFetchError(HTTPS_ONLY);
  if (url.port !== "" && url.port !== "443") throw new ImageFetchError(NOT_ALLOWED);
  const host = url.hostname;
  if (host.startsWith("[")) {
    if (isBlockedAddress(host.slice(1, -1))) throw new ImageFetchError(NOT_ALLOWED);
    return url;
  }
  if (net.isIP(host)) {
    if (isBlockedAddress(host)) throw new ImageFetchError(NOT_ALLOWED);
    return url;
  }
  const name = host.replace(/\.$/, "").toLowerCase();
  if (!name.includes(".") || name === "localhost" || /\.(localhost|local|internal|home\.arpa)$/.test(name)) throw new ImageFetchError(NOT_ALLOWED);
  return url;
}

/** The cache key for an image address: a SHA-256 hex digest of the normalised URL, so no address is stored in the clear. */
export function imageCacheKey(url: string): string {
  return crypto.createHash("sha256").update(checkImageUrl(url).href).digest("hex");
}

// --- content ----------------------------------------------------------------------------------------

/** The image type the bytes themselves say, or "" for anything else. */
export function sniffImageType(b: Buffer): string {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString("latin1"))) return "image/gif";
  if (b.length >= 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return "";
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/**
 * Fetches one remote image for "Load images": https only (redirects too, each hop re-checked),
 * no cookies or referrer, a fixed generic User-Agent, png/jpeg/gif/webp only (header and magic
 * bytes must agree), at most 5 MB however the server labels it, and one timeout covering the
 * connection, the headers and the whole body. Pass `nodeImageFetcher()` in production: it also
 * checks every address it actually connects to. Successful results go into `opts.cache` (if
 * given) under `imageCacheKey(url)`.
 */
export async function fetchRemoteImage(url: string, fetcher: Fetcher, opts: { maxRedirects?: number; timeoutMs?: number; cache?: ImageCache } = {}): Promise<{ type: string; body: Buffer }> {
  const first = checkImageUrl(url);
  const key = crypto.createHash("sha256").update(first.href).digest("hex");
  const hit = opts.cache?.get(key);
  if (hit) return { type: hit.type, body: Buffer.from(hit.body) };

  const maxRedirects = Math.min(Math.max(opts.maxRedirects ?? 3, 0), 5);
  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { ctl.abort(); reject(new ImageFetchError(TOO_SLOW)); }, opts.timeoutMs ?? 15_000);
  });
  timedOut.catch(() => undefined);
  const race = <T>(p: Promise<T>): Promise<T> => Promise.race([p, timedOut]);

  try {
    let current = first;
    for (let hop = 0; ; hop++) {
      const res = await race(fetcher(current.href, {
        redirect: "manual", credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store",
        headers: { Accept: IMAGE_TYPES.join(","), "User-Agent": IMAGE_USER_AGENT }, signal: ctl.signal,
      }));
      if (REDIRECTS.has(res.status)) {
        void res.body?.cancel().catch(() => undefined);
        const loc = res.headers.get("location");
        if (!loc) throw new ImageFetchError("The image moved without saying where.");
        if (hop >= maxRedirects) throw new ImageFetchError("The image redirected too many times.");
        let next: string;
        try { next = new URL(loc, current).href; } catch { throw new ImageFetchError(HTTPS_ONLY); }
        current = checkImageUrl(next);
        continue;
      }
      if (!res.ok) {
        void res.body?.cancel().catch(() => undefined);
        throw new ImageFetchError(`The image couldn't load (${res.status}).`);
      }
      const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
      if (!IMAGE_TYPES.includes(type)) { void res.body?.cancel().catch(() => undefined); throw new ImageFetchError(NOT_IMAGE); }
      if (Number(res.headers.get("content-length") ?? 0) > MAX_IMAGE_BYTES) { void res.body?.cancel().catch(() => undefined); throw new ImageFetchError(TOO_BIG); }

      const chunks: Buffer[] = [];
      let size = 0;
      const reader = res.body?.getReader();
      try {
        while (reader) {
          const { done, value } = await race(reader.read());
          if (done) break;
          size += value.byteLength;
          if (size > MAX_IMAGE_BYTES) throw new ImageFetchError(TOO_BIG);
          chunks.push(Buffer.from(value));
        }
      } catch (e) {
        void reader?.cancel().catch(() => undefined);
        throw e;
      }
      const body = Buffer.concat(chunks);
      if (sniffImageType(body) !== type) throw new ImageFetchError(NOT_IMAGE);
      opts.cache?.set(key, { type, body: Buffer.from(body) });
      return { type, body };
    }
  } finally {
    clearTimeout(timer);
  }
}

// --- the production fetcher -------------------------------------------------------------------------

export type Resolver = (host: string) => Promise<{ address: string; family: number }[]>;
type LookupCallback = (err: NodeJS.ErrnoException | null, address?: string | { address: string; family: number }[], family?: number) => void;
export type RequestFn = (url: URL, options: https.RequestOptions, cb: (res: http.IncomingMessage) => void) => http.ClientRequest;

const systemResolver: Resolver = (host) => dns.promises.lookup(host, { all: true, verbatim: true });

/**
 * A `lookup` for net/tls.connect that resolves the name and refuses the connection if any
 * address is blocked. It runs for every connection, at connect time, on the very addresses the
 * socket will use, so a name that resolves to a public address once and a private one later
 * (DNS rebinding) is still caught.
 */
export function guardedLookup(resolve: Resolver = systemResolver) {
  return (hostname: string, options: { all?: boolean } | number | undefined, cb: LookupCallback): void => {
    resolve(hostname).then((list) => {
      if (!list.length) return cb(Object.assign(new ImageFetchError("The image's server couldn't be found."), { code: "ENOTFOUND" }));
      if (list.some((a) => isBlockedAddress(a.address))) return cb(Object.assign(new ImageFetchError(NOT_ALLOWED), { code: "EBLOCKED" }));
      const clean = list.map((a) => ({ address: a.address, family: a.family }));
      if (typeof options === "object" && options?.all) cb(null, clean);
      else cb(null, clean[0]!.address, clean[0]!.family);
    }, (e: unknown) => cb(Object.assign(new ImageFetchError("The image's server couldn't be found."), { code: (e as { code?: string })?.code ?? "ENOTFOUND" })));
  };
}

/**
 * The Fetcher to use in production: node:https with no agent (no pooled sockets, no proxy, no
 * cookie jar), certificate checks on explicitly (so the environment variable that disables them globally has no effect here), a guarded lookup on every connection, and only the headers
 * fetchRemoteImage passes. It never follows a redirect itself.
 */
export function nodeImageFetcher(deps: { resolve?: Resolver; request?: RequestFn } = {}): Fetcher {
  const lookup = guardedLookup(deps.resolve);
  const request: RequestFn = deps.request ?? ((url, options, cb) => https.request(url, options, cb));
  return (url, init) => new Promise<Response>((resolve, reject) => {
    let u: URL;
    try { u = checkImageUrl(url); } catch (e) { reject(e); return; }
    const isLiteral = u.hostname.startsWith("[") || net.isIP(u.hostname) !== 0;
    const options: https.RequestOptions = {
      method: "GET", headers: { ...init.headers }, agent: false, rejectUnauthorized: true, signal: init.signal, lookup: lookup as unknown as https.RequestOptions["lookup"],
      minVersion: "TLSv1.2", maxHeaderSize: 16 * 1024, ...(isLiteral ? {} : { servername: u.hostname }),
    };
    let req: http.ClientRequest;
    try {
      req = request(u, options, (res) => {
        const status = res.statusCode ?? 0;
        const headers = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (v === undefined || k === "set-cookie") continue;
          try { headers.set(k, Array.isArray(v) ? v.join(", ") : v); } catch { /* a header Headers won't take is one the app doesn't need */ }
        }
        try {
          if (REDIRECTS.has(status) || [204, 205, 304].includes(status)) {
            res.resume();
            resolve(new Response(null, { status, headers }));
          } else {
            resolve(new Response(Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>, { status, headers }));
          }
        } catch (e) {
          res.destroy();
          reject(e);
        }
      });
    } catch (e) { reject(e); return; }
    req.on("error", reject);
    req.end();
  });
}
