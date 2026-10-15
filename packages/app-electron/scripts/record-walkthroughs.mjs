// Records the website's product walkthrough clips from the example workspace (Alex Example, all made up).
//
// It opens the app in an isolated Electron instance (temporary user data and home folder, never your own
// workspace), clicks "Try example", then plays each clip: the app's own narration voice reads the script,
// the screen is captured frame by frame while a scripted cursor moves through the app, and captions are shown
// on screen in time with the voice. ffmpeg joins the frames and the voice into an MP4 with a poster and a
// WebVTT caption file. Finished clips go to docs/assets/marketing/.
//
//   node packages/app-electron/scripts/build.mjs
//   node packages/app-electron/scripts/record-walkthroughs.mjs [clip-name ...]
//
// Needs the Supertonic voice from Settings > Voice (~/.careeros/venv) and ffmpeg on the PATH.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "@playwright/test";

const PKG = path.resolve(import.meta.dirname, "..");
const REPO = path.resolve(PKG, "../..");
const OUT = process.env.CAREEROS_WALKTHROUGH_OUT ?? path.join(REPO, "docs", "assets", "marketing");
const SAMPLE = path.join(REPO, "samples", "alex-example");
const PYTHON = process.env.CAREEROS_PYTHON ?? path.join(os.homedir(), ".careeros", "venv", "bin", "python");
const NARRATE = path.join(REPO, "plugin", "skills", "voice", "scripts", "narrate.py");
const W = 1280, H = 720;
const ONLY = process.argv.slice(2);

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${path.basename(cmd)} failed: ${(r.stderr || r.stdout).trim().split("\n").slice(-3).join(" ")}`);
  return r.stdout;
};

// ---- the clips ------------------------------------------------------------------------------------------
// Each beat is one paragraph of narration and what happens on screen while it is read.

const CLIPS = [
  {
    name: "find-and-score-jobs", title: "Find and score jobs", theme: "graphite",
    beats: [
      { say: "This is JobCairn, a job search workspace on your own computer. Meet Alex, an example job seeker who needs visa sponsorship.", act: async (s) => { await s.card(); await s.go("Home"); await s.hover(s.page.getByRole("region", { name: "Today" })); } },
      { say: "Home shows the day at a glance: what is ready, what is next, and how the search is going.", act: async (s) => { await s.hover(s.page.getByRole("button", { name: "1 role with sponsorship" })); await s.scroll(320); } },
      { say: "Jobs lists every role Claude found or Alex added. Ads that offer sponsorship are pinned to the top.", act: async (s) => { await s.go("Jobs"); await s.hover(s.row("Applied AI Engineer Contoso AI")); } },
      { say: "Each job gets a fit score and a sponsor score, so the best bets stand out.", act: async (s) => { await s.hover(s.page.getByRole("columnheader", { name: "Fit" })); await sleep(900); await s.hover(s.page.getByRole("columnheader", { name: "Sponsor" })); } },
      { say: "Open a job to read the whole ad. The sponsorship line is quoted straight from it.", act: async (s) => { await s.click(s.row("AI Engineer Acme Corp")); await sleep(1400); await s.scroll(420); } },
      { say: "The score checks each must-have against Alex's own history, with the evidence for each one.", act: async (s) => { await s.click(s.tab("Score")); await sleep(1200); await s.scroll(300); } },
      { say: "And the gaps turn into a plan: a study guide, or a short lesson video.", act: async (s) => { await s.click(s.tab("Gaps")); await sleep(900); await s.hover(s.page.getByRole("button", { name: /Study/ }).first()); } },
      { say: "JobCairn. Find the jobs worth your time.", act: async (s) => { await s.end(); } },
    ],
  },
  {
    name: "tailor-and-apply", title: "Tailor and apply", theme: "graphite",
    beats: [
      { say: "When a job is worth it, JobCairn helps Alex apply well.", act: async (s) => { await s.card(); await s.open(s.jobHash("acme-corp", "files")); await s.hover(s.page.getByText("Tailored resume", { exact: true })); } },
      { say: "Claude tailors the resume and cover letter to the ad. Every line traces back to Alex's real history.", act: async (s) => { await s.click(s.page.getByRole("button", { name: "Edit resume" })); await sleep(1500); await s.hover(s.page.getByText("Live preview of the PDF layout.").first()); } },
      { say: "Alex can edit it here with a live preview, then download a PDF or a Word file.", act: async (s) => { await s.hover(s.tab("Download")); } },
      { say: "Nothing is sent without Alex's OK. Emails and applications wait in Approvals.", act: async (s) => { await s.go("Approvals"); await sleep(800); await s.scroll(380); } },
      { say: "Mail files every reply under its job. Interview invites, offers and rejections.", act: async (s) => { await s.go("Mail"); await sleep(800); await s.click(s.page.getByText("Your offer: Applied AI Engineer").first()); await sleep(1200); await s.scroll(200); } },
      { say: "And each job keeps a timeline, so Alex always knows where every application stands.", act: async (s) => { await s.open(s.jobHash("contoso-ai", "timeline")); await sleep(600); await s.hover(s.page.getByText("Status: Offer").first()); } },
      { say: "JobCairn. Apply with care, not in bulk.", act: async (s) => { await s.end(); } },
    ],
  },
  {
    name: "learn-and-prepare", title: "Learn and prepare", theme: "graphite",
    beats: [
      { say: "JobCairn also helps Alex get ready for the interview.", act: async (s) => { await s.card(); await s.go("Learn"); } },
      { say: "Learn turns the gaps across saved jobs into short study guides, with diagrams, tables and interview tips.", act: async (s) => { await s.click(s.page.getByText("Evaluating LLM apps").first()); await sleep(1200); await s.scroll(520); } },
      { say: "Each interview gets practice questions written for that job.", act: async (s) => { await s.open(s.jobHash("brightwater-analytics", "interview")); await sleep(500); await s.hover(s.page.getByText("Interview questions ready").first()); } },
      { say: "Claude can also make short videos. A walkthrough of the ad, a lesson, or a practice pitch.", act: async (s) => { await s.go("Videos"); await sleep(600); await s.hover(s.page.getByText("Acme Corp: what the role asks").first()); } },
      { say: "They are made on this computer, with a natural voice, captions and scenes drawn from Alex's own files.", act: async (s) => { await s.click(s.page.getByText("Acme Corp: what the role asks").first()); await sleep(900); await s.play(); } },
      { say: "JobCairn. Walk in prepared.", act: async (s) => { await s.end(); } },
    ],
  },
];

// ---- narration --------------------------------------------------------------------------------------

/** Reads the beats with the app's narration script and voice: one WAV, and when each paragraph and word is said. */
function narrate(clip, dir) {
  const text = path.join(dir, "script.txt");
  fs.writeFileSync(text, clip.beats.map((b) => b.say).join("\n\n") + "\n");
  run(PYTHON, ["-I", NARRATE, "--workspace", SAMPLE, "--type", "slides", "--text-file", text, "--out", path.join(dir, "voice.wav"),
    "--timing", path.join(dir, "timing.json"), "--no-download", "--voice", "F4", "--lead", "1.6", "--gap", "1.0", "--tail", "1.6"]);
  return JSON.parse(fs.readFileSync(path.join(dir, "timing.json"), "utf8"));
}

/** Caption lines of up to 8 words, broken after a sentence ends. */
function captionGroups(words) {
  const groups = [];
  let cur = [];
  for (const w of words) {
    cur.push(w);
    if (cur.length >= 8 || /[.!?:]$/.test(w.text)) { groups.push(cur); cur = []; }
  }
  if (cur.length) groups.push(cur);
  return groups.map((g) => ({ text: g.map((w) => w.text).join(" "), start: g[0].start, end: g.at(-1).end }));
}

const stamp = (t) => {
  const ms = Math.round(t * 1000);
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${p(Math.floor(ms / 3_600_000))}:${p(Math.floor(ms / 60_000) % 60)}:${p(Math.floor(ms / 1000) % 60)}.${p(ms % 1000, 3)}`;
};
const toVtt = (groups) => `WEBVTT\n\n${groups.map((g, i) => `${i + 1}\n${stamp(g.start)} --> ${stamp(g.end + 0.25)}\n${g.text}\n`).join("\n")}`;

