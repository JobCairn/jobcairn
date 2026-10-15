import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { mergeSpoken, type TtsOptions, type TtsSpeakResult } from "@careeros/contract";
import { blocksFromElement, ListenButton, PlayerProvider, readAloudFrom, VoiceSettings, type AudioLike } from "../src/listen";
import { listenParts } from "../src/listen/blocks";
import { blockAt } from "../src/listen/PlayerProvider";
import { Markdown } from "../src/components/Markdown";
import { MockBridge, silentWavUrl } from "../src/mock/MockBridge";
import { renderApp } from "./render";

/** Every play() across all audio elements, in order, with when it happened. */
interface Played { audio: FakeAudio; src: string; at: number }
class FakeAudio implements AudioLike {
  src = "";
  playbackRate = 1;
  defaultPlaybackRate = 1;
  preservesPitch = false;
  preload = "";
  currentTime = 0;
  duration = Number.NaN;
  paused = true;
  sources: string[] = [];
  private on: Record<string, (() => void)[]> = {};
  constructor(private log: Played[]) {}
  play() { this.paused = false; this.sources.push(this.src); this.log.push({ audio: this, src: this.src, at: performance.now() }); return Promise.resolve(); }
  pause() { this.paused = true; }
  load() { /* the real element starts buffering here */ }
  removeAttribute(n: string) { if (n === "src") this.src = ""; }
  addEventListener(t: "ended" | "error" | "timeupdate", cb: () => void) { (this.on[t] ??= []).push(cb); }
  fire(t: "ended" | "timeupdate") { act(() => { for (const cb of this.on[t] ?? []) cb(); }); }
  end() { this.paused = true; this.fire("ended"); }
}

// Long enough that the paragraphs stay separate parts; the two list items are joined into one.
const FILL = "Our team ships calm, useful software for people who read a lot.";
const PARA_A = `We build **AI** tools. See https://example.com/team. ${FILL} ${FILL} ${FILL}`;
const PARA_B = Array(8).fill(FILL).join(" ");
const MD = `# Role\n\n${PARA_A}\n\n${PARA_B}\n\n- Python\n- Agents\n\n\`\`\`\nconst x = 1;\n\`\`\``;
const SHORT_MD = "# Role\n\nWe build **AI** tools. See https://example.com/team.\n\n- Python\n- Agents\n\n```\nconst x = 1;\n```";

function setup(opts: { bridge?: MockBridge; ui?: ReactElement } = {}) {
  const log: Played[] = [];
  const audios: FakeAudio[] = [];
  const bridge = opts.bridge ?? new MockBridge();
  const ui = opts.ui ?? (
    <>
      <ListenButton title="Job description" text={MD} target="doc" />
      <div id="doc"><Markdown text={MD} /></div>
    </>
  );
  const r = renderApp(<PlayerProvider createAudio={() => { const a = new FakeAudio(log); audios.push(a); return a; }}>{ui}</PlayerProvider>, { bridge });
  const speaks = () => bridge.calls.filter((c) => c.method === "tts.speak");
  /** The element that played last (the one the person hears). */
  const playing = () => log[log.length - 1]!.audio;
  return { ...r, log, audios, playing, bridge, speaks };
}

