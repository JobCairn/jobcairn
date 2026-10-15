import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createScheduler, nodeOsHost, type OsHost } from "../src/scheduler/index.js";
import { launchdPlist, systemdArg, systemdService, systemdTimer, taskSchedulerXml, taskXmlBytes, windowsArg } from "../src/scheduler/text.js";
import brand from "@careeros/brand/identity.json" with { type: "json" };

const MAC = { label: "app.careeros.desktop.mailsync", program: "/Applications/CareerOS.app/Contents/MacOS/CareerOS", args: ["--background-sync", "--workspace", "/Users/Alex Example/Документы/Career & Jobs"], minutes: 60 };
const WIN = { label: "x", program: "C:\\Program Files\\CareerOS\\CareerOS.exe", args: ["--background-sync", "--workspace", "C:\\Users\\Alex Example\\Career & Jobs\\"], minutes: 30 };
const LINUX = { label: "x", program: "/opt/CareerOS/careeros", args: ["--background-sync", "--workspace", "/home/alex/Career 100% \"Jobs\""], minutes: 90 };

describe("launchd", () => {
  it("writes an escaped argument array, never a shell line", () => {
    expect(launchdPlist(MAC)).toBe([
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      "<dict>",
      "  <key>Label</key>",
      "  <string>app.careeros.desktop.mailsync</string>",
      "  <key>ProgramArguments</key>",
      "  <array>",
      "    <string>/Applications/CareerOS.app/Contents/MacOS/CareerOS</string>",
      "    <string>--background-sync</string>",
      "    <string>--workspace</string>",
      "    <string>/Users/Alex Example/Документы/Career &amp; Jobs</string>",
      "  </array>",
      "  <key>StartInterval</key>",
      "  <integer>3600</integer>",
      "  <key>RunAtLoad</key>",
      "  <false/>",
      "  <key>ProcessType</key>",
      "  <string>Background</string>",
      "</dict>",
      "</plist>",
      "",
    ].join("\n"));
  });
});

describe("Task Scheduler", () => {
  it("quotes arguments the way Windows parses them", () => {
    expect(windowsArg("--workspace")).toBe("--workspace");
    expect(windowsArg("C:\\Users\\Alex Example\\Career & Jobs\\")).toBe('"C:\\Users\\Alex Example\\Career & Jobs\\\\"');
    expect(windowsArg('a"b')).toBe('"a\\"b"');
    expect(windowsArg("")).toBe('""');
  });
  it("writes a per-user, logged-on-only, least-privilege task as UTF-16 with a BOM", () => {
    const xml = taskSchedulerXml(WIN);
    expect(xml.split("\r\n")).toContain("      <LogonType>InteractiveToken</LogonType>");
    expect(xml).toContain("<RunLevel>LeastPrivilege</RunLevel>");
    expect(xml).toContain("<Interval>PT30M</Interval>");
    expect(xml).toContain("<Command>C:\\Program Files\\CareerOS\\CareerOS.exe</Command>");
    expect(xml).toContain("<Arguments>--background-sync --workspace &quot;C:\\Users\\Alex Example\\Career &amp; Jobs\\\\&quot;</Arguments>");
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-16"?>\r\n')).toBe(true);
    const bytes = taskXmlBytes(xml);
    expect([...bytes.subarray(0, 2)]).toEqual([0xff, 0xfe]);
    expect(bytes.subarray(2).toString("utf16le")).toBe(xml);
  });
});