// ---- on-screen extras: cursor, captions, title and end cards ------------------------------------------

const OVERLAY = String.raw`(() => {
  if (window.__wt) return;
  // The app's content security policy blocks <style> tags, so the styles go in a constructed sheet.
  const css = new CSSStyleSheet();
  css.replaceSync(${"`"}
    .learn-claude, .video-locked { display: none !important; }
    #wt-cursor { position: fixed; left: 0; top: 0; width: 22px; height: 22px; z-index: 2147483647; pointer-events: none;
      transform: translate(-100px, -100px); transition: transform 0s; filter: drop-shadow(0 2px 3px rgba(0,0,0,.45)); }
    #wt-ring { position: fixed; width: 34px; height: 34px; margin: -17px 0 0 -17px; border-radius: 50%; z-index: 2147483646;
      pointer-events: none; border: 2px solid rgba(255,190,120,.95); opacity: 0; }
    #wt-ring.go { animation: wt-ring .45s ease-out; }
    @keyframes wt-ring { from { opacity: 1; transform: scale(.4); } to { opacity: 0; transform: scale(1.5); } }
    #wt-cap { position: fixed; left: 50%; bottom: 34px; transform: translateX(-50%); max-width: 880px; z-index: 2147483645;
      pointer-events: none; padding: 10px 20px; border-radius: 12px; background: rgba(12,12,14,.82); color: #fff;
      font: 500 22px/1.35 system-ui, -apple-system, sans-serif; text-align: center; opacity: 0; transition: opacity .15s; }
    #wt-cap.on { opacity: 1; }
    #wt-card { position: fixed; inset: 0; z-index: 2147483644; display: flex; flex-direction: column; align-items: center;
      justify-content: center; gap: 14px; background: radial-gradient(ellipse at 50% 40%, #2a2420 0%, #121112 70%); color: #f4efe9;
      opacity: 0; pointer-events: none; transition: opacity .5s; }
    #wt-card.on { opacity: 1; }
    #wt-card .k { font: 600 15px/1 system-ui, sans-serif; letter-spacing: .14em; text-transform: uppercase; color: #e7a46a; }
    #wt-card .t { font-size: 64px; line-height: 1.05; }
    #wt-card .s { font: 400 18px/1.4 system-ui, sans-serif; color: #c9c1b8; max-width: 640px; text-align: center; }
  ${"`"});
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, css];
  const cursor = document.createElement("div");
  cursor.id = "wt-cursor";
  cursor.innerHTML = '<svg viewBox="0 0 22 22" width="22" height="22"><path d="M3 2 L3 18 L7.5 13.8 L10.6 20.5 L13.4 19.2 L10.4 12.6 L16.6 12.4 Z" fill="#fff" stroke="#111" stroke-width="1.3" stroke-linejoin="round"/></svg>';
  const ring = document.createElement("div"); ring.id = "wt-ring";
  const cap = document.createElement("div"); cap.id = "wt-cap";
  const card = document.createElement("div"); card.id = "wt-card";
  document.body.append(card, cap, ring, cursor);
  document.addEventListener("mousemove", (e) => { cursor.style.transform = "translate(" + (e.clientX - 3) + "px," + (e.clientY - 2) + "px)"; }, true);
  document.addEventListener("mousedown", (e) => {
    ring.style.left = e.clientX + "px"; ring.style.top = e.clientY + "px";
    ring.classList.remove("go"); void ring.offsetWidth; ring.classList.add("go");
  }, true);
  const serif = getComputedStyle(document.querySelector("h1") || document.body).fontFamily;
  window.__wt = {
    cap(text) { cap.textContent = text; cap.classList.toggle("on", !!text); },
    card(kicker, title, sub) {
      card.innerHTML = "";
      for (const [cls, txt] of [["k", kicker], ["t", title], ["s", sub]]) {
        if (!txt) continue;
        const el = document.createElement("div"); el.className = cls; el.textContent = txt;
        if (cls === "t") el.style.fontFamily = serif;
        card.appendChild(el);
      }
      card.classList.toggle("on", !!title);
    },
  };
})()`;

// ---- recording ---------------------------------------------------------------------------------------

function stage(page, jobs) {
  const s = {
    page,
    jobs,
    async to(x, y, steps = 28) { await page.mouse.move(x, y, { steps }); },
    async center(loc) {
      await loc.scrollIntoViewIfNeeded({ timeout: 4000 }).catch(() => {});
      const b = await loc.boundingBox({ timeout: 4000 });
      if (!b) throw new Error(`not on screen: ${loc}`);
      return [b.x + Math.min(b.width / 2, 120), b.y + b.height / 2];
    },
    async hover(loc) { const [x, y] = await s.center(loc); await s.to(x, y); },
    async click(loc) { await s.hover(loc); await sleep(180); await page.mouse.down(); await sleep(70); await page.mouse.up(); },
    async scroll(dy) {
      const main = page.locator("main");
      const b = await main.boundingBox();
      if (b) await s.to(b.x + b.width * 0.55, b.y + b.height * 0.6, 12);
      const n = 26;
      for (let i = 0; i < n; i++) { await page.mouse.wheel(0, dy / n); await sleep(22); }
    },
    async go(name) {
      await s.click(page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: new RegExp(`^${name}( \\d+)?$`) }));
      await sleep(500);
    },
    async open(hash) { await page.evaluate((h) => { location.hash = h; }, hash); await sleep(700); },
    jobHash(company, tab) { const j = jobs.find(([c]) => c === company); return `#/job/${j[0]}/${j[1]}?tab=${tab}`; },
    row(name) { return page.getByRole("row", { name: new RegExp(name.replace(/[()]/g, "\\$&")) }).first(); },
    tab(name) { return page.getByRole("tab", { name: new RegExp(`^${name}( \\d+)?$`) }).first(); },
    async play() {
      const v = page.locator("video").first();
      await s.hover(v);
      await v.evaluate((el) => { el.muted = true; el.currentTime = 4; void el.play(); }).catch(() => {});
    },
    // Set by record(): the title card and the end card.
    card: async () => {}, end: async () => {},
  };
  return s;
}

