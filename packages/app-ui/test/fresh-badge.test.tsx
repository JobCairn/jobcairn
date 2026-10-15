import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FreshBadge } from "../src/jobs/FreshBadge";
import { formFromParams, paramsFromForm } from "../src/jobs/filters";

const NOW = new Date("2026-10-15T09:00:00.000Z");

describe("FreshBadge", () => {
  it("says New · apply today for an ad posted in the last 48 hours", () => {
    render(<FreshBadge row={{ posted: "2026-10-14" }} now={NOW} />);
    expect(screen.getByText("New · apply today")).toHaveAttribute("title", expect.stringContaining("48 hours"));
  });
  it("shows nothing for an older ad or one with no posted date", () => {
    const { container } = render(<><FreshBadge row={{ posted: "2026-10-01" }} now={NOW} /><FreshBadge row={{ posted: "" }} now={NOW} /></>);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("Fresh first sort", () => {
  it("round-trips through the Jobs list address", () => {
    const form = formFromParams(new URLSearchParams("sort=fresh"));
    expect(form.sort).toBe("fresh");
    expect(paramsFromForm(form).get("sort")).toBe("fresh");
  });
});