describe("systemd", () => {
  it("quotes words and escapes specifiers", () => {
    expect(systemdArg('/home/alex/Career 100% "Jobs"')).toBe('"/home/alex/Career 100%% \\"Jobs\\""');
    expect(systemdArg("$HOME")).toBe('"$$HOME"');
    expect(() => systemdArg("a\nb")).toThrow(/line break/);
  });
  it("rejects other C0 control characters too (fix round 1, item 5)", () => {
    expect(() => systemdArg("a\tb")).toThrow(/control character/);
    expect(() => windowsArg("a\u0007b")).toThrow(/control character/);
    expect(() => launchdPlist({ ...MAC, program: "a\u0000b" })).toThrow(/control character/);
    expect(() => taskSchedulerXml({ ...WIN, program: "a\x1Bb" })).toThrow(/control character/);
  });
  it("writes a oneshot service that can reach the keyring, and a timer", () => {
    expect(systemdService(LINUX)).toBe([
      "[Unit]",
      `Description=${brand.name} mail sync (reads job email, never sends)`,
      "",
      "[Service]",
      "Type=oneshot",
      'ExecStart="/opt/CareerOS/careeros" "--background-sync" "--workspace" "/home/alex/Career 100%% \\"Jobs\\""',
      "Environment=DBUS_SESSION_BUS_ADDRESS=unix:path=%t/bus",
      "Nice=10",
      "",
    ].join("\n"));
    expect(systemdTimer(LINUX)).toBe([
      "[Unit]",
      `Description=Run ${brand.name} mail sync every 90 minutes`,
      "",
      "[Timer]",
      "OnBootSec=5min",
      "OnUnitActiveSec=90min",
      "Persistent=false",
      "",
      "[Install]",
      "WantedBy=timers.target",
      "",
    ].join("\n"));
  });
});

function fakeOs(platform: NodeJS.Platform, answers: Record<string, { code: number; stdout?: string; stderr?: string }> = {}) {
  const files = new Map<string, string | Buffer>();
  const writes: Array<{ p: string; opts?: { exclusive?: boolean } }> = [];
  const ran: string[] = [];
  const fakeHost: OsHost = {
    platform, home: platform === "win32" ? "C:\\Users\\Alex Example" : "/home/alex", uid: 501, tmpDir: "/tmp",
    writeFile: (p, d, opts) => { files.set(p, d); writes.push({ p, opts }); },
    removeFile: (p) => { files.delete(p); },
    exists: (p) => files.has(p),
    run: async (cmd, args) => {
      const line = [cmd, ...args].join(" ");
      ran.push(line);
      const a = Object.entries(answers).find(([k]) => line.startsWith(k))?.[1];
      return { code: a?.code ?? 0, stdout: a?.stdout ?? "", stderr: a?.stderr ?? (a && a.code ? "refused" : "") };
    },
  };
  return { os: fakeHost, files, writes, ran };
}
const INSTALL = { program: "/opt/CareerOS/careeros", args: ["--background-sync", "--workspace", "/home/alex/CareerOS"], minutes: 60 };

describe("createScheduler", () => {
  it("installs, reports and removes a launchd agent", async () => {
    const f = fakeOs("darwin", { "launchctl print": { code: 113 } });
    const s = createScheduler(f.os, "app.careeros.desktop");
    expect(await s.status()).toEqual({ installed: false, detail: "Not scheduled." });
    await s.install(INSTALL);
    const plist = "/home/alex/Library/LaunchAgents/app.careeros.desktop.mailsync.plist";
    expect(f.files.has(plist)).toBe(true);
    expect(f.ran).toEqual(["launchctl print gui/501/app.careeros.desktop.mailsync", `launchctl bootout gui/501 ${plist}`, `launchctl bootstrap gui/501 ${plist}`]);
    await s.remove();
    expect(f.files.has(plist)).toBe(false);
    expect(f.ran.at(-1)).toBe(`launchctl bootout gui/501 ${plist}`);
  });
  it("reports what the OS says, not what we wrote", async () => {
    const f = fakeOs("linux", { "systemctl --user is-enabled": { code: 1, stdout: "disabled\n" } });
    const s = createScheduler(f.os, "app.careeros.desktop");
    await s.install(INSTALL);
    expect(await s.status()).toEqual({ installed: false, detail: "The schedule files exist, but systemd reports \"disabled\"." });
    expect(f.ran).toEqual(["systemctl --user daemon-reload", "systemctl --user enable --now careeros-mailsync.timer", "systemctl --user is-enabled careeros-mailsync.timer"]);
  });
  it("creates a Windows task from a randomized, exclusively-created temporary XML file, then deletes it (fix round 1, item 4)", async () => {
    const f = fakeOs("win32");
    const s = createScheduler(f.os, "app.careeros.desktop");
    await s.install({ ...INSTALL, program: "C:\\Program Files\\CareerOS\\CareerOS.exe" });
    expect(f.ran[0]).toMatch(/^schtasks \/Create \/TN CareerOS Mail Sync \/XML .*careeros-mailsync-[^\\/]+\.xml \/F$/);
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0]?.opts).toEqual({ exclusive: true });
    expect([...f.files.keys()]).toEqual([]); // the temp file is cleaned up again after use
    expect(await s.status()).toEqual({ installed: true, detail: "Scheduled in Task Scheduler." });
    await s.remove();
    expect(f.ran.at(-1)).toBe("schtasks /Delete /TN CareerOS Mail Sync /F");
  });
  it("uses a different random temp filename on each install, so concurrent installs can't collide", async () => {
    const f = fakeOs("win32");
    const s = createScheduler(f.os, "app.careeros.desktop");
    await s.install(INSTALL);
    await s.install(INSTALL);
    const names = f.ran.filter((l) => l.startsWith("schtasks /Create")).map((l) => l.match(/careeros-mailsync-[^\\/]+\.xml/)?.[0]);
    expect(names[0]).toBeDefined();
    expect(names[0]).not.toBe(names[1]);
  });
  it("says plainly when the OS refuses", async () => {
    const f = fakeOs("darwin", { "launchctl bootstrap": { code: 5 } });
    await expect(createScheduler(f.os, "app.careeros.desktop").install(INSTALL)).rejects.toThrow("macOS didn't accept the background job: refused");
  });
  it("is unsupported elsewhere", async () => {
    const s = createScheduler(fakeOs("freebsd").os, "app.careeros.desktop");
    expect(s.supported).toBe(false);
    await expect(s.install(INSTALL)).rejects.toThrow(/isn't available/);
  });
});

