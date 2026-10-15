import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Text } from "../src/components/Text";

describe("Text", () => {
  it("maps roles to classes and default tags", () => {
    render(<><Text role="display">Good morning, Alex.</Text><Text role="label">Applied</Text><Text role="numeric">72</Text></>);
    expect(screen.getByText("Good morning, Alex.").tagName).toBe("H1");
    expect(screen.getByText("Good morning, Alex.")).toHaveClass("t-display");
    expect(screen.getByText("Applied")).toHaveClass("t-label");
    expect(screen.getByText("72")).toHaveClass("t-numeric");
  });
  it("truncates long titles with an ellipsis, with a tooltip only when actually cut off", async () => {
    const long = "Backend Engineer (LLM) at Example Labs, a very long company name that truncates";
    render(<><Text truncate>{long}</Text><Text truncate>Short</Text></>);
    const el = screen.getByText(long);
    expect(el).toHaveClass("truncate");
    Object.defineProperty(el, "scrollWidth", { configurable: true, value: 500 });
    Object.defineProperty(el, "clientWidth", { configurable: true, value: 100 });
    fireEvent.mouseEnter(el);
    expect(el).toHaveAttribute("title", long);
    const short = screen.getByText("Short");
    fireEvent.mouseEnter(short);
    expect(short).not.toHaveAttribute("title");
  });
});
