import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  checkImageUrl, fetchRemoteImage, guardedLookup, IMAGE_TYPES, IMAGE_USER_AGENT, imageCacheKey, isBlockedAddress, MAX_IMAGE_BYTES,
  nodeImageFetcher, type Fetcher, type ImageCacheEntry, type RequestFn, type Resolver,
} from "../src/images.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
const fetcher = (routes: Record<string, () => Response>): Fetcher & { seen: { url: string; init: unknown }[] } => {
  const seen: { url: string; init: unknown }[] = [];
  const f = (async (url: string, init: unknown) => { seen.push({ url, init }); const r = routes[url]; if (!r) throw new Error("no route"); return r(); }) as Fetcher & { seen: typeof seen };
  f.seen = seen;
  return f;
};
const png = () => new Response(PNG, { headers: { "content-type": "image/png" } });

describe("fetchRemoteImage", () => {
  it("fetches an https image without cookies or referrer", async () => {
    const f = fetcher({ "https://images.example.com/logo.png": () => new Response(PNG, { headers: { "content-type": "image/png" } }) });
    const r = await fetchRemoteImage("https://images.example.com/logo.png", f);
    expect(r).toEqual({ type: "image/png", body: PNG });
    expect(f.seen[0]!.init).toMatchObject({ redirect: "manual", credentials: "omit", referrerPolicy: "no-referrer" });
  });
  it("follows https redirects only", async () => {
    const f = fetcher({
      "https://t.example.com/a": () => new Response(null, { status: 302, headers: { location: "https://images.example.com/logo.png" } }),
      "https://images.example.com/logo.png": () => new Response(PNG, { headers: { "content-type": "image/png" } }),
      "https://t.example.com/b": () => new Response(null, { status: 302, headers: { location: "http://images.example.com/x.png" } }),
    });
    expect((await fetchRemoteImage("https://t.example.com/a", f)).type).toBe("image/png");
    await expect(fetchRemoteImage("https://t.example.com/b", f)).rejects.toThrow(/https/);
  });
  it("refuses http, SVG, non-images and anything over 5 MB", async () => {
    const f = fetcher({
      "https://images.example.com/x.svg": () => new Response("<svg/>", { headers: { "content-type": "image/svg+xml" } }),
      "https://images.example.com/page": () => new Response("<html>", { headers: { "content-type": "text/html" } }),
      "https://images.example.com/big.png": () => new Response(Buffer.alloc(MAX_IMAGE_BYTES + 1), { headers: { "content-type": "image/png" } }),
    });
    await expect(fetchRemoteImage("http://images.example.com/x.png", f)).rejects.toThrow(/https/);
    await expect(fetchRemoteImage("https://images.example.com/x.svg", f)).rejects.toThrow(/isn't an image/);
    await expect(fetchRemoteImage("https://images.example.com/page", f)).rejects.toThrow(/isn't an image/);
    await expect(fetchRemoteImage("https://images.example.com/big.png", f)).rejects.toThrow(/larger than 5 MB/);
  });
});

describe("only https addresses on public hosts", () => {
  it("refuses every other scheme and protocol-relative addresses, without fetching", async () => {
    const f = fetcher({});
    for (const u of [
      "http://images.example.com/x.png", "data:image/png;base64,iVBORw0KGgo=", "file:///etc/passwd", "javascript:alert(1)",
      "blob:https://images.example.com/1234", "ftp://images.example.com/x.png", "//images.example.com/x.png", "ws://images.example.com/",
      "HTTP://images.example.com/x.png", " http://images.example.com/x.png", "",
    ]) {
      await expect(fetchRemoteImage(u, f), u).rejects.toThrow(/https/);
    }
    expect(f.seen).toEqual([]);
  });
  it("refuses credentials in the address", () => {
    expect(() => checkImageUrl("https://user:pw" + "@" + "images.example.com/x.png")).toThrow(/https/);
    expect(() => checkImageUrl("https://user" + "@" + "images.example.com/x.png")).toThrow(/https/);
  });
  it("refuses private, loopback, link-local, CGNAT and mapped IP literals in any notation", () => {
    for (const u of [
      "https://127.0.0.1/x.png", "https://2130706433/x.png", "https://0x7f000001/x.png", "https://0177.0.0.1/x.png", "https://0x7f.0.0.1/x.png",
      "https://127.1/x.png", "https://017700000001/x.png", "https://10.0.0.1/", "https://172.16.5.4/", "https://192.168.1.1/", "https://169.254.169.254/latest",
      "https://100.64.0.1/", "https://100.127.255.254/", "https://0.0.0.0/", "https://224.0.0.1/", "https://255.255.255.255/",
      "https://[::1]/", "https://[::]/", "https://[::ffff:127.0.0.1]/", "https://[::ffff:7f00:1]/", "https://[::ffff:8.8.8.8]/", "https://[fe80::1]/",
      "https://[fd00::1]/", "https://[fc00::1]/", "https://[ff02::1]/", "https://[64:ff9b::7f00:1]/", "https://[2002:7f00:1::]/",
    ]) {
      expect(() => checkImageUrl(u), u).toThrow(/isn't allowed/);
    }
  });
  it("allows a public IP literal, whatever its notation", () => {
    expect(checkImageUrl("https://8.8.8.8/x.png").hostname).toBe("8.8.8.8");
    expect(checkImageUrl("https://134744072/x.png").hostname).toBe("8.8.8.8");
    expect(checkImageUrl("https://0x08080808/x.png").hostname).toBe("8.8.8.8");
    expect(checkImageUrl("https://[2606:4700:4700::1111]/x.png").hostname).toBe("[2606:4700:4700::1111]");
  });
  it("refuses local names and other ports", () => {
    for (const u of ["https://localhost/x.png", "https://img.localhost/x.png", "https://intranet/x.png", "https://printer.local/x.png", "https://images.example.com:8443/x.png"]) {
      expect(() => checkImageUrl(u), u).toThrow(/isn't allowed/);
    }
  });
  it("classifies addresses", () => {
    for (const a of ["127.0.0.1", "10.1.2.3", "172.31.255.255", "192.168.0.1", "169.254.0.1", "100.64.0.0", "0.0.0.0", "224.0.0.251", "240.0.0.1", "192.0.2.1",
      "::1", "::", "::ffff:10.0.0.1", "::ffff:8.8.8.8", "fe80::1", "fe80::1%en0", "fd12:3456::1", "ff02::1", "2001:db8::1", "not-an-ip"]) {
      expect(isBlockedAddress(a), a).toBe(true);
    }
    for (const a of ["8.8.8.8", "93.184.216.34", "100.128.0.1", "2606:4700:4700::1111", "2a00:1450:4001::200e"]) expect(isBlockedAddress(a), a).toBe(false);
  });
});

describe("redirects", () => {
  it("re-checks every hop and caps the count", async () => {
    const f = fetcher({
      "https://t.example.com/private": () => new Response(null, { status: 301, headers: { location: "https://169.254.169.254/latest/meta-data" } }),
      "https://t.example.com/creds": () => new Response(null, { status: 307, headers: { location: "https://u:p" + "@" + "images.example.com/x.png" } }),
      "https://t.example.com/nowhere": () => new Response(null, { status: 302 }),
      "https://t.example.com/rel": () => new Response(null, { status: 302, headers: { location: "/logo.png" } }),
      "https://t.example.com/logo.png": png,
      "https://t.example.com/1": () => new Response(null, { status: 302, headers: { location: "/2" } }),
      "https://t.example.com/2": () => new Response(null, { status: 302, headers: { location: "/3" } }),
      "https://t.example.com/3": () => new Response(null, { status: 302, headers: { location: "/4" } }),
      "https://t.example.com/4": () => new Response(null, { status: 302, headers: { location: "/logo.png" } }),
    });
    await expect(fetchRemoteImage("https://t.example.com/private", f)).rejects.toThrow(/isn't allowed/);
    await expect(fetchRemoteImage("https://t.example.com/creds", f)).rejects.toThrow(/https/);
    await expect(fetchRemoteImage("https://t.example.com/nowhere", f)).rejects.toThrow(/without saying where/);
    expect((await fetchRemoteImage("https://t.example.com/rel", f)).type).toBe("image/png");
    await expect(fetchRemoteImage("https://t.example.com/1", f)).rejects.toThrow(/too many/);
    expect((await fetchRemoteImage("https://t.example.com/2", f)).type).toBe("image/png"); // 3 redirects is the limit
    expect(f.seen.map((s) => s.url)).not.toContain("https://169.254.169.254/latest/meta-data");
  });
});

describe("size, time and type", () => {
  it("stops reading once the body passes the cap, whatever Content-Length says", async () => {
    let pulls = 0;
    let cancelled = false;
    const endless = new ReadableStream<Uint8Array>({
      pull(c) { pulls++; c.enqueue(new Uint8Array(1024 * 1024)); },
      cancel() { cancelled = true; },
    });
    const f = fetcher({ "https://images.example.com/endless.png": () => new Response(endless, { headers: { "content-type": "image/png", "content-length": "100" } }) });
    await expect(fetchRemoteImage("https://images.example.com/endless.png", f)).rejects.toThrow(/larger than 5 MB/);
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(12);
  });
  it("refuses early when Content-Length already says too big", async () => {
    const f = fetcher({ "https://images.example.com/huge.png": () => new Response(PNG, { headers: { "content-type": "image/png", "content-length": String(MAX_IMAGE_BYTES + 1) } }) });
    await expect(fetchRemoteImage("https://images.example.com/huge.png", f)).rejects.toThrow(/larger than 5 MB/);
  });
  it("times out a server that never answers, and one that stalls mid-body", async () => {
    let signal: AbortSignal | null = null;
    const silent: Fetcher = (_u, init) => { signal = init.signal; return new Promise(() => undefined); };
    await expect(fetchRemoteImage("https://images.example.com/slow.png", silent, { timeoutMs: 30 })).rejects.toThrow(/took too long/);
    expect(signal!.aborted).toBe(true);
    const stall = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(PNG.subarray(0, 8))); } });
    const f = fetcher({ "https://images.example.com/stall.png": () => new Response(stall, { headers: { "content-type": "image/png" } }) });
    await expect(fetchRemoteImage("https://images.example.com/stall.png", f, { timeoutMs: 30 })).rejects.toThrow(/took too long/);
  });
  it("allows only png, jpeg, gif and webp, and checks the bytes match the declared type", async () => {
    expect(IMAGE_TYPES).toEqual(["image/png", "image/jpeg", "image/gif", "image/webp"]);
    const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
    const GIF = Buffer.from("GIF89a\x01\x00\x01\x00\x00\x00\x00;", "latin1");
    const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x1a, 0, 0, 0]), Buffer.from("WEBPVP8L"), Buffer.alloc(8)]);
    const r = (body: Buffer | string, type: string) => () => new Response(typeof body === "string" ? body : new Uint8Array(body), { headers: { "content-type": type } });
    const f = fetcher({
      "https://i.example.com/a.jpg": r(JPEG, "image/jpeg"),
      "https://i.example.com/a.gif": r(GIF, "image/gif"),
      "https://i.example.com/a.webp": r(WEBP, "image/webp; charset=binary"),
      "https://i.example.com/lie.jpg": r(PNG, "image/jpeg"),
      "https://i.example.com/svg.png": r("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>", "image/png"),
      "https://i.example.com/html.gif": r("<html><body>hi</body></html>", "image/gif"),
      "https://i.example.com/a.avif": r(PNG, "image/avif"),
      "https://i.example.com/a.bmp": r(PNG, "image/bmp"),
      "https://i.example.com/empty.png": r(Buffer.alloc(0), "image/png"),
      "https://i.example.com/none": r(PNG, ""),
    });
    expect((await fetchRemoteImage("https://i.example.com/a.jpg", f)).type).toBe("image/jpeg");
    expect((await fetchRemoteImage("https://i.example.com/a.gif", f)).type).toBe("image/gif");
    expect((await fetchRemoteImage("https://i.example.com/a.webp", f)).type).toBe("image/webp");
    for (const u of ["lie.jpg", "svg.png", "html.gif", "a.avif", "a.bmp", "empty.png", "none"]) {
      await expect(fetchRemoteImage(`https://i.example.com/${u}`, f), u).rejects.toThrow(/isn't an image/);
    }
  });
  it("refuses an error status", async () => {
    const f = fetcher({ "https://i.example.com/404.png": () => new Response("nope", { status: 404, headers: { "content-type": "image/png" } }) });
    await expect(fetchRemoteImage("https://i.example.com/404.png", f)).rejects.toThrow(/couldn't load \(404\)/);
  });
});

