import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { checkLanguages } from "@careeros/contract";
import { blankRow } from "../src/components/ListField";
import { LanguageCell } from "../src/jobs/cells/cells";
import { MockBridge, loadFixture } from "../src/mock/MockBridge";
import { JobScreen } from "../src/screens/Job";
import { JobsScreen } from "../src/screens/Jobs";
import { renderApp } from "./render";

vi.setConfig({ testTimeout: 15_000 });

const ACME = { screen: "job", slug: "acme-corp", id: "2026-01-12-ai-engineer" } as const;

/** The sample with Acme's AI Engineer ad asking for fluent German, and the given languages in the profile. */
function bridgeWith(languages: { language: string; level: string }[]) {
  const f = loadFixture();
  const j = f.jobs.find((x) => x.job.company_slug === ACME.slug && x.job.id === ACME.id)!;
  j.description = `${j.description}\n\nFluent German required.`;
  (f.profile as Record<string, unknown>).languages = languages;
  return new MockBridge({ fixture: f });
}

describe("the profile's Languages list", () => {
  it("starts a new row at Professional, the schema's default", () => {
    const f = loadFixture();
    const langs = f.fields.profile.find((x) => x.path === "languages")!;
    expect(blankRow(langs)).toEqual({ language: "", level: "professional" });
  });
});

describe("language cell", () => {
  it("shows a blocker and a warning with the full sentence for screen readers, and nothing when fine", () => {
    const block = checkLanguages([{ language: "German", level: null, quote: "" }], [{ language: "English", level: "native" }])!;
    const { container, rerender } = render(<LanguageCell check={block} />);
    expect(container.textContent).toContain("Needs German");
    expect(screen.getByText("Needs German, which isn't in your profile")).toHaveClass("sr-only");
    const warn = checkLanguages([{ language: "German", level: "native", quote: "" }], [{ language: "German", level: "basic" }])!;
    rerender(<LanguageCell check={warn} />);
    expect(container.querySelector(".cell-tone--warning")).not.toBeNull();
    rerender(<LanguageCell check={undefined} />);
    expect(container.textContent).toBe("");
  });
});

describe("languages on the job and in Jobs", () => {
  it("marks the job page and the Jobs row when the ad needs a language the profile doesn't list", async () => {
    const bridge = bridgeWith([{ language: "English", level: "native" }]);
    renderApp(<JobScreen route={ACME} />, { bridge });
    expect(await screen.findByTitle(/^Needs German, which isn't in your profile\. The ad says: "Fluent German required\."$/)).toHaveTextContent("Needs German");
  });

  it("shows the Language column in Jobs", async () => {
    renderApp(<JobsScreen route={{ screen: "jobs" }} />, { bridge: bridgeWith([{ language: "English", level: "native" }]) });
    const table = await screen.findByRole("table");
    expect(await within(table).findByRole("columnheader", { name: /Language/ })).toBeInTheDocument();
    expect(within(table).getByText("Needs German, which isn't in your profile")).toBeInTheDocument();
  });

  it("asks for languages on the job page when the profile lists none", async () => {
    renderApp(<JobScreen route={ACME} />, { bridge: bridgeWith([]) });
    expect(await screen.findByRole("link", { name: "Add your languages to your profile" })).toHaveAttribute("href", expect.stringContaining("languages"));
  });
});