async function setTheme(page, theme) {
  await page.evaluate(() => { location.hash = "#/settings?tab=appearance"; });
  await sleep(1200);
  await page.getByRole("radio", { name: theme === "paper" ? /Paper/ : /Graphite/ }).check();
  await sleep(600);
}

async function record(page, jobs, clip, dir, timing) {
  const groups = captionGroups(timing.words_estimated);
  fs.writeFileSync(path.join(OUT, `${clip.name}.vtt`), toVtt(groups));

  await setTheme(page, clip.theme);
  await page.evaluate(() => { location.hash = "#/home"; });
  await sleep(1200);
  await page.evaluate(OVERLAY);
  await page.evaluate(() => { const m = document.querySelector("main"); if (m) m.scrollTop = 0; });
  await page.mouse.move(W * 0.62, H * 0.55);
  await page.evaluate(([t]) => window.__wt.card("JobCairn", t, "An example job search. Every person and company shown is made up."), [clip.title]);
  await sleep(700);

  const frames = path.join(dir, "frames");
  fs.mkdirSync(frames, { recursive: true });
  const shots = [];
  const cdp = await page.context().newCDPSession(page);
  cdp.on("Page.screencastFrame", (f) => {
    const file = path.join(frames, `f${String(shots.length).padStart(5, "0")}.jpg`);
    fs.writeFileSync(file, Buffer.from(f.data, "base64"));
    shots.push({ file, t: f.metadata.timestamp });
    cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: W, maxHeight: H, everyNthFrame: 1 });
  await sleep(400);
  const t0 = Date.now() / 1000;
  const at = (t) => sleep((t0 + t) * 1000 - Date.now());

  const s = stage(page, jobs);
  s.card = async () => { await sleep(2200); await page.evaluate(() => window.__wt.card("", "", "")); await sleep(500); };
  s.end = async () => {
    await page.evaluate(() => window.__wt.cap(""));
    await page.evaluate(() => window.__wt.card("", "JobCairn", "An example job search. Every person and company shown is made up."));
  };

  const captions = (async () => {
    for (const [i, g] of groups.entries()) {
      await at(g.start);
      await page.evaluate((t) => window.__wt.cap(t), g.text);
      const next = groups[i + 1];
      if (!next || next.start - g.end > 0.6) { await at(g.end + 0.25); await page.evaluate(() => window.__wt.cap("")); }
    }
  })();
  for (const [i, beat] of clip.beats.entries()) {
    const p = timing.paragraphs[i];
    // The first beat starts with the title card already up; the rest start a moment before their words.
    await at(i === 0 ? 0 : p.start - 0.5);
    try { await beat.act(s); } catch (e) { console.log(`  ${clip.name} beat ${i + 1}: ${e.message.split("\n")[0]}`); }
  }
  await captions;
  await at(timing.total);
  await cdp.send("Page.stopScreencast");
  await cdp.detach();
  await page.evaluate(() => { window.__wt.cap(""); window.__wt.card("", "", ""); });

  // Each frame lasts until the next one; the first frame covers the start.
  const list = [];
  const kept = shots.filter((f) => f.t >= t0);
  const before = shots.filter((f) => f.t < t0).at(-1);
  if (before) kept.unshift({ ...before, t: t0 });
  for (const [i, f] of kept.entries()) {
    const end = i + 1 < kept.length ? kept[i + 1].t : t0 + timing.total;
    list.push(`file '${f.file}'`, `duration ${Math.max(0.001, end - f.t).toFixed(3)}`);
  }
  list.push(`file '${kept.at(-1).file}'`);
  fs.writeFileSync(path.join(dir, "frames.txt"), list.join("\n") + "\n");

  const mp4 = path.join(OUT, `${clip.name}.mp4`);
  run("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", path.join(dir, "frames.txt"), "-i", path.join(dir, "voice.wav"),
    "-map", "0:v", "-map", "1:a", "-vf", `fps=30,scale=${W}:${H}:flags=lanczos,format=yuv420p`, "-c:v", "libx264", "-preset", "slow", "-crf", "23",
    "-tune", "stillimage", "-c:a", "aac", "-b:a", "128k", "-t", timing.total.toFixed(2), "-movflags", "+faststart",
    "-metadata", `title=JobCairn: ${clip.title}`, "-metadata", "comment=Example workspace. Every person and company shown is made up.", mp4]);
  const posterAt = (timing.paragraphs[1]?.start ?? 3) + 1.2;
  run("ffmpeg", ["-y", "-loglevel", "error", "-ss", posterAt.toFixed(2), "-i", mp4, "-frames:v", "1", "-q:v", "3", path.join(OUT, `${clip.name}.jpg`)]);
  const mb = (fs.statSync(mp4).size / 1048576).toFixed(1);
  console.log(`${clip.name}: ${timing.total.toFixed(1)} s, ${mb} MB, ${kept.length} frames`);
}

