import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { controlOf } from "../../../tests/fast-labels";

// tests/dom-setup.ts swaps jsdom's slow `labels` / `control` for a fast version. These pin the spec's behaviour.
describe("fast labels (test setup)", () => {
  it("matches the HTML spec for for=, nesting, hidden inputs and non-labelable targets", () => {
    render(
      <div>
        <label htmlFor="a">Alpha</label><input id="a" />
        <label>Beta <select><option>x</option></select></label>
        <label htmlFor="d">Delta</label><div id="d" />
        <label htmlFor="h">Hidden</label><input id="h" type="hidden" />
        <label htmlFor="">Empty</label>
        <label htmlFor="a">Alpha again</label>
      </div>,
    );
    const a = screen.getByLabelText("Alpha");
    expect(a.id).toBe("a");
    expect([...(a as HTMLInputElement).labels!].map((l) => l.textContent)).toEqual(["Alpha", "Alpha again"]);
    expect(screen.getByLabelText("Beta").tagName).toBe("SELECT");
    const labels = [...document.querySelectorAll("label")];
    expect(labels.map((l) => controlOf(l)?.tagName ?? null)).toEqual(["INPUT", "SELECT", null, null, null, "INPUT"]);
    expect(labels.map((l) => l.control?.tagName ?? null)).toEqual(["INPUT", "SELECT", null, null, null, "INPUT"]);
    expect((document.getElementById("h") as HTMLInputElement).labels).toBeNull();
    expect(screen.getByRole("textbox", { name: "Alpha Alpha again" })).toBe(a);
  });
  it("finds the control in a tree that isn't in the document yet", () => {
    const box = document.createElement("div");
    box.innerHTML = '<label for="z">Z</label><input id="z">';
    const label = box.querySelector("label")!;
    expect(controlOf(label)).toBe(box.querySelector("input"));
    expect([...box.querySelector("input")!.labels!]).toEqual([label]);
  });
  it("uses the first element with a duplicated id, in tree order", () => {
    render(<div><label htmlFor="x">X</label><input id="x" data-n="1" /><input id="x" data-n="2" /></div>);
    expect(screen.getByLabelText("X").getAttribute("data-n")).toBe("1");
  });
});