describe("privacy", () => {
  it("sends only a fixed Accept and a generic User-Agent: no cookie, referrer or anything identifying", async () => {
    const f = fetcher({ "https://images.example.com/logo.png": png });
    await fetchRemoteImage("https://images.example.com/logo.png", f);
    const init = f.seen[0]!.init as { headers: Record<string, string>; cache: string };
    expect(init.headers).toEqual({ Accept: "image/png,image/jpeg,image/gif,image/webp", "User-Agent": IMAGE_USER_AGENT });
    expect(IMAGE_USER_AGENT).toBe("Mozilla/5.0");
    expect(init.cache).toBe("no-store");
  });
  it("caches by URL hash only, and never caches a failure", async () => {
    const cache = new Map<string, ImageCacheEntry>();
    let n = 0;
    const f: Fetcher = async () => { n++; return png(); };
    const url = "https://images.example.com/logo.png?u=1";
    await fetchRemoteImage(url, f, { cache });
    const again = await fetchRemoteImage(url, f, { cache });
    expect(n).toBe(1);
    expect(again.body.equals(PNG)).toBe(true);
    expect([...cache.keys()]).toEqual([imageCacheKey(url)]);
    expect(imageCacheKey(url)).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify([...cache.keys()])).not.toContain("example");
    const bad: Fetcher = async () => new Response("<html>", { headers: { "content-type": "text/html" } });
    await expect(fetchRemoteImage("https://images.example.com/page", bad, { cache })).rejects.toThrow();
    expect(cache.size).toBe(1);
  });
});

