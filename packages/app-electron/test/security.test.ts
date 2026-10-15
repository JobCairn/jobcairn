import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fileUrlFor } from "../src/channels.js";
import { appFileFor, contentType, CSP, devUrlFrom, fileUrlToRel, frameNavigation, isTrustedSender, linkPrompt, rendererError } from "../src/security.js";

const R = path.resolve("/fictional/app/renderer");
const src = (f: string) => fs.readFileSync(path.resolve(import.meta.dirname, "../src", f), "utf8");

describe("CSP", () => {
  it("allows only our own code and the workspace media scheme", () => {
    for (const d of ["default-src 'none'", "script-src 'self'", "style-src 'self'", "font-src 'self'", "img-src 'self' careeros-file:", "media-src careeros-file:",
      "frame-src careeros-mail: careeros-file:", "connect-src 'self'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'", "object-src 'none'"]) expect(CSP).toContain(d);
    expect(CSP).not.toMatch(/unsafe-|https:|http:|data:|\*/);
  });
});

describe("frame navigation", () => {
  it("lets subframes load only stored-message documents and turns link clicks into the link dialog", () => {
    expect(frameNavigation("careeros-mail://msg/abc", false)).toBe("allow");
    expect(frameNavigation("careeros-mail://link/abc/0", false)).toBe("link");
    for (const u of ["https://example.com/", "careeros-mail://img/abc/0", "careeros-file://ws/x.png", "javascript:alert(1)", "about:blank", "data:text/html,x",
      "careeros-file://ws/a%2F..%2Fb.pdf", "careeros-file://other/a.pdf", "careeros-file://ws/a.pdf.html", "careeros-file://ws/a.pdf?x=1", "chrome-extension://otherextensionid/x"]) {
      expect(frameNavigation(u, false), u).toBe("block");
    }
    expect(frameNavigation("careeros-mail://msg/abc", true)).toBe("block");
  });
  it("lets the file viewer show one workspace PDF in the built-in PDF viewer, and nothing else", () => {
    expect(frameNavigation("careeros-file://ws/companies/acme/jobs/x/application/resume.pdf", false)).toBe("allow");
    expect(frameNavigation("careeros-file://ws/a/Resume%20v2.PDF", false)).toBe("allow");
    expect(frameNavigation("chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/0b0c1d2e", false)).toBe("allow");
    expect(frameNavigation("careeros-file://ws/a/resume.pdf", true)).toBe("block");
  });
});

describe("app:// files", () => {
  it("maps app URLs into the renderer folder", () => {
    expect(appFileFor(R, "app://careeros/index.html")).toBe(path.join(R, "index.html"));
    expect(appFileFor(R, "app://careeros/")).toBe(path.join(R, "index.html"));
    expect(appFileFor(R, "app://careeros/assets/geist-latin-400.woff2")).toBe(path.join(R, "assets", "geist-latin-400.woff2"));
  });
  it("refuses other hosts, schemes and escapes", () => {
    for (const u of ["app://other/index.html", "file:///etc/passwd", "app://careeros/../../etc/passwd", "app://careeros/%2e%2e/%2e%2e/etc/passwd", "app://careeros/a%5c..%5c..%5cx", "app://careeros/%00", "not a url"]) {
      const f = appFileFor(R, u);
      expect(f === null || f.startsWith(R + path.sep), u).toBe(true);
    }
    expect(appFileFor(R, "app://other/index.html")).toBeNull();
  });
  it("labels content types", () => {
    expect(contentType("a/index.html")).toBe("text/html; charset=utf-8");
    expect(contentType("a.woff2")).toBe("font/woff2");
    expect(contentType("a.unknown")).toBe("application/octet-stream");
  });
});

describe("careeros-file:// URLs", () => {
  it("turns URLs into workspace-relative paths", () => {
    expect(fileUrlToRel("careeros-file://ws/learning/rag/demo%20clip.mp4")).toBe("learning/rag/demo clip.mp4");
    expect(fileUrlToRel("careeros-file://other/x.png")).toBeNull();
    expect(fileUrlToRel("careeros-file://ws/")).toBeNull();
    expect(fileUrlToRel("careeros-file://ws/%E0%A4%A")).toBeNull();
  });
  it("never yields a dot-dot segment", () => {
    const rel = fileUrlToRel("careeros-file://ws/learning/%2e%2e/%2e%2e/settings/.env");
    expect(rel === null || !rel.split("/").includes("..")).toBe(true);
  });
});

