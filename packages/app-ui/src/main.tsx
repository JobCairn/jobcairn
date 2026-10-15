import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { PRODUCT_NAME } from "@careeros/brand";
import "@careeros/brand/styles.css";
import "./styles/app.css";
import { createRemoteBridge, type CareerosBridge, type Transport } from "@careeros/contract";
import { trackInputModality } from "@careeros/brand";
import { App } from "./App";

declare global {
  interface Window { careerosTransport?: Transport }
}

async function pickBridge(): Promise<CareerosBridge> {
  // In the desktop app the preload exposes the transport; in `npm run dev` we use the fictional mock.
  if (window.careerosTransport) return createRemoteBridge(window.careerosTransport);
  // `?onboarding` previews first-run setup with no workspace open. `?data=full|small|empty` picks the
  // Home preview data (default full). `?stress` adds the long stress job, starting at Apply's Review step
  // so the preview shows application files. `?learn` adds fictional learning data (skills in the ads, a
  // scored job, guides with progress) so Learn and Getting started have something to show.
  const params = new URLSearchParams(window.location.search);
  const [{ createMockBridge }, { scenarioOptions }, { dropboxDemo }] = await Promise.all([import("./mock/MockBridge"), import("./mock/scenarios"), import("./mock/dropbox-demo")]);
  // `?claude=missing|signed_out|no_consent` previews the Claude engine before it's set up.
  const claude = params.get("claude");
  const claudeEngine = claude === "missing" ? { cli: "missing" as const } : claude === "signed_out" ? { login: "signed_out" as const } : claude === "no_consent" ? { consent: false } : undefined;
  const opts = { ...scenarioOptions(window.location.search), workspaceOpen: !params.has("onboarding"), learnDemo: params.has("learn"), ...(claudeEngine ? { claudeEngine } : {}),
    // `?oldbridge` previews onboarding on a bridge without the planned folder calls (the folder picker fallback).
    ...(params.has("oldbridge") ? { folderApi: false } : {}),
    // `?dropbox` fills the drop box with fictional files of each kind (job ad, resume, an unsure file for Ask Claude).
    ...(params.has("dropbox") ? dropboxDemo() : {}),
    // `?maildemo` adds fictional mail and real (sanitized, fictional) email bodies in the Mail reader.
    ...(params.has("maildemo") ? { mailDemo: true } : {}),
    // `?resume` makes "Choose a file" return a fictional resume (for previewing "Fill from my resume").
    ...(params.has("resume") ? { pickFile: "/fictional/alex-example/Downloads/Alex Example resume.pdf" } : {}),
    // ?workspaces: other workspaces on this computer (two that read the same, an empty one and a missing folder).
    ...(params.has("workspaces") ? { otherWorkspaces: [
      { name: "Sam Sample", folder: PRODUCT_NAME, parent: "personal-workspace", companies: 52, created: "2026-10-10" },
      { name: "Sam Sample", folder: PRODUCT_NAME, parent: "old-laptop", companies: 1, created: "2026-03-02" },
      { name: "Jordan Demo", folder: `${PRODUCT_NAME} Jordan`, companies: 0, empty: true, created: "2026-10-09" },
      { name: "Riley Test", folder: `${PRODUCT_NAME} Riley`, available: false },
    ] } : {}) };
  // `?video` adds one JD walkthrough waiting for script review (`?video=preview`: already a draft) for the video screen.
  if (params.has("video")) {
    const mock = createMockBridge({ ...opts, workspaceOpen: true });
    const v = await mock.video.start("jd-walkthrough", { kind: "job", company_slug: "acme-corp", id: "2026-01-12-ai-engineer" }, {});
    if (params.get("video") === "preview") await mock.video.approveScript(v.folder);
    // `?video=broken`: a script that failed its format check.
    if (params.get("video") === "broken") mock.simulateBrokenScript(v.folder);
    // `?video=stopped`: making the video stopped at the video check. `?video=writing|building`: a run in progress.
    if (params.get("video") === "stopped") mock.simulateStoppedVideo(v.folder);
    if (params.get("video") === "writing" || params.get("video") === "building") mock.simulateVideoRun(v.folder, params.get("video") as "writing" | "building");
    if (params.get("video") === "writing") {
      mock.claudeSim.runs.unshift({
        id: "r-demo-1", action: "video_script", title: "Video script", target: { kind: "workspace" }, key: `video_script--${v.folder}`, status: "running",
        started_at: "2026-10-10T05:00:00.000Z", ended_at: "", elapsed_ms: 64_000, summary: "", files: [], missing: [], stray: [], error: "", cost_usd: null, turns: null,
        steps: [{ label: "Reading the job ad", state: "done", at: "" }, { label: "Picking the three points that matter", state: "done", at: "" }, { label: "Writing scene 3 of 5", state: "active", at: "" }],
      });
    }
    return mock;
  }
  // `?jobvideos` gives Acme Corp's AI Engineer job one video in each state (done, making, script only, failed, stopped, older script).
  if (params.has("jobvideos")) {
    const mock = createMockBridge({ ...opts, workspaceOpen: true });
    const job = { kind: "job" as const, company_slug: "acme-corp", id: "2026-01-12-ai-engineer" };
    const make = async () => (await mock.video.start("jd-walkthrough", job, {})).folder;
    const done = await make();
    await mock.video.render(done, "final");
    mock.simulateVideoItem(done, { length_s: 148, making_ms: 513_000, created_at: "2026-10-10T17:50:30.000Z", updated_at: "2026-10-10T17:59:05.000Z" });
    const building = await make();
    mock.simulateVideoRun(building, "building");
    mock.simulateVideoItem(building, { created_at: "2026-10-11T03:10:00.000Z", updated_at: "2026-10-11T03:12:00.000Z" });
    const script = await make();
    mock.simulateVideoItem(script, { created_at: "2026-10-09T08:00:00.000Z", updated_at: "2026-10-09T08:03:00.000Z" });
    const failed = await make();
    mock.simulateStoppedVideo(failed);
    mock.simulateVideoItem(failed, { created_at: "2026-10-08T08:00:00.000Z", updated_at: "2026-10-08T08:09:00.000Z" });
    const stale = await make();
    mock.simulateVideoItem(stale, { status: "rendering", created_at: "2026-10-07T08:00:00.000Z", updated_at: "2026-10-07T08:05:00.000Z" });
    mock.simulateLegacyVideo("companies/acme-corp/jobs/2026-01-12-ai-engineer/videos/jd-walkthrough-9", "jd-walkthrough", job, "2026-10-01T09:26:00.000Z");
    return mock;
  }
  // `?score` shows a structured score card, an older write-up and an unscored job (score/demo.ts).
  if (params.has("score")) return createMockBridge({ ...opts, fixture: (await import("./score/demo")).withScoreDemo(opts.fixture!) });
  // `?chrome` adds a fictional Search in my Chrome at its sign-in step (mock/chrome-mock.ts); `?chrome=on`: set up and on.
  if (params.has("chrome")) {
    const mock = createMockBridge(opts);
    (mock as unknown as { chrome: unknown }).chrome = (await import("./mock/chrome-mock")).chromeMock(() => mock.claude.runs(), { on: params.get("chrome") === "on" });
    return mock;
  }
  if (!params.has("stress")) return createMockBridge(opts);
  const { withStressJob, STRESS_ID, STRESS_SLUG } = await import("./mock/stress-job");
  const mock = createMockBridge({ ...opts, fixture: withStressJob(opts.fixture!) });
  mock.simulateClaudeOutput(STRESS_SLUG, STRESS_ID, false);
  return mock;
}

trackInputModality();

void pickBridge().then((bridge) => {
  createRoot(document.getElementById("root")!).render(<StrictMode><App bridge={bridge} /></StrictMode>);
});
