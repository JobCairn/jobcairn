import { describe, expect, it } from "vitest";
import type { FieldDef } from "@careeros/contract";
import { groupFields } from "../src/settings/fieldGroups";
import { SETTINGS_COMMANDS, matchCommand } from "../src/settings/commands";
import { initialConnection } from "../src/settings/connection-state";
import { parseHash, toHash } from "../src/router";

const f = (path: string): FieldDef => ({ path, label: path, type: "string", options: [], optionLabels: {}, help: "", pattern: "", fields: [] });

describe("groupFields", () => {
  it("groups the profile into short titled sections, in order, keeping field order", () => {
    const g = groupFields("profile", ["contact.name", "contact.email", "work_rights.status", "targets.roles", "locations", "salary.min", "industries.include", "skip_big_tech", "mystery"].map(f));
    expect(g.map((x) => [x.id, x.title, x.fields.map((y) => y.path)])).toEqual([
      ["about-you", "About you", ["contact.name", "contact.email"]],
      ["work-rights", "Work rights", ["work_rights.status"]],
      ["roles", "Experience", ["targets.roles"]],
      ["locations", "Where you want to work", ["locations"]],
      ["salary", "Salary", ["salary.min"]],
      ["companies", "Companies and industries", ["industries.include", "skip_big_tech"]],
      ["more", "More", ["mystery"]],
    ]);
  });
  it("drops empty groups and never loses a field", () => {
    const g = groupFields("search", [f("search_deadline"), f("weekly_goal")]);
    expect(g.map((x) => x.id)).toEqual(["plan"]);
    expect(groupFields("search", []).length).toBe(0);
  });
});

describe("settings deep links", () => {
  it("keeps the old Claude tab as an alias and round-trips connections and sections", () => {
    expect(parseHash("#/settings?tab=claude")).toEqual({ screen: "settings", tab: "connections", c: "claude" });
    for (const r of [{ screen: "settings", tab: "connections", c: "email" }, { screen: "settings", tab: "profile", section: "work-rights" }] as const) expect(parseHash(toHash(r))).toEqual(r);
    expect(parseHash("#/settings?tab=connections&c=nope")).toEqual({ screen: "settings", tab: "connections" });
    expect(parseHash("#/settings?tab=profile&section=../x")).toEqual({ screen: "settings", tab: "profile" });
  });
  it("opens the asked-for connection, else the remembered one, else one that needs setup", () => {
    expect(initialConnection({ asked: "email", remembered: "chrome", needsSetup: ["claude"] })).toBe("email");
    expect(initialConnection({ remembered: "chrome", needsSetup: [] })).toBe("chrome");
    expect(initialConnection({ needsSetup: ["claude"] })).toBe("claude");
    expect(initialConnection({ needsSetup: [] })).toBeNull();
  });
});

describe("settings in the command bar", () => {
  it("finds settings by everyday words and links to the exact place", () => {
    const find = (q: string) => SETTINGS_COMMANDS.filter((c) => matchCommand(c, q)).map((c) => toHash(c.to));
    expect(find("api key")).toContain("#/settings?tab=connections&c=claude&section=anthropic-api-key");
    expect(find("gmail")).toContain("#/settings?tab=connections&c=email");
    expect(find("voice")).toContain("#/settings?tab=voice");
    expect(find("theme")).toContain("#/settings?tab=appearance");
    expect(find("visa")).toContain("#/settings?tab=profile&section=work-rights");
  });
});