describe("paragraphs from the page", () => {
  it("reads the rendered blocks in order and skips code", () => {
    const { container } = renderApp(<Markdown text={SHORT_MD} />);
    expect(blocksFromElement(container)).toEqual(["Role", "We build AI tools. See link.", "Python", "Agents"]);
  });
  it("joins short blocks into one part, with a pause after each, and remembers where each block starts", () => {
    const { container } = renderApp(<Markdown text={SHORT_MD} />);
    const chunks = mergeSpoken(listenParts(container));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toBe("Role. We build AI tools. See link. Python. Agents.");
    expect(chunks[0]!.parts.map((p) => p.block)).toEqual([0, 1, 2, 3]);
    expect(blockAt(chunks[0]!, 0)).toBe(0);
    expect(blockAt(chunks[0]!, 0.5)).toBe(1);
    expect(blockAt(chunks[0]!, 0.99)).toBe(3);
  });
  it("reads key-fact rows as phrases, with dates in full", () => {
    const { container } = renderApp(<dl><dt>Source</dt><dd>LinkedIn</dd><dt>Fetched</dt><dd>8 Oct 2026</dd></dl>);
    expect(mergeSpoken(listenParts(container)).map((c) => c.text)).toEqual(["Source: LinkedIn. Fetched: 8 October 2026."]);
  });
  it("reads settings with safe fallbacks", () => {
    // A hand-edited expressions value never reaches read aloud (that switch is for videos only).
    expect(readAloudFrom({ read_aloud: { voice: "M3", speed: 9, lang: "ja", expressions: true } })).toEqual({ voice: "M3", speed: 1.5, lang: "ja" });
    expect(readAloudFrom({ read_aloud: { lang: "en; rm -rf" } }).lang).toBe("en");
    expect(readAloudFrom(undefined)).toEqual({ voice: "F4", speed: 1, lang: "en" });
  });
});

