import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ScreenBoundary } from "../src/components/ScreenBoundary";

function Boom(): never { throw new TypeError("Cannot read properties of undefined (reading 'split')"); }

describe("ScreenBoundary", () => {
  it("shows a plain message with a way out when a screen fails to draw", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<ScreenBoundary resetKey="#/video"><Boom /></ScreenBoundary>);
    expect(screen.getByRole("alert")).toHaveTextContent("This page couldn't be shown");
    expect(screen.getByRole("button", { name: "Go home" })).toBeInTheDocument();
    expect(screen.queryByText(/split/)).toBeNull();
    spy.mockRestore();
  });

  it("clears the error when the route changes", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { rerender } = render(<ScreenBoundary resetKey="#/video"><Boom /></ScreenBoundary>);
    rerender(<ScreenBoundary resetKey="#/home"><p>Home page</p></ScreenBoundary>);
    expect(screen.getByText("Home page")).toBeInTheDocument();
    spy.mockRestore();
  });
});
