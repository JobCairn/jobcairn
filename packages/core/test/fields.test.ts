import { describe, expect, it } from "vitest";
import { fieldsFor } from "../src/fields.js";

describe("fieldsFor", () => {
  const f = fieldsFor("profile");
  const by = (p: string) => f.find((x) => x.path === p);
  it("reports arrays of enums as enum[] with their options", () => {
    expect(by("targets.job_types")).toMatchObject({ type: "enum[]", options: ["full_time", "contract", "part_time", "casual", "internship"] });
  });
  it("reports arrays of strings as string[]", () => {
    expect(by("contact.links")?.type).toBe("string[]");
    expect(by("targets.roles")?.type).toBe("string[]");
  });
  it("describes the Languages list, with a new row's level starting at Professional", () => {
    const langs = f.find((x) => x.path === "languages");
    expect(langs?.type).toBe("object[]");
    expect(langs?.fields.map((x) => [x.path, x.type, x.default])).toEqual([["language", "string", undefined], ["level", "enum", "professional"]]);
    expect(langs?.fields[1]?.optionLabels.native).toBe("Native or fluent");
  });

  it("describes arrays of objects with their item fields", () => {
    const loc = by("locations");
    expect(loc?.type).toBe("object[]");
    expect(loc?.fields.map((x) => [x.path, x.type])).toEqual([["place", "string"], ["modes", "enum[]"], ["will_relocate", "boolean"]]);
    expect(loc?.fields[1]?.options).toEqual(["onsite", "hybrid", "remote"]);
  });
  it("carries option labels and patterns for forms", () => {
    expect(by("work_rights.status")?.optionLabels.needs_sponsorship).toBe("Need visa sponsorship");
    expect(by("work_rights.visa_expiry")?.pattern).toBe("^(\\d{4}-\\d{2}-\\d{2})?$");
    expect(by("contact.name")).toMatchObject({ type: "string", options: [], optionLabels: {}, fields: [], pattern: "" });
  });
  it("keeps object groups as section headings with their children listed after them", () => {
    const g = fieldsFor("integrations");
    const i = g.findIndex((x) => x.path === "voice");
    expect(g[i]?.type).toBe("object");
    expect(g[i + 1]?.path).toBe("voice.engine");
  });
});
