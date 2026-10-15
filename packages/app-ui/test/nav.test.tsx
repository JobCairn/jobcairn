import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { BackLink, NavMemory, fallbackFor, isBackKey, originFor, resetTrail, visit } from "../src/nav";
import { nameCurrent, trailSnapshot } from "../src/nav/trail";
import { parseHash, toHash, type Route } from "../src/router";

const JOB: Route = { screen: "job", slug: "acme-corp", id: "2026-01-12-ai-engineer" };
const VIDEO: Route = { screen: "video", folder: "companies/acme-corp/jobs/2026-01-12-ai-engineer/videos/jd-walkthrough-1" };
const go = (r: Route | string) => visit(typeof r === "string" ? r : toHash(r));

beforeEach(() => resetTrail());

describe("trail", () => {
  it("goes back to the page you came from, with its filters", () => {
    go("#/jobs?status=Saved");
    go(JOB);
    expect(originFor(JOB)).toEqual({ hash: "#/jobs?status=Saved", label: "Jobs", fromTrail: true });
  });

  it("skips tab changes: back from a job's Score tab is still the list", () => {
    go({ screen: "jobs" });
    go(JOB);
    go({ ...JOB, tab: "score" });
    go({ ...JOB, tab: "interview" });
    expect(originFor({ ...JOB, tab: "interview" })?.hash).toBe("#/jobs");
    expect(trailSnapshot()).toHaveLength(2);
  });

  it("names the page by its title: a video opened from a job goes back to that job", () => {
    go({ screen: "jobs" });
    go(JOB);
    nameCurrent(toHash(JOB), "Senior AI Engineer");
    go(VIDEO);
    expect(originFor(VIDEO)).toMatchObject({ hash: toHash(JOB), label: "Senior AI Engineer" });
  });

  it("opened from Videos goes back to Videos", () => {
    go({ screen: "videos" });
    go(VIDEO);
    expect(originFor(VIDEO)?.label).toBe("Videos");
  });

  it("never loops: Job → Apply → Job is just Job, and its scroll comes back", () => {
    go({ screen: "jobs" });
    go(JOB);
    go({ screen: "apply", slug: "acme-corp", id: "2026-01-12-ai-engineer" });
    expect(go(JOB)).toEqual({ samePage: false });
    expect(trailSnapshot().map((e) => e.hash)).toEqual(["#/jobs", toHash(JOB)]);
    expect(originFor(JOB)?.hash).toBe("#/jobs");
  });

  it("falls back to the screen's parent when the app opened straight on it", () => {
    expect(fallbackFor(JOB)).toEqual({ screen: "jobs" });
    expect(fallbackFor(VIDEO)).toEqual({ ...JOB, tab: "interview" });
    expect(fallbackFor({ screen: "video", folder: "learning/rag/videos/1" })).toEqual({ screen: "videos" });
    expect(fallbackFor({ screen: "resume", slug: "acme-corp", id: "x", file: "resume.md" })).toEqual({ screen: "apply", slug: "acme-corp", id: "x" });
    expect(fallbackFor({ screen: "jobs" })).toBeNull();
    expect(originFor(JOB)).toEqual({ hash: "#/jobs", label: "Jobs", fromTrail: false });
  });

  it("knows the Back keys", () => {
    const k = (key: string, m: Partial<KeyboardEvent> = {}) => isBackKey({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...m });
    expect(k("[", { metaKey: true })).toBe(true);
    expect(k("[", { ctrlKey: true })).toBe(true);
    expect(k("ArrowLeft", { altKey: true })).toBe(true);
    expect(k("[")).toBe(false);
    expect(k("ArrowLeft")).toBe(false);
    expect(k("[", { metaKey: true, shiftKey: true })).toBe(false);
  });
});

describe("BackLink and NavMemory", () => {
  function Harness() {
    const route = parseHash(window.location.hash);
    return <div id="main"><NavMemory route={route} generation={0} /><BackLink route={route} /><input aria-label="Notes" /></div>;
  }

  it("shows ‹ origin above a detail screen and goes there; the Back keys do too, except while typing", async () => {
    window.location.hash = "#/videos";
    const { rerender } = render(<Harness />);
    expect(screen.queryByRole("navigation", { name: "Back" })).toBeNull();
    await act(async () => { window.location.hash = toHash(VIDEO); });
    rerender(<Harness />);
    const link = screen.getByRole("link", { name: "Back to Videos" });
    expect(link).toHaveAttribute("href", "#/videos");

    fireEvent.keyDown(screen.getByRole("textbox", { name: "Notes" }), { key: "ArrowLeft", altKey: true });
    expect(window.location.hash).toBe(toHash(VIDEO));
    fireEvent.keyDown(window, { key: "[", metaKey: true });
    expect(window.location.hash).toBe("#/videos");
  });

  it("cuts a long name and keeps it whole in the tooltip", async () => {
    window.location.hash = toHash(JOB);
    render(<Harness />);
    act(() => nameCurrent(toHash(JOB), "Principal Machine Learning Platform Engineer, Agents"));
    await act(async () => { window.location.hash = toHash(VIDEO); });
    render(<Harness />);
    const link = screen.getAllByRole("link", { name: "Back to Principal Machine Learning Platform Engineer, Agents" }).at(-1)!;
    expect(link.textContent!.length).toBeLessThanOrEqual(32);
    expect(link).toHaveAttribute("title", "Back to Principal Machine Learning Platform Engineer, Agents");
  });
});