// ---- main --------------------------------------------------------------------------------------------

fs.mkdirSync(OUT, { recursive: true });
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "careeros-walkthrough-")));
fs.mkdirSync(path.join(tmp, "home"));
// Narration first, before the app starts: the voice model and the app together can run out of memory.
const todo = CLIPS.filter((c) => !ONLY.length || ONLY.includes(c.name)).map((clip) => {
  const dir = path.join(tmp, clip.name);
  fs.mkdirSync(dir);
  let timing;
  try { timing = narrate(clip, dir); } catch { timing = narrate(clip, dir); }
  return { clip, dir, timing };
});
const app = await electron.launch({ args: [PKG], env: { ...process.env, CAREEROS_USER_DATA: path.join(tmp, "user-data"), CAREEROS_HOME_OVERRIDE: path.join(tmp, "home") } });
try {
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }, [w, h]) => { const win = BrowserWindow.getAllWindows()[0]; win.setContentSize(w, h); win.center(); }, [W, H]);
  page.on("pageerror", (e) => console.log("pageerror:", e.message));
  await page.getByRole("button", { name: /Try example/ }).click({ timeout: 60_000 });
  await page.getByText("You're exploring an example job search").waitFor({ timeout: 120_000 });
  const home = path.join(tmp, "home");
  const root = path.join(home, fs.readdirSync(home).find((n) => n.endsWith("Example")));
  const jobs = [];
  for (const c of fs.readdirSync(path.join(root, "companies"))) {
    const d = path.join(root, "companies", c, "jobs");
    if (fs.existsSync(d)) for (const id of fs.readdirSync(d)) jobs.push([c, id]);
  }
  // Quiet the first-visit tips, so only the walkthrough's own cursor and captions are on screen.
  await page.evaluate(() => { location.hash = "#/settings?tab=appearance"; });
  await sleep(1500);
  for (let i = 0; i < 3; i++) { const nn = page.getByRole("button", { name: "Not now" }); if (await nn.count()) { await nn.first().click(); await sleep(400); } }
  const off = page.getByRole("button", { name: "Tips off" });
  if (await off.count()) await off.first().click();
  for (const { clip, dir, timing } of todo) await record(page, jobs, clip, dir, timing);
} finally {
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