describe("createScheduler: one schedule per workspace", () => {
  const A = "0b6f2c9e-1d2a-4c3b-8e7f-123456789abc";
  const B = "1c7a3d0f-2e3b-4d4c-9f80-23456789abcd";
  it("names each workspace's launchd agent after its id, so two workspaces never replace each other", async () => {
    const f = fakeOs("darwin");
    await createScheduler(f.os, "app.careeros", A).install(INSTALL);
    await createScheduler(f.os, "app.careeros", B).install(INSTALL);
    expect([...f.files.keys()].sort()).toEqual([
      `/home/alex/Library/LaunchAgents/app.careeros.mailsync.${A}.plist`, `/home/alex/Library/LaunchAgents/app.careeros.mailsync.${B}.plist`,
    ]);
    expect(String(f.files.get(`/home/alex/Library/LaunchAgents/app.careeros.mailsync.${A}.plist`))).toContain(`<string>app.careeros.mailsync.${A}</string>`);
    await createScheduler(f.os, "app.careeros", A).remove();
    expect([...f.files.keys()]).toEqual([`/home/alex/Library/LaunchAgents/app.careeros.mailsync.${B}.plist`]);
  });
  it("uses a per-workspace task name on Windows and unit name on Linux", async () => {
    const w = fakeOs("win32");
    await createScheduler(w.os, "app.careeros", A).install(INSTALL);
    expect(w.ran.at(-1)).toContain(`/TN CareerOS Mail Sync ${A} /XML`);
    const l = fakeOs("linux", { "systemctl --user is-enabled": { code: 0, stdout: "enabled\n" } });
    const s = createScheduler(l.os, "app.careeros", A);
    await s.install(INSTALL);
    expect([...l.files.keys()].sort()).toEqual([`/home/alex/.config/systemd/user/careeros-mailsync-${A}.service`, `/home/alex/.config/systemd/user/careeros-mailsync-${A}.timer`]);
    expect(await s.status()).toEqual({ installed: true, detail: "Scheduled with a systemd user timer." });
    expect(l.ran.at(-1)).toBe(`systemctl --user is-enabled careeros-mailsync-${A}.timer`);
  });
  it("refuses a workspace id that isn't a plain id", () => {
    for (const bad of ["../x", "ABC", "0b6f2c9e-1d2a-4c3b-8e7f-123456789abc/..", "a b"]) expect(() => createScheduler(fakeOs("darwin").os, "app.careeros", bad), bad).toThrow();
  });
});

