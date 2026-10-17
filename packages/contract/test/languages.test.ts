import { describe, expect, it } from "vitest";
import { checkLanguages, detectLanguageNeeds, languageRule, normaliseLanguage, spokenLanguages, type LanguageNeed } from "../src/index.js";

const needs = (text: string) => detectLanguageNeeds(text).map((n) => [n.language, n.level]);

describe("detectLanguageNeeds: what an ad requires", () => {
  it("reads a level word before the language", () => {
    expect(needs("You are fluent in German and English.")).toEqual([["German", "native"]]);
    expect(needs("Fluency in Japanese is a must.")).toEqual([["Japanese", "native"]]);
    expect(needs("Business-level Japanese required.")).toEqual([["Japanese", "professional"]]);
    expect(needs("Conversational Spanish would let you talk with the Madrid office every day.")).toEqual([["Spanish", "conversational"]]);
    expect(needs("A working knowledge of French.")).toEqual([["French", "conversational"]]);
    expect(needs("Excellent written and verbal English.")).toEqual([["English", "professional"]]);
    expect(needs("A native Korean speaker.")).toEqual([["Korean", "native"]]);
  });

  it("reads a level word after the language", () => {
    expect(needs("Languages: Japanese (fluent)")).toEqual([["Japanese", "native"]]);
    expect(needs("German: native")).toEqual([["German", "native"]]);
    expect(needs("English at C1 or above")).toEqual([["English", "professional"]]);
  });

  it("reads plain requirements with no level", () => {
    expect(needs("German required.")).toEqual([["German", null]]);
    expect(needs("Mandarin is essential for this role.")).toEqual([["Mandarin", null]]);
    expect(needs("Japanese language skills are mandatory.")).toEqual([["Japanese", null]]);
    expect(needs("Japanese speaking Account Manager")).toEqual([["Japanese", null]]);
    expect(needs("You must speak Vietnamese.")).toEqual([["Vietnamese", null]]);
    expect(needs("Ability to communicate in Italian with suppliers.")).toEqual([["Italian", null]]);
  });

  it("reads both languages of a bilingual role", () => {
    expect(needs("Bilingual in English and Mandarin.")).toEqual([["English", "native"], ["Mandarin", "native"]]);
    expect(needs("Bilingual (English/Japanese)")).toEqual([["English", "native"], ["Japanese", "native"]]);
  });

  it("folds other names into one language and keeps the highest level asked", () => {
    expect(needs("Chinese required. Fluent Putonghua is expected.")).toEqual([["Mandarin", "native"]]);
    expect(needs("Fluent Bahasa Indonesia")).toEqual([["Indonesian", "native"]]);
    expect(needs("Farsi speaking caseworker")).toEqual([["Persian", null]]);
  });

  it("keeps the sentence that asks, cut short when long", () => {
    const [n] = detectLanguageNeeds("About us.\nYou are fluent in German.\nWe value people.");
    expect(n?.quote).toBe("You are fluent in German.");
    const long = `Fluent German is needed ${"because the team is in Berlin ".repeat(10)}.`;
    expect(detectLanguageNeeds(long)[0]!.quote.length).toBeLessThanOrEqual(200);
  });

  it("skips languages the ad calls a plus", () => {
    expect(needs("Japanese is desirable.")).toEqual([]);
    expect(needs("Fluent Mandarin would be an advantage.")).toEqual([]);
    expect(needs("Conversational French is a plus.")).toEqual([]);
    expect(needs("Fluent Japanese preferred.")).toEqual([]);
    expect(needs("German is not required.")).toEqual([]);
  });

  it("skips descriptions of the clients and of applicants' backgrounds", () => {
    expect(needs("You will support our Mandarin-speaking customers.")).toEqual([]);
    expect(needs("We work with German speaking markets.")).toEqual([]);
    expect(needs("People from a non-English speaking background are encouraged to apply.")).toEqual([]);
  });

  it("doesn't read a language name used as an adjective as a requirement", () => {
    expect(needs("You will work with our Chinese business partners.")).toEqual([]);
    expect(needs("Membership of German professional bodies.")).toEqual([]);
    expect(needs("Experience in advanced Chinese manufacturing.")).toEqual([]);
    expect(needs("You will look after professional Japanese clients.")).toEqual([]);
    expect(needs("Excellent French cuisine in the staff canteen.")).toEqual([]);
    // The same words still count when they describe the language.
    expect(needs("Japanese business level")).toEqual([["Japanese", "professional"]]);
    expect(needs("Advanced Japanese and English skills.")).toEqual([["Japanese", "professional"]]);
    expect(needs("Japanese fluent")).toEqual([["Japanese", "native"]]);
  });

  it("ignores lower-case words that look like languages, and text that names no requirement", () => {
    expect(needs("You polish the product and are fluent in polish of UI.")).toEqual([]);
    expect(needs("Our office is near the French restaurant.")).toEqual([]);
    expect(needs("Experience with Java and Python required.")).toEqual([]);
    expect(needs("")).toEqual([]);
  });
});

