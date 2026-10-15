import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Avatar, Badge, Button, Card, Checkbox, Icon, Input, KpiCard, Kbd, NavItem, Pill, Select, sparkPoints, Icons } from "../src";

describe("brand primitives", () => {
  it("Button: variants, sizes, loading and disabled", async () => {
    const onClick = vi.fn();
    const { rerender } = render(<Button variant="primary" onClick={onClick}>Prepare</Button>);
    const b = screen.getByRole("button", { name: "Prepare" });
    expect(b).toHaveClass("btn", "btn--primary");
    expect(b).toHaveAttribute("type", "button");
    await userEvent.click(b);
    expect(onClick).toHaveBeenCalledTimes(1);
    rerender(<Button variant="danger" size="sm" loading onClick={onClick}>Decline</Button>);
    const d = screen.getByRole("button", { name: "Decline" });
    expect(d).toHaveClass("btn--danger", "btn--sm");
    expect(d).toBeDisabled();
    expect(d).toHaveAttribute("aria-busy", "true");
    await userEvent.click(d);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
  it("Icon: decorative by default, labelled when asked, stroke 1.75", () => {
    const { container } = render(<><Icon icon={Icons.jobs} /><Icon icon={Icons.jobs} label="Jobs" /></>);
    const [deco, named] = container.querySelectorAll("svg");
    expect(deco).toHaveAttribute("aria-hidden", "true");
    expect(deco).toHaveAttribute("stroke-width", "1.75");
    expect(named).toHaveAttribute("aria-label", "Jobs");
    expect(named).toHaveClass("icon", "icon--md");
  });
  it("Pill and Badge carry tone and text", () => {
    render(<><Pill tone="success">Sponsorship offered</Pill><Badge>51</Badge><Kbd>⌘K</Kbd></>);
    expect(screen.getByText("Sponsorship offered")).toHaveClass("pill", "pill--success");
    expect(screen.getByText("Sponsorship offered")).toHaveAttribute("title", "Sponsorship offered");
    expect(screen.getByText("51")).toHaveClass("badge");
    expect(screen.getByText("⌘K").tagName).toBe("KBD");
  });
  it("KpiCard: tabular numbers with an aligned sparkline", () => {
    render(<KpiCard label="Applied" value={4} delta="+2 this week" trend={[0, 0, 1, 2, 4]} tone="accent" />);
    expect(screen.getByText("4")).toHaveClass("kpi__value", "kpi__value--accent");
    expect(screen.getByText("4").parentElement).toHaveClass("kpi__row");
    expect(screen.getByRole("img", { name: "Applied trend: 0, 0, 1, 2, 4" })).toHaveClass("kpi__spark");
    expect(screen.getByText("+2 this week")).toHaveClass("kpi__delta");
  });
  it("sparkPoints spreads values across the box", () => {
    expect(sparkPoints([0, 10], 64, 24, 2)).toBe("0,22 64,2");
    expect(sparkPoints([5, 5, 5], 64, 24, 2)).toBe("0,22 32,22 64,22");
    expect(sparkPoints([])).toBe("");
  });
  it("NavItem: current page, count badge and truncated label", async () => {
    const onClick = vi.fn();
    render(<NavItem icon={Icons.jobs} label="Jobs" count={51} current onClick={onClick} />);
    const item = screen.getByRole("button", { name: /Jobs/ });
    expect(item).toHaveAttribute("aria-current", "page");
    expect(item.querySelector(".nav-item__icon")).not.toBeNull();
    expect(screen.getByText("51")).toHaveClass("badge");
    // No native tooltip (it lingered on the wrong item); the collapsed rail shows data-tip beside the item.
    expect(screen.getByText("Jobs")).not.toHaveAttribute("title");
    expect(item).toHaveAttribute("data-tip", "Jobs");
    await userEvent.click(item);
    expect(onClick).toHaveBeenCalled();
  });
  it("form fields are labelled and announce errors", async () => {
    const onChange = vi.fn();
    render(<>
      <Input label="Full name" defaultValue="Alex Example" />
      <Input label="Visa expiry" error="Use YYYY-MM-DD" defaultValue="soon" />
      <Select label="Work rights" options={[{ value: "citizen", label: "Citizen" }, { value: "needs_sponsorship", label: "Need visa sponsorship" }]} value="citizen" onChange={onChange} />
      <Checkbox label="Willing to relocate" />
    </>);
    expect(screen.getByLabelText("Full name")).toHaveValue("Alex Example");
    const bad = screen.getByLabelText("Visa expiry");
    expect(bad).toHaveAttribute("aria-invalid", "true");
    expect(bad).toHaveAccessibleDescription("Use YYYY-MM-DD");
    await userEvent.selectOptions(screen.getByLabelText("Work rights"), "needs_sponsorship");
    expect(onChange).toHaveBeenCalled();
    await userEvent.click(screen.getByLabelText("Willing to relocate"));
    expect(screen.getByLabelText("Willing to relocate")).toBeChecked();
  });
  it("Card renders a section, highlighted when asked", () => {
    render(<Card highlight aria-label="Waiting for you">x</Card>);
    expect(screen.getByLabelText("Waiting for you")).toHaveClass("card", "card--highlight");
  });
  it("Avatar: initials from up to two words, sized from tokens, decorative or labelled", () => {
    const { container, rerender } = render(<Avatar name="Acme Corp" />);
    expect(screen.getByText("AC")).toHaveClass("avatar");
    const deco = container.querySelector(".avatar");
    expect(deco).toHaveAttribute("aria-hidden", "true");
    rerender(<Avatar name="Example Labs" size="sm" label="Example Labs" />);
    expect(screen.getByText("EL")).toHaveClass("avatar", "avatar--sm");
    expect(screen.getByLabelText("Example Labs")).toBeInTheDocument();
    rerender(<Avatar name="Acme" />);
    expect(screen.getByText("A")).toBeInTheDocument();
  });
});

describe("input modality", () => {
  it("marks pointer and keyboard use on <html>, ignoring shortcuts, and stops when asked", async () => {
    const { trackInputModality } = await import("../src/modality");
    const stop = trackInputModality(document);
    document.dispatchEvent(new Event("pointerdown"));
    expect(document.documentElement.dataset.modality).toBe("pointer");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }));
    expect(document.documentElement.dataset.modality).toBe("pointer");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
    expect(document.documentElement.dataset.modality).toBe("keyboard");
    stop();
    document.dispatchEvent(new Event("pointerdown"));
    expect(document.documentElement.dataset.modality).toBe("keyboard");
  });
});
