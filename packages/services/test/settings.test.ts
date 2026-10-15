import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { layout } from "@careeros/core";
import { setPath, settingsHandlers as S } from "../src/settings.js";
import { openSample } from "./helpers.js";

describe("settings", () => {
  it("returns schema fields with current values", () => {
    const { ctx } = openSample();
    const d = S["settings.get"](ctx, "profile");
    expect(d.fields.find((f) => f.path === "work_rights.status")?.optionLabels.needs_sponsorship).toBe("Need visa sponsorship");
    expect((d.values.contact as { name: string }).name).toBe("Alex Example");
  });
  it("changes only the given fields", () => {
    const { ctx, root } = openSample();
    const before = JSON.parse(fs.readFileSync(layout(root).profile, "utf8"));
    S["settings.save"](ctx, "profile", [{ path: "targets.roles", value: ["AI Engineer", "Data Engineer"] }]);
    const after = JSON.parse(fs.readFileSync(layout(root).profile, "utf8"));
    expect(after.targets.roles).toEqual(["AI Engineer", "Data Engineer"]);
    expect({ ...after, targets: before.targets }).toEqual(before);
  });
  it("saves a whole list of records (the preferred places) and refuses a bad row", () => {
    const { ctx, root } = openSample();
    const places = [{ place: "Exampleville QLD", modes: ["hybrid"], will_relocate: true }, { place: "Remote Australia", modes: ["remote"], will_relocate: false }];
    S["settings.save"](ctx, "profile", [{ path: "locations", value: places }]);
    expect(JSON.parse(fs.readFileSync(layout(root).profile, "utf8")).locations).toEqual(places);
    const before = fs.readFileSync(layout(root).profile, "utf8");
    expect(() => S["settings.save"](ctx, "profile", [{ path: "locations", value: [{ place: "", modes: ["remote"] }] }])).toThrow();
    expect(() => S["settings.save"](ctx, "profile", [{ path: "locations", value: [{ place: "Perth", modes: ["teleport"] }] }])).toThrow();
    expect(fs.readFileSync(layout(root).profile, "utf8")).toBe(before);
  });
  it("saves a default length for a custom video type, and only for a type that exists", () => {
    const { ctx, root } = openSample();
    const builtin = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../../../plugin/video-types/pitch.json"), "utf8"));
    const dir = path.join(root, "settings", "video-types");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "team-intro.json"), JSON.stringify({ ...builtin, id: "team-intro", label: "Team intro" }));
    S["settings.save"](ctx, "integrations", [{ path: "video.lengths.team_intro", value: 90 }]);
    expect(JSON.parse(fs.readFileSync(layout(root).integrations, "utf8")).video.lengths.team_intro).toBe(90);
    expect(() => S["settings.save"](ctx, "integrations", [{ path: "video.lengths.team_intro", value: 9000 }])).toThrow(/0 to 600/);
    expect(() => S["settings.save"](ctx, "integrations", [{ path: "video.lengths.not_a_type", value: 60 }])).toThrow(/can't be changed here/);
  });
  it("refuses unknown paths, whole objects and invalid values, and writes nothing", () => {
    const { ctx, root } = openSample();
    const before = fs.readFileSync(layout(root).profile, "utf8");
    expect(() => S["settings.save"](ctx, "profile", [{ path: "schema", value: 9 }])).toThrow(/can't be changed here/);
    expect(() => S["settings.save"](ctx, "profile", [{ path: "salary", value: {} }])).toThrow(/can't be changed here/);
    expect(() => S["settings.save"](ctx, "profile", [{ path: "work_rights.status", value: "tourist" }])).toThrow();
    expect(() => S["settings.save"](ctx, "profile", [{ path: "work_rights.visa_expiry", value: "30/06/2028" }])).toThrow();
    expect(fs.readFileSync(layout(root).profile, "utf8")).toBe(before);
  });
  it("refuses a __proto__.x change end to end, and writes nothing", () => {
    const { ctx, root } = openSample();
    const before = fs.readFileSync(layout(root).profile, "utf8");
    expect(() => S["settings.save"](ctx, "profile", [{ path: "__proto__.x", value: 1 }])).toThrow();
    expect(fs.readFileSync(layout(root).profile, "utf8")).toBe(before);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });
  it("setPath refuses __proto__/prototype/constructor segments and never pollutes Object.prototype", () => {
    expect(() => setPath({}, "__proto__.polluted", 1)).toThrow();
    expect(() => setPath({}, "constructor.prototype.polluted", 1)).toThrow();
    expect(() => setPath({ a: {} }, "a.prototype.polluted", 1)).toThrow();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
