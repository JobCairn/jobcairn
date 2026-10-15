import { describe, expect, it } from "vitest";
import { displayName } from "../src/components/displayName";

describe("displayName", () => {
  it("replaces a right-to-left override that disguises a file extension", () => {
    // Looks like "invoice...fdp.exe" would render reversed as "invoice...exe.pdf" to a
    // casual reader: the U+202E (RLO) flips everything after it right-to-left.
    expect(displayName("invoice‮fdp.exe")).toBe("invoice�fdp.exe");
  });

  it("replaces every bidi/format control character the brief lists", () => {
    const chars = ["‎", "‏", "؜", "‪", "‫", "‬", "‭", "‮", "⁦", "⁧", "⁨", "⁩"];
    for (const c of chars) expect(displayName(`a${c}b`)).toBe("a�b");
  });

  it("leaves an ordinary file name untouched", () => {
    expect(displayName("Visa_Grant_Notice.pdf")).toBe("Visa_Grant_Notice.pdf");
  });
});