describe("ListenButton and the player", () => {
  it("renders nothing without a player or without text", () => {
    renderApp(<ListenButton title="Empty" text="Hello" />);
    expect(screen.queryByRole("button", { name: /Listen/ })).not.toBeInTheDocument();
    setup({ ui: <ListenButton title="Empty" text="   " /> });
    expect(screen.queryByRole("button", { name: /Listen/ })).not.toBeInTheDocument();
  });

  it("plays part by part, highlighting the one being read", async () => {
    const { log, playing, speaks } = setup();
    await userEvent.click(screen.getByRole("button", { name: "Listen: Job description" }));
    const bar = await screen.findByRole("region", { name: "Read aloud" });
    await waitFor(() => expect(log).toHaveLength(1));
    expect(within(bar).getByText("Part 1 of 4")).toBeInTheDocument();
    expect(document.querySelector(".listen-active")?.textContent).toBe("Role");
    // The URL is spoken as "link", with the user's default voice, and two parts are queued ahead.
    await waitFor(() => expect(speaks().length).toBeGreaterThanOrEqual(3));
    expect(speaks()[0]!.args[0]).toBe("Role.");
    expect(speaks()[1]!.args[0]).toMatch(/^We build AI tools\. See link\. Our team/);
    expect(speaks()[0]!.args[1]).toEqual({ voice: "F4", lang: "en" });
    expect(playing().preservesPitch).toBe(true);
    playing().end();
    await waitFor(() => expect(within(bar).getByText("Part 2 of 4")).toBeInTheDocument());
    expect(document.querySelector(".listen-active")?.textContent).toContain("We build");
    expect(screen.getByRole("button", { name: "Pause: Job description" })).toBeInTheDocument();
  });

  it("changes speed at playback without asking for new audio", async () => {
    const { log, playing, speaks } = setup();
    await userEvent.click(screen.getByRole("button", { name: "Listen: Job description" }));
    await waitFor(() => expect(log).toHaveLength(1));
    await waitFor(() => expect(speaks()).toHaveLength(3));
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Speed" }), "1.25");
    expect(playing().playbackRate).toBe(1.25);
    expect(playing().defaultPlaybackRate).toBe(1.25);
    expect(speaks()).toHaveLength(3);
    playing().end();
    await waitFor(() => expect(log).toHaveLength(2));
    expect(playing().playbackRate).toBe(1.25); // the preloaded element got the new speed too
  });

  it("starts the next part the moment one ends: no gap, no Preparing flash", async () => {
    const { log, audios, playing, speaks } = setup();
    await userEvent.click(screen.getByRole("button", { name: "Listen: Job description" }));
    await waitFor(() => expect(log).toHaveLength(1));
    await waitFor(() => expect(speaks().length).toBeGreaterThanOrEqual(2));
    // While part 1 plays, part 2 is already loaded in the other element.
    const first = playing();
    const second = audios.find((a) => a !== first)!;
    await waitFor(() => expect(second.src).not.toBe(""));
    expect(second.preload).toBe("auto");
    const ended = performance.now();
    first.end();
    expect(log).toHaveLength(2); // started in the same tick as "ended"
    expect(log[1]!.audio).toBe(second);
    expect(log[1]!.at - ended).toBeLessThan(150);
    expect(screen.queryByText("Preparing voice…")).not.toBeInTheDocument();
    expect(screen.getByText("Part 2 of 4")).toBeInTheDocument();
    // And again for part 3: the elements take turns.
    await waitFor(() => expect(log[1]!.audio === second && first.src !== log[0]!.src).toBe(true));
    const t = performance.now();
    second.end();
    expect(log).toHaveLength(3);
    expect(log[2]!.audio).toBe(first);
    expect(log[2]!.at - t).toBeLessThan(150);
  });

  it("moves the highlight along a joined part as it plays", async () => {
    const ui = (
      <>
        <ListenButton title="Notes" text={SHORT_MD} target="notes" />
        <div id="notes"><Markdown text={SHORT_MD} /></div>
      </>
    );
    const { log, playing } = setup({ ui });
    await userEvent.click(screen.getByRole("button", { name: "Listen: Notes" }));
    await waitFor(() => expect(log).toHaveLength(1));
    expect(document.querySelector(".listen-active")?.textContent).toBe("Role");
    const a = playing();
    a.duration = 10;
    a.currentTime = 9.5;
    a.fire("timeupdate");
    expect(document.querySelector(".listen-active")?.textContent).toBe("Agents");
    expect(document.querySelectorAll(".listen-active")).toHaveLength(1);
  });

  it("pauses, resumes, skips and stops", async () => {
    const { log, playing, audios, bridge } = setup();
    await userEvent.click(screen.getByRole("button", { name: "Listen: Job description" }));
    await waitFor(() => expect(log).toHaveLength(1));
    const audio = playing();
    await userEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(audio.paused).toBe(true);
    expect(screen.getByText(/Paused · Part 1 of 4/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Resume: Job description" }));
    expect(audio.paused).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Next part" }));
    await waitFor(() => expect(screen.getByText("Part 2 of 4")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "Previous part" }));
    await waitFor(() => expect(screen.getByText("Part 1 of 4")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "Stop reading" }));
    expect(screen.queryByRole("region", { name: "Read aloud" })).not.toBeInTheDocument();
    expect(document.querySelector(".listen-active")).toBeNull();
    for (const a of audios) expect(a.paused).toBe(true);
    expect(bridge.calls.some((c) => c.method === "tts.speak")).toBe(true);
  });

  it("shows Preparing voice while the first paragraph is made, and cancels it on stop", async () => {
    const bridge = new MockBridge({ ttsDelayMs: 10_000 });
    const { log } = setup({ bridge });
    await userEvent.click(screen.getByRole("button", { name: "Listen: Job description" }));
    const bar = await screen.findByRole("region", { name: "Read aloud" });
    expect(await within(bar).findByText("Preparing voice…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preparing voice for Job description. Press to pause" })).toBeEnabled();
    expect(log).toHaveLength(0);
    // Pausing while it's being made holds it; Play asks again.
    await userEvent.click(within(bar).getByRole("button", { name: "Pause" }));
    expect(within(bar).getByText(/Paused · Part 1 of 4/)).toBeInTheDocument();
    await userEvent.click(within(bar).getByRole("button", { name: "Play" }));
    expect(await within(bar).findByText("Preparing voice…")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Stop reading" }));
    await waitFor(() => expect(bridge.calls.some((c) => c.method === "tts.cancel")).toBe(true));
  });

  it("shows an error with a retry, and the fallback voice note", async () => {
    const bridge = new MockBridge({ ttsEngine: "macos_say" });
    let fail = true;
    const real = bridge.tts.speak;
    bridge.tts.speak = (...a: Parameters<typeof real>): Promise<TtsSpeakResult> => (fail ? Promise.reject(new Error("The voice couldn't read this paragraph.")) : real(...a));
    setup({ bridge });
    await userEvent.click(screen.getByRole("button", { name: "Listen: Job description" }));
    expect(await screen.findByText("The voice couldn't read this paragraph.")).toBeInTheDocument();
    fail = false;
    // A failure always offers the Mac voice too.
    expect(within(screen.getByRole("region", { name: "Read aloud" })).getByRole("button", { name: "Mac voice" })).toBeInTheDocument();
    await userEvent.click(within(screen.getByRole("region", { name: "Read aloud" })).getByRole("button", { name: "Try again" }));
    expect(await screen.findByText(/Using the macOS voice/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Part 1 of 4")).toBeInTheDocument());
  });

  it("explains a wait over two seconds and offers the Mac voice, which reads the rest", async () => {
    const bridge = new MockBridge({ ttsDelayMs: 60_000 });
    const real = bridge.tts.speak;
    const macCalls: TtsOptions[] = [];
    bridge.tts.speak = (text, options, source, requestId): Promise<TtsSpeakResult> => {
      if (options.engine === "macos_say") { macCalls.push(options); return Promise.resolve({ url: silentWavUrl(text), cached: false, engine: "macos_say", fellBack: false }); }
      return real(text, options, source, requestId);
    };
    bridge.tts.activity = () => Promise.resolve({ voice: "starting", previewsLeft: 0 });
    const { log } = setup({ bridge });
    await userEvent.click(screen.getByRole("button", { name: "Listen: Job description" }));
    const bar = await screen.findByRole("region", { name: "Read aloud" });
    expect(within(bar).getByText("Preparing voice…")).toBeInTheDocument();
    expect(within(bar).queryByRole("button", { name: "Mac voice" })).not.toBeInTheDocument(); // not for a short wait
    expect(await within(bar).findByText("Starting the natural voice…", {}, { timeout: 4000 })).toBeInTheDocument();
    await userEvent.click(within(bar).getByRole("button", { name: "Mac voice" }));
    await waitFor(() => expect(log).toHaveLength(1));
    expect(macCalls[0]).toEqual({ voice: "F4", lang: "en", engine: "macos_say" });
    expect(within(bar).getByText(/Using the Mac voice for this reading/)).toBeInTheDocument();
    expect(within(bar).queryByRole("button", { name: "Mac voice" })).not.toBeInTheDocument();
    // The cancelled natural-voice request isn't shown as an error.
    expect(within(bar).queryByText(/stopped/)).not.toBeInTheDocument();
  });

  it("says when the natural voice is warming up, and clears it once it takes over", async () => {
    const bridge = new MockBridge();
    const real = bridge.tts.speak;
    let n = 0;
    bridge.tts.speak = async (...a: Parameters<typeof real>): Promise<TtsSpeakResult> => {
      const r = await real(...a);
      n += 1;
      return n === 1 ? { ...r, engine: "macos_say", fellBack: true, warming: true } : r;
    };
    const { log, playing } = setup({ bridge });
    await userEvent.click(screen.getByRole("button", { name: "Listen: Job description" }));
    await waitFor(() => expect(log).toHaveLength(1));
    const bar = screen.getByRole("region", { name: "Read aloud" });
    expect(within(bar).getByText(/Natural voice warming up/)).toBeInTheDocument();
    expect(within(bar).queryByText(/isn't set up/)).not.toBeInTheDocument();
    await waitFor(() => expect(n).toBeGreaterThanOrEqual(2)); // part 2 is already made, by the natural voice
    expect(within(bar).getByText(/Natural voice warming up/)).toBeInTheDocument(); // still true for what is playing
    playing().end();
    await waitFor(() => expect(log).toHaveLength(2));
    expect(within(bar).queryByText(/Natural voice warming up/)).not.toBeInTheDocument();
  });

  it("reads a file on demand and says so when it isn't there yet", async () => {
    setup({ ui: <ListenButton title="Company research" source="companies/acme-corp/research.md" missingText="No company research yet. Use Research company first." /> });
    await userEvent.click(screen.getByRole("button", { name: "Listen: Company research" }));
    expect(await screen.findByText("No company research yet. Use Research company first.")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Read aloud" })).not.toBeInTheDocument();
  });

  it("refuses to read a locked folder", async () => {
    setup({ ui: <ListenButton title="Visa" text="Fictional note." source="me/identity/visa.md" /> });
    await userEvent.click(screen.getByRole("button", { name: "Listen: Visa" }));
    expect(await screen.findByText(/me\/identity is locked/)).toBeInTheDocument();
  });
});

describe("Voice settings", () => {
  it("shows the engine status and saves read-aloud defaults under read_aloud", async () => {
    const { bridge } = setup({ ui: <VoiceSettings /> });
    expect(await screen.findByText("Supertonic ready")).toBeInTheDocument();
    await userEvent.click(within(screen.getByRole("group", { name: "Voice" })).getByLabelText("Leo · Bright, energetic (Recommended)"));
    await userEvent.selectOptions(screen.getByLabelText("Default speed"), "1.25");
    const saves = bridge.calls.filter((c) => c.method === "settings.save").map((c) => c.args[1]);
    expect(saves).toContainEqual([{ path: "read_aloud.voice", value: "M3" }]);
    expect(saves).toContainEqual([{ path: "read_aloud.speed", value: 1.25 }]);
    // Expressions are a video-only setting (on or off, no emotion presets); reading aloud doesn't show them.
    const reading = screen.getByLabelText("Reading aloud");
    expect(within(reading).queryByLabelText("Expressions")).not.toBeInTheDocument();
    const videos = screen.getByLabelText("Videos");
    expect(within(videos).getByLabelText("Expressions")).toBeInTheDocument();
    expect(within(videos).getByText(/one expression setting: on or off/)).toBeInTheDocument();
    expect(screen.queryByText(/calm preset|happy preset/i)).not.toBeInTheDocument();
    // Languages come from the engine, by name.
    const lang = within(reading).getByLabelText("Language") as HTMLSelectElement;
    expect([...lang.options].map((o) => o.value)).toEqual(["en", "de", "es", "fr", "ja", "ko", "pt"]);
    expect(within(lang).getByText("Japanese")).toBeInTheDocument();
    await userEvent.selectOptions(lang, "ja");
    expect(bridge.calls.filter((c) => c.method === "settings.save").map((c) => c.args[1])).toContainEqual([{ path: "read_aloud.lang", value: "ja" }]);
  });

  it("shows each voice as a name with its style, and a tag only on the default and recommended voice", async () => {
    setup({ ui: <VoiceSettings /> });
    const reading = await screen.findByLabelText("Reading aloud");
    const voiceGroup = within(reading).getByRole("group", { name: "Voice" });
    expect(within(voiceGroup).getByText("Maya")).toBeInTheDocument();
    expect(within(voiceGroup).getByText("Warm, calm")).toBeInTheDocument();
    expect(within(voiceGroup).getByText("Default")).toBeInTheDocument();
    expect(within(voiceGroup).getByText("Leo")).toBeInTheDocument();
    expect(within(voiceGroup).getByText("Bright, energetic")).toBeInTheDocument();
    expect(within(voiceGroup).getByText("Recommended")).toBeInTheDocument();
    // Every other voice has no tag text at all.
    expect(within(voiceGroup).getByText("Nora")).toBeInTheDocument();
    expect(within(voiceGroup).queryByText("(default)")).not.toBeInTheDocument();
    expect(within(voiceGroup).queryByText(/recommended male voice/i)).not.toBeInTheDocument();
  });

  it("keeps the video voice under the existing voice key", async () => {
    const { bridge } = setup({ ui: <VoiceSettings /> });
    const videos = await screen.findByRole("region", { name: "Videos" }).catch(() => screen.getByLabelText("Videos"));
    await userEvent.selectOptions(within(videos).getByLabelText("Voice"), "M1");
    expect(bridge.calls.filter((c) => c.method === "settings.save").map((c) => c.args[1])).toContainEqual([{ path: "voice.voice", value: "M1" }]);
  });

  it("makes a voice's sample only when its Preview is pressed, then plays it", async () => {
    const { log, bridge } = setup({ ui: <VoiceSettings /> });
    expect(await screen.findByText(/sample is made the first time you press its Preview/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Generate previews" })).not.toBeInTheDocument(); // never all ten at once
    expect(bridge.calls.some((c) => c.method === "tts.previewVoice" || c.method === "tts.generatePreviews")).toBe(false);
    await userEvent.click(await screen.findByRole("button", { name: "Preview Maya · Warm, calm" }));
    await waitFor(() => expect(log).toHaveLength(1));
    expect(bridge.calls.filter((c) => c.method === "tts.previewVoice").map((c) => c.args)).toEqual([["F4", "en"]]);
    expect(log[0]!.src).toBe(silentWavUrl("Hi, I'm your study voice."));
    expect(await screen.findByRole("button", { name: "Stop preview of Maya · Warm, calm" })).toBeInTheDocument();
    // Other voices are still made only on their own click.
    expect(screen.getByRole("button", { name: "Preview Leo · Bright, energetic" })).toBeInTheDocument();
  });

  it("offers the model download as an explicit step, and says where locked-folder audio goes", async () => {
    const b = new MockBridge({ ttsNeedsDownload: true });
    setup({ bridge: b, ui: <VoiceSettings /> });
    expect(await screen.findByText("The Supertonic voice isn't downloaded yet.")).toBeInTheDocument();
    expect(screen.getByText(/A locked folder is read aloud only while you've unlocked it/)).toBeInTheDocument();
    expect(b.calls.some((c) => c.method === "tts.downloadVoice")).toBe(false); // nothing downloads on its own
    await userEvent.click(screen.getByRole("button", { name: "Download voice" }));
    expect(await screen.findByText("Supertonic ready")).toBeInTheDocument();
    expect(b.calls.filter((c) => c.method === "tts.downloadVoice")).toHaveLength(1);
  });

  it("offers an in-app install when Supertonic itself isn't set up, after a one-line confirm", async () => {
    const b = new MockBridge({ ttsNeedsInstall: true });
    setup({ bridge: b, ui: <VoiceSettings /> });
    expect(await screen.findByText("The natural voice (Supertonic) isn't set up on this Mac yet.")).toBeInTheDocument();
    expect(screen.getByText(/Installs the voice engine \(about 200 MB\) once/)).toBeInTheDocument();
    expect(b.calls.some((c) => c.method === "tts.installVoice")).toBe(false); // nothing installs on its own
    await userEvent.click(screen.getByRole("button", { name: "Install voice…" }));
    expect(b.calls.some((c) => c.method === "tts.installVoice")).toBe(false); // the confirm dialog first, not the call itself
    const dialog = (await screen.findByRole("dialog", { name: "Set up the natural voice?" }));
    expect(within(dialog).getByText(/about 200 MB.*never in the cloud/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Set up" }));
    // The install only puts the package in place; the model is still the separate, explicit download.
    expect(await screen.findByText("The Supertonic voice isn't downloaded yet.")).toBeInTheDocument();
    expect(b.calls.filter((c) => c.method === "tts.installVoice")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Download voice" })).toBeInTheDocument();
  });
  it("explains a missing engine instead of offering previews", async () => {
    setup({ bridge: new MockBridge({ ttsEngine: "none", setup: { missing: ["python"] } }), ui: <VoiceSettings /> });
    expect((await screen.findAllByText("Not installed")).length).toBeGreaterThan(0);
    expect(screen.getByText("Install Python 3.11 to 3.14 below.")).toBeInTheDocument();
    // The missing tool installs right here, with a yes first, instead of pointing at a setup script.
    expect(await screen.findByRole("button", { name: "Install Python" })).toBeInTheDocument();
    expect(screen.getByText(/Samples need the Supertonic voice/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Generate previews" })).not.toBeInTheDocument();
  });

  it("offers English only, with the reason, when the engine's language list isn't available", async () => {
    setup({ bridge: new MockBridge({ ttsEngine: "macos_say" }), ui: <VoiceSettings /> });
    expect(await screen.findByText("Using the macOS voice")).toBeInTheDocument();
    const lang = within(screen.getByLabelText("Reading aloud")).getByLabelText("Language") as HTMLSelectElement;
    expect([...lang.options].map((o) => o.textContent)).toEqual(["English"]);
    expect(screen.getAllByText("Only English is offered until the Supertonic voice is set up.").length).toBeGreaterThan(0);
  });
});