describe("checkLanguages: the ad against the profile", () => {
  const need = (language: string, level: LanguageNeed["level"]): LanguageNeed => ({ language, level, quote: `${language} wanted.` });

  it("marks a language the person doesn't list as a blocker", () => {
    const r = checkLanguages([need("German", "native")], [{ language: "English", level: "native" }]);
    expect(r).toMatchObject({ verdict: "block", short: "Needs German", text: "Needs German, which isn't in your profile" });
  });

  it("warns when the ad asks a higher level than declared", () => {
    const r = checkLanguages([need("German", "native")], [{ language: "German", level: "conversational" }]);
    expect(r).toMatchObject({ verdict: "warn", short: "Check German level", text: "Asks for fluent German; your profile says Conversational" });
    expect(checkLanguages([need("Japanese", "professional")], [{ language: "Japanese", level: "basic" }])?.text)
      .toBe("Asks for professional Japanese; your profile says Basic");
  });

  it("passes the same or a lower level, or a need with no level", () => {
    expect(checkLanguages([need("German", "professional")], [{ language: "German", level: "native" }])).toBeNull();
    expect(checkLanguages([need("German", null)], [{ language: "German", level: "basic" }])).toBeNull();
    expect(checkLanguages([], [{ language: "German", level: "basic" }])).toBeNull();
  });

  it("matches other names on both sides", () => {
    expect(checkLanguages([need("Mandarin", "native")], [{ language: "chinese", level: "native" }])).toBeNull();
  });

  it("knows nothing with an empty list: no English is assumed", () => {
    const r = checkLanguages([need("English", "native")], []);
    expect(r?.verdict).toBe("unknown");
    expect(r?.text).toMatch(/Add your languages to your profile/);
  });

  it("reports the worst verdict and names every language at it", () => {
    const r = checkLanguages([need("German", null), need("French", null), need("English", "native")], [{ language: "English", level: "basic" }]);
    expect(r?.verdict).toBe("block");
    expect(r?.short).toBe("Needs German and French");
    expect(r?.issues.map((i) => i.verdict)).toEqual(["block", "block", "warn"]);
  });
});

describe("profile languages", () => {
  it("reads the list leniently", () => {
    expect(spokenLanguages([{ language: " chinese ", level: "native" }, { language: "", level: "basic" }, { language: "Thai", level: "expert" }, "x", null]))
      .toEqual([{ language: "Mandarin", level: "native" }]);
    expect(spokenLanguages(undefined)).toEqual([]);
  });

  it("normalises names", () => {
    expect(normaliseLanguage("farsi")).toBe("Persian");
    expect(normaliseLanguage("  auslan ")).toBe("Auslan");
    expect(normaliseLanguage(" ")).toBe("");
  });

  it("gives Claude the rule, and never assumes a language when the list is empty", () => {
    expect(languageRule([{ language: "English", level: "native" }])).toMatch(/My languages: English \(Native or fluent\)\. .*deal-breaker/);
    expect(languageRule([])).toMatch(/don't assume any/);
  });
});