describe("nodeImageFetcher checks the address it actually connects to", () => {
  // A stand-in for https.request: "connects" by calling the lookup it was given, like net.connect does.
  function fakeRequest(log: { url: string; options: Record<string, unknown> }[], respond = () => Object.assign(Readable.from([PNG]), { statusCode: 200, headers: { "content-type": "image/png", "set-cookie": ["a=b"] } })): RequestFn {
    return (url, options, cb) => {
      log.push({ url: url.href, options: options as Record<string, unknown> });
      const req = new EventEmitter() as EventEmitter & { end(): void; destroy(): void };
      req.destroy = () => undefined;
      req.end = () => {
        const lookup = options.lookup as (h: string, o: { all: boolean }, cb: (e: Error | null, a?: unknown) => void) => void;
        lookup(url.hostname, { all: true }, (err) => {
          if (err) req.emit("error", err);
          else cb(respond() as never);
        });
      };
      return req as never;
    };
  }
  const resolveTo = (...addrs: string[]): Resolver => async () => addrs.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));

  it("fetches through a public address with no agent, no cookies and only the fixed headers", async () => {
    const log: { url: string; options: Record<string, unknown> }[] = [];
    const f = nodeImageFetcher({ resolve: resolveTo("93.184.216.34"), request: fakeRequest(log) });
    const r = await fetchRemoteImage("https://images.example.com/logo.png", f);
    expect(r.body.equals(PNG)).toBe(true);
    const o = log[0]!.options;
    expect(o).toMatchObject({ method: "GET", agent: false, headers: { Accept: IMAGE_TYPES.join(","), "User-Agent": IMAGE_USER_AGENT }, servername: "images.example.com" });
    // Explicit, so NODE_TLS_REJECT_UNAUTHORIZED=0 in the environment can't turn certificate checks off (fix round 1).
    expect(o.rejectUnauthorized).toBe(true);
    expect(Object.keys(o.headers as object).map((k) => k.toLowerCase()).sort()).toEqual(["accept", "user-agent"]);
  });
  it("refuses a host that resolves to a private address, even when only one of several is", async () => {
    for (const addrs of [["127.0.0.1"], ["10.0.0.7"], ["93.184.216.34", "192.168.1.1"], ["::ffff:127.0.0.1"], ["fe80::1"], ["100.64.1.1"]]) {
      const f = nodeImageFetcher({ resolve: resolveTo(...addrs), request: fakeRequest([]) });
      await expect(fetchRemoteImage("https://images.example.com/logo.png", f), addrs.join()).rejects.toThrow(/isn't allowed/);
    }
  });
  it("re-checks on every connection, so DNS rebinding can't get through", async () => {
    let n = 0;
    const rebinding: Resolver = async () => [{ address: n++ === 0 ? "93.184.216.34" : "127.0.0.1", family: 4 }];
    const f = nodeImageFetcher({ resolve: rebinding, request: fakeRequest([]) });
    await expect(fetchRemoteImage("https://rebind.example.com/a.png", f)).resolves.toMatchObject({ type: "image/png" });
    await expect(fetchRemoteImage("https://rebind.example.com/a.png", f)).rejects.toThrow(/isn't allowed/);
  });
  it("refuses an IP-literal URL before any request is made", async () => {
    const log: { url: string; options: Record<string, unknown> }[] = [];
    const f = nodeImageFetcher({ resolve: resolveTo("93.184.216.34"), request: fakeRequest(log) });
    await expect(f("https://127.0.0.1/x.png", { redirect: "manual", credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store", headers: {}, signal: new AbortController().signal })).rejects.toThrow(/isn't allowed/);
    expect(log).toEqual([]);
  });
  it("answers both lookup callback forms, and refuses an empty answer", async () => {
    const lookup = guardedLookup(resolveTo("93.184.216.34", "2606:4700:4700::1111"));
    const one = await new Promise<unknown[]>((res) => lookup("a.example.com", {}, (...a: unknown[]) => res(a)));
    expect(one).toEqual([null, "93.184.216.34", 4]);
    const all = await new Promise<unknown[]>((res) => lookup("a.example.com", { all: true }, (...a: unknown[]) => res(a)));
    expect(all[1]).toEqual([{ address: "93.184.216.34", family: 4 }, { address: "2606:4700:4700::1111", family: 6 }]);
    const empty = guardedLookup(resolveTo());
    const e = await new Promise<unknown[]>((res) => empty("a.example.com", {}, (...a: unknown[]) => res(a)));
    expect(String(e[0])).toMatch(/couldn't be found/);
  });
});