describe("createScheduler: appId is validated against path traversal (fix round 1, item 1)", () => {
  it.each([
    ["path traversal", "../../../../tmp/evil"],
    ["a slash", "foo/bar"],
    ["a backslash", "foo\\bar"],
    ["empty", ""],
    ["just dot-dot", ".."],
    ["embedded dot-dot", "foo..bar"],
  ])("refuses an app id that is %s, and writes nothing", (_label, id) => {
    const f = fakeOs("darwin");
    expect(() => createScheduler(f.os, id)).toThrow();
    expect(f.files.size).toBe(0);
  });
  it("accepts a normal dotted app id and writes only inside LaunchAgents", async () => {
    const f = fakeOs("darwin");
    const s = createScheduler(f.os, "app.careeros.desktop");
    await s.install(INSTALL);
    for (const p of f.files.keys()) expect(path.dirname(p)).toBe("/home/alex/Library/LaunchAgents");
  });
});

describe("createScheduler: remove() is idempotent (fix round 1, item 2)", () => {
  it("treats an already-unloaded launchd job as removed, not an error", async () => {
    const f = fakeOs("darwin", { "launchctl bootout": { code: 3, stderr: "3: No such process" } });
    await expect(createScheduler(f.os, "app.careeros.desktop").remove()).resolves.toBeUndefined();
  });
  it("still throws when launchd refuses removal for a real reason, but cleans up the local file anyway", async () => {
    const plist = "/home/alex/Library/LaunchAgents/app.careeros.desktop.mailsync.plist";
    const f = fakeOs("darwin", { "launchctl bootout": { code: 1, stderr: "Operation not permitted" } });
    f.files.set(plist, "placeholder");
    await expect(createScheduler(f.os, "app.careeros.desktop").remove()).rejects.toThrow("macOS didn't accept removing the background job: Operation not permitted");
    expect(f.files.has(plist)).toBe(false);
  });
  it("treats a missing systemd unit as removed, not an error", async () => {
    const f = fakeOs("linux", { "systemctl --user disable": { code: 1, stderr: "Unit careeros-mailsync.timer does not exist." } });
    await expect(createScheduler(f.os, "app.careeros.desktop").remove()).resolves.toBeUndefined();
  });
  it("still throws when systemd refuses removal for a real reason, but cleans up local files anyway", async () => {
    const dir = "/home/alex/.config/systemd/user";
    const f = fakeOs("linux", { "systemctl --user disable": { code: 1, stderr: "Access denied" } });
    f.files.set(`${dir}/careeros-mailsync.timer`, "x");
    f.files.set(`${dir}/careeros-mailsync.service`, "x");
    await expect(createScheduler(f.os, "app.careeros.desktop").remove()).rejects.toThrow("systemd didn't accept removing the background job: Access denied");
    expect(f.files.has(`${dir}/careeros-mailsync.timer`)).toBe(false);
    expect(f.files.has(`${dir}/careeros-mailsync.service`)).toBe(false);
  });
  it("treats a missing Task Scheduler task as removed, not an error", async () => {
    const f = fakeOs("win32", { "schtasks /Delete": { code: 1, stderr: "ERROR: The system cannot find the file specified." } });
    await expect(createScheduler(f.os, "app.careeros.desktop").remove()).resolves.toBeUndefined();
  });
  it("still throws when Task Scheduler refuses removal for a real reason", async () => {
    const f = fakeOs("win32", { "schtasks /Delete": { code: 1, stderr: "ERROR: Access is denied." } });
    await expect(createScheduler(f.os, "app.careeros.desktop").remove()).rejects.toThrow("Windows didn't accept removing the background job: ERROR: Access is denied.");
  });
});

describe("nodeOsHost", () => {
  it("writes a temp file exclusively, refusing to clobber an existing one (fix round 1, item 4)", () => {
    const host = nodeOsHost();
    const p = path.join(host.tmpDir, `careeros-mailsync-test-${randomUUID()}.xml`);
    host.writeFile(p, "first");
    try {
      expect(() => host.writeFile(p, "second", { exclusive: true })).toThrow();
      expect(fs.readFileSync(p, "utf8")).toBe("first");
    } finally {
      host.removeFile(p);
    }
  });
  it("reports this platform's real home, uid and tmp dir", () => {
    const host = nodeOsHost();
    expect(host.platform).toBe(process.platform);
    expect(host.tmpDir).toBe(os.tmpdir());
  });
});
