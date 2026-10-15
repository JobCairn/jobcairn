import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { layout } from "@careeros/core";
import { inboxHandlers as I } from "../src/inbox.js";
import { openSample, tmpDir } from "./helpers.js";

function downloads() {
  const dir = path.join(tmpDir(), "Downloads");
  fs.mkdirSync(dir, { recursive: true });
  const file = (name: string, text = "fictional") => { const p = path.join(dir, name); fs.writeFileSync(p, text); return p; };
  return { dir, file };
}
const inboxFiles = (root: string) => fs.readdirSync(layout(root).inbox).filter((n) => n !== "_filed.md").sort();

describe("removing files from the drop box", () => {
  it("sends one file to the Trash through the shell and lists what is left", async () => {
    const { ctx, root, host } = openSample();
    const d = downloads();
    await I["inbox.add"](ctx, [d.file("acme-notes.txt"), d.file("cv.pdf")]);
    const left = await I["inbox.remove"](ctx, ["acme-notes.txt"]);
    expect(left.map((i) => i.name)).toEqual(["cv.pdf"]);
    expect(host.shell.trashed).toEqual([path.join(layout(root).inbox, "acme-notes.txt")]);
  });

  it("removes exactly the names it was given, never a file that arrived later", async () => {
    const { ctx, root, host } = openSample();
    const d = downloads();
    await I["inbox.add"](ctx, [d.file("a.txt"), d.file("b.txt")]);
    fs.writeFileSync(path.join(layout(root).inbox, "late.txt"), "arrived after the confirm");
    await I["inbox.remove"](ctx, ["a.txt", "b.txt"]);
    expect(host.shell.trashed.map((p) => path.basename(p))).toEqual(["a.txt", "b.txt"]);
    expect(inboxFiles(root)).toEqual(["late.txt"]);
  });

  it("checks every name before trashing anything", async () => {
    const { ctx, root, host } = openSample();
    const d = downloads();
    await I["inbox.add"](ctx, [d.file("a.txt")]);
    for (const bad of [["a.txt", "missing.txt"], ["a.txt", "_filed.md"], ["a.txt", ".DS_Store"], ["a.txt", "../workspace.json"]]) {
      await expect(I["inbox.remove"](ctx, bad)).rejects.toThrow(/not in the drop box|not an inbox file name/);
    }
    expect(host.shell.trashed).toEqual([]);
    expect(inboxFiles(root)).toEqual(["a.txt"]);
  });

  it("never trashes through a symlink or a folder in the inbox", async () => {
    const { ctx, root, host } = openSample();
    const outside = downloads().file("secret.txt");
    fs.symlinkSync(outside, path.join(layout(root).inbox, "link.txt"));
    fs.mkdirSync(path.join(layout(root).inbox, "folder"));
    await expect(I["inbox.remove"](ctx, ["link.txt"])).rejects.toThrow(/not in the drop box/);
    await expect(I["inbox.remove"](ctx, ["folder"])).rejects.toThrow(/not in the drop box/);
    expect(host.shell.trashed).toEqual([]);
  });

  it("says so plainly when the Trash isn't available", async () => {
    const { ctx, host } = openSample();
    await I["inbox.add"](ctx, [downloads().file("a.txt")]);
    delete (host.shell as { trashItem?: unknown }).trashItem;
    await expect(I["inbox.remove"](ctx, ["a.txt"])).rejects.toThrow("Moving files to the Trash isn't available here, so nothing was removed.");
  });
});