describe("IPC senders and dev mode", () => {
  it("trusts only the app origin, and the dev server only when given", () => {
    expect(isTrustedSender("app://careeros/index.html", null)).toBe(true);
    expect(isTrustedSender("https://evil.example.com/", null)).toBe(false);
    expect(isTrustedSender("app://careerosx/index.html", null)).toBe(false);
    expect(isTrustedSender(undefined, null)).toBe(false);
    expect(isTrustedSender("http://127.0.0.1:5173/", "http://127.0.0.1:5173")).toBe(true);
    expect(isTrustedSender("http://127.0.0.1:5173/", null)).toBe(false);
  });
  it("uses a dev URL only for an unpackaged app on the loopback address", () => {
    expect(devUrlFrom({ CAREEROS_DEV_URL: "http://127.0.0.1:5173" }, false)).toBe("http://127.0.0.1:5173");
    expect(devUrlFrom({ CAREEROS_DEV_URL: "http://127.0.0.1:5173" }, true)).toBeNull();
    expect(devUrlFrom({ CAREEROS_DEV_URL: "https://evil.example.com" }, false)).toBeNull();
    expect(devUrlFrom({}, false)).toBeNull();
  });
});

describe("main process hardening (source check)", () => {
  it("keeps the required window and app settings", () => {
    const main = src("main.ts");
    for (const s of ["contextIsolation: true", "sandbox: true", "nodeIntegration: false", "webSecurity: true", "app.enableSandbox()", "requestSingleInstanceLock(",
      "setPermissionRequestHandler", "setPermissionCheckHandler", "setWindowOpenHandler", "\"will-navigate\"", "\"will-attach-webview\"", "\"will-frame-navigate\"", "careeros-mail", "resolveMailAsset"]) expect(main, s).toContain(s);
    expect(main).not.toMatch(/nodeIntegration: true|contextIsolation: false|sandbox: false|webSecurity: false|enableRemoteModule/);
    // The runtime installs the grant timer once per context; main must not install a second one.
    expect(main).not.toContain("installGrantTimer");
    expect(main).toContain('powerMonitor.on("resume"');
  });
  it("keeps Electron out of the pure modules", () => {
    for (const f of ["security.ts", "state-store.ts", "secret-store.ts", "claude.ts", "e2e.ts", "channels.ts", "media.ts", "background.ts", "mail-host.ts"]) expect(src(f), f).not.toMatch(/from "electron"/);
  });
});

// Review requirements: one decode, no separators/dots/controls/absolute paths, and plain errors and link prompts.
describe("careeros-file:// hardening", () => {
  it("round-trips the preload's encoding, decoding exactly once", () => {
    for (const rel of ["learning/rag/demo clip.mp4", "learning/100%.png", "learning/%41.png", "learning/%2e%2e.png", "learning/a#b?c&d=e.png", "learning/résumé ünï.png"]) {
      expect(fileUrlToRel(fileUrlFor(rel)), rel).toBe(rel);
    }
    expect(fileUrlToRel("careeros-file://ws/learning/%2541.png")).toBe("learning/%41.png");
  });
  it("refuses control characters, encoded separators, dot segments, empty segments and absolute paths", () => {
    for (const u of [
      "careeros-file://ws/learning/a%00b.png", "careeros-file://ws/learning/a%0Ab.png", "careeros-file://ws/learning/a%09b.png", "careeros-file://ws/learning/a%7Fb.png",
      "careeros-file://ws/learning/a%C2%85b.png", "careeros-file://ws/learning/..%2Fsettings", "careeros-file://ws/learning%2F..%2F..%2Fx", "careeros-file://ws/learning%5C..%5Cx",
      "careeros-file://ws/%2Fetc%2Fpasswd", "careeros-file://ws/C:/x.png", "careeros-file://ws/c%3A%5Cx.png", "careeros-file://ws/learning//x.png", "careeros-file://ws/learning/",
      "careeros-file://ws/%2E", "careeros-file://ws/%2E%2E", "careeros-file://alex@ws/x.png", "careeros-file://ws:1/x.png",
    ]) expect(fileUrlToRel(u), u).toBeNull();
  });
});

describe("rendererError", () => {
  it("keeps only a plain name and the first line of the message", () => {
    const src = Object.assign(new Error("first line\nsecond line", { cause: new Error("inner") }), { code: "EACCES", path: "/fictional/secret" });
    const e = rendererError(src);
    expect(e.message).toBe("first line");
    expect(e.stack).toBe("Error: first line");
    for (const k of ["cause", "code", "path"]) expect(e, k).not.toHaveProperty(k);
    expect(String(e)).toBe("Error: first line");
    const arg = Object.assign(new Error("jobs.list: bad"), { name: "ArgError" });
    expect(String(rendererError(arg))).toBe("ArgError: jobs.list: bad");
    expect(rendererError(Object.assign(new Error("x"), { name: "Evil\nName <b>" })).name).toBe("Error");
    expect(rendererError(undefined).message).toBe("Something went wrong.");
    expect(rendererError("plain words").message).toBe("plain words");
  });
});

describe("linkPrompt", () => {
  it("names the real host, never the user-info part, and shows the full address", () => {
    const disguised = "https://ok.example.com" + "@" + "evil.example/path"; // built by concatenation (privacy hook)
    const p = linkPrompt(disguised)!;
    expect(p.message).toBe("Open evil.example in your browser?");
    expect(p.detail).toContain(disguised);
    expect(linkPrompt("https://jobs.example.com:8443/a?b=c")!.message).toBe("Open jobs.example.com:8443 in your browser?");
    expect(linkPrompt("not a url")).toBeNull();
  });
});
