import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { PAGE_SETTINGS, PageSettings } from "../src/components/PageSettings";
import { parseHash, toHash } from "../src/router";
import { SearchesScreen } from "../src/screens/Searches";
import { ApplicationsScreen } from "../src/screens/Applications";
import { renderApp } from "./render";

describe("screen settings gear", () => {
  it("every link is a real Settings deep link that survives the router", () => {
    for (const [page, def] of Object.entries(PAGE_SETTINGS)) {
      expect(def.links.length, page).toBeGreaterThan(0);
      for (const l of def.links) expect(parseHash(toHash(l.to)), `${page}: ${l.label}`).toEqual(l.to);
    }
  });

  it("a single destination opens straight away, with a name and a tooltip", async () => {
    renderApp(<PageSettings page="applications" />);
    const gear = screen.getByRole("button", { name: "Email settings" });
    expect(gear).toHaveAttribute("title", "Email settings: Email & signature");
    await userEvent.click(gear);
    expect(window.location.hash).toBe("#/settings?tab=connections&c=email");
  });

  it("several destinations open a short menu; Escape closes it and returns focus", async () => {
    renderApp(<PageSettings page="learn" />);
    const gear = screen.getByRole("button", { name: "Voice and video settings" });
    await userEvent.click(gear);
    expect(gear).toHaveAttribute("aria-expanded", "true");
    const menu = screen.getByRole("group", { name: "Voice and video settings" });
    expect(within(menu).getAllByRole("button").map((b) => b.textContent)).toEqual(["Reading voice", "Videos"]);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("group", { name: "Voice and video settings" })).toBeNull();
    expect(gear).toHaveFocus();
    await userEvent.click(gear);
    await userEvent.click(screen.getByRole("button", { name: "Videos" }));
    expect(window.location.hash).toBe("#/settings?tab=video");
  });

  it("Searches has Find jobs and the gear in its header; Applications its gear", async () => {
    renderApp(<SearchesScreen />);
    const head = (await screen.findByRole("heading", { name: "Searches" })).closest("header")!;
    expect(within(head).getByRole("button", { name: "Search settings" })).toBeInTheDocument();
    expect(await within(head).findByRole("button", { name: "Find jobs" })).toBeInTheDocument();
  });

  it("Applications has its gear", async () => {
    renderApp(<ApplicationsScreen />);
    const head = (await screen.findByRole("heading", { name: "Applications" })).closest("header")!;
    expect(within(head).getByRole("button", { name: "Email settings" })).toBeInTheDocument();
  });
});