describe("putting a file back where it came from", () => {
  it("knows the folder a dropped file came from, by name only", async () => {
    const { ctx } = openSample();
    const items = await I["inbox.add"](ctx, [downloads().file("cv.pdf")]);
    expect(items[0]!.from).toBe("Downloads");
    expect(JSON.stringify(items)).not.toContain(path.sep + "Downloads");
  });

  it("does not offer Put back for a file that arrived some other way", async () => {
    const { ctx, root } = openSample();
    fs.writeFileSync(path.join(layout(root).inbox, "finder.txt"), "x");
    expect((await I["inbox.list"](ctx))[0]!.from).toBeUndefined();
  });

  it("records the name the inbox copy got, not the original name", async () => {
    const { ctx } = openSample();
    const a = downloads().file("cv.pdf", "one");
    const b = downloads().file("cv.pdf", "two");
    await I["inbox.add"](ctx, [a]);
    const items = await I["inbox.add"](ctx, [b]);
    expect(items.map((i) => [i.name, i.from])).toEqual([["cv-2.pdf", "Downloads"], ["cv.pdf", "Downloads"]]);
    fs.rmSync(b);
    await I["inbox.putBack"](ctx, "cv-2.pdf");
    expect(fs.readFileSync(b, "utf8")).toBe("two");
    expect(fs.readFileSync(a, "utf8")).toBe("one");
  });

  it("moves the file back when the original is gone", async () => {
    const { ctx, root, host } = openSample();
    const d = downloads();
    const src = d.file("cv.pdf", "my resume");
    await I["inbox.add"](ctx, [src]);
    fs.rmSync(src);
    const r = await I["inbox.putBack"](ctx, "cv.pdf");
    expect(r.items).toEqual([]);
    expect(fs.readFileSync(src, "utf8")).toBe("my resume");
    expect(r.text).toBe("Moved cv.pdf back to Downloads.");
    expect(host.shell.trashed).toEqual([]);
    expect(inboxFiles(root)).toEqual([]);
  });

  it("trashes the drop box copy when the original is still there, and never overwrites it", async () => {
    const { ctx, root, host } = openSample();
    const src = downloads().file("cv.pdf", "original");
    await I["inbox.add"](ctx, [src]);
    fs.writeFileSync(src, "edited since");
    const r = await I["inbox.putBack"](ctx, "cv.pdf");
    expect(fs.readFileSync(src, "utf8")).toBe("edited since");
    expect(host.shell.trashed).toEqual([path.join(layout(root).inbox, "cv.pdf")]);
    expect(r.text).toBe("The original is still in Downloads, so the drop box copy went to the Trash.");
  });

  it("forgets the origin once the file is filed, removed or replaced", async () => {
    const { ctx, root } = openSample();
    const d = downloads();
    await I["inbox.add"](ctx, [d.file("a.txt"), d.file("b.txt"), d.file("c.txt")]);
    await I["inbox.file"](ctx, "a.txt", { kind: "me", dir: "resumes" }, "");
    await I["inbox.remove"](ctx, ["b.txt"]);
    // c.txt is replaced by a different file with the same name (dropped in through Finder).
    fs.rmSync(path.join(layout(root).inbox, "c.txt"));
    fs.writeFileSync(path.join(layout(root).inbox, "c.txt"), "someone else's");
    // A new file with a filed name doesn't inherit the old origin either.
    fs.writeFileSync(path.join(layout(root).inbox, "a.txt"), "new");
    expect((await I["inbox.list"](ctx)).map((i) => [i.name, i.from])).toEqual([["a.txt", undefined], ["c.txt", undefined]]);
    await expect(I["inbox.putBack"](ctx, "c.txt")).rejects.toThrow("The drop box doesn't know where c.txt came from. Use Remove instead.");
  });

  it("refuses to put back into a folder that was replaced by a link, or that is gone", async () => {
    const { ctx } = openSample();
    const d = downloads();
    await I["inbox.add"](ctx, [d.file("a.txt"), d.file("b.txt")]);
    fs.rmSync(d.dir, { recursive: true });
    await expect(I["inbox.putBack"](ctx, "a.txt")).rejects.toThrow("Downloads isn't there any more, so a.txt stays in the drop box. Use Remove instead.");
    const elsewhere = tmpDir();
    fs.symlinkSync(elsewhere, d.dir);
    await expect(I["inbox.putBack"](ctx, "b.txt")).rejects.toThrow("Downloads isn't there any more, so b.txt stays in the drop box. Use Remove instead.");
    expect(fs.readdirSync(elsewhere)).toEqual([]);
  });

  it("keeps origins per workspace, outside the workspace", async () => {
    const { ctx, root, host } = openSample();
    await I["inbox.add"](ctx, [downloads().file("a.txt")]);
    const origins = host.state.value.inboxOrigins?.[root];
    expect(Object.keys(origins ?? {})).toEqual(["a.txt"]);
    const inWorkspace = fs.readdirSync(root, { recursive: true }).map(String);
    expect(inWorkspace.some((p) => fs.lstatSync(path.join(root, p)).isFile() && fs.readFileSync(path.join(root, p), "utf8").includes(path.join("Downloads", "a.txt")))).toBe(false);
  });
});
