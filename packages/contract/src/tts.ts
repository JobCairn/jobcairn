// Read aloud: shared, pure pieces. The renderer uses them to know the paragraphs it will play and
// the services use them to clean exactly what is spoken. No Node or DOM APIs here.

export const TTS_VOICES = ["F4", "M3", "F1", "F2", "F3", "F5", "M1", "M2", "M4", "M5"] as const;
export type TtsVoice = (typeof TTS_VOICES)[number];
export const DEFAULT_TTS_VOICE: TtsVoice = "F4";
export const RECOMMENDED_MALE_VOICE: TtsVoice = "M3";
/**
 * A language code passed straight to the engine ("en", "ko", "pt-BR"). The supported list is not hard-coded:
 * the services read it from the installed supertonic package (TtsStatus.languages).
 */
export type TtsLang = string;
export const TTS_LANG_CODE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;
export const DEFAULT_TTS_LANG = "en";

/** "en" -> "English" (the OS's own language names), or the code itself when it has no name. */
export function langLabel(code: string, locale = "en"): string {
  try {
    const name = new Intl.DisplayNames([locale], { type: "language" }).of(code);
    return name && name !== code ? name : code;
  } catch { return code; }
}
export const READ_ALOUD_SPEEDS = [0.75, 1, 1.25, 1.5] as const;
export const MIN_SPEED = 0.75;
export const MAX_SPEED = 1.5;
/** Longest paragraph sent to the engine in one go; longer ones are split at sentence ends. */
export const MAX_CHUNK_CHARS = 600;
/** Longest text one tts.speak call accepts. */
export const MAX_SPEAK_CHARS = 4000;

/**
 * A friendly first name plus a short, plain style description for each preset voice. Grounded in a measured
 * sample of each voice (median pitch, pitch variation, speaking rate, loudness and brightness), synthesised
 * with the same neutral sentence through the real Supertonic model (see the lane report for the numbers).
 */
export const VOICE_INFO: Record<TtsVoice, { name: string; style: string }> = {
  F1: { name: "Nora", style: "Crisp, steady" },
  F2: { name: "Zara", style: "Sunny, lively" },
  F3: { name: "Elena", style: "Soft, expressive" },
  F4: { name: "Maya", style: "Warm, calm" },
  F5: { name: "Aria", style: "Smooth, mellow" },
  M1: { name: "Kai", style: "Crisp, friendly" },
  M2: { name: "Theo", style: "Deep, expressive" },
  M3: { name: "Leo", style: "Bright, energetic" },
  M4: { name: "Felix", style: "Smooth, steady" },
  M5: { name: "Omar", style: "Deep, warm" },
};

export function voiceLabel(v: string): string {
  const info = (VOICE_INFO as Record<string, { name: string; style: string }>)[v];
  if (!info) return v;
  return `${info.name} · ${info.style}`;
}

/** "Default" / "Recommended" for the Settings voice card's small pill, or "" for every other voice. */
export function voiceTag(v: string): "Default" | "Recommended" | "" {
  if (v === DEFAULT_TTS_VOICE) return "Default";
  if (v === RECOMMENDED_MALE_VOICE) return "Recommended";
  return "";
}

/**
 * Read aloud never uses expressions (that switch is for videos only), so there is no such option here.
 * `engine: "macos_say"` asks for the Mac's own voice even when Supertonic is set up ("Use the Mac voice instead").
 */
export interface TtsOptions { voice: TtsVoice; lang: TtsLang; engine?: "macos_say" }
export interface ReadAloudSettings extends TtsOptions { speed: number }
export const READ_ALOUD_DEFAULTS: ReadAloudSettings = { voice: DEFAULT_TTS_VOICE, lang: "en", speed: 1 };

export type TtsEngine = "supertonic" | "macos_say";
export interface TtsSpeakResult {
  url: string; cached: boolean; engine: TtsEngine; fellBack: boolean;
  /** The Mac voice read this paragraph because the natural voice was still starting; it takes over from the next one. */
  warming?: boolean;
}
/**
 * What the voice is doing right now, so a wait can be explained. `voice`: "off" (nothing loaded), "starting" (the
 * natural voice is loading its model), "ready" (loaded and idle) or "busy" (speaking a paragraph).
 */
export interface TtsActivity { voice: "off" | "starting" | "ready" | "busy"; previewsLeft: number }
export interface TtsStatus {
  /** What reading aloud will use right now. "none": nothing can speak. */
  engine: TtsEngine | "none";
  /** One plain sentence for the status line. */
  text: string;
  /** What to do about it, or "" when all is well. */
  hint: string;
  /** Languages the installed engine supports. Only ["en"] when the list couldn't be read. */
  languages: string[];
  /** Why the list is short, or "" when it came from the engine. */
  languagesNote: string;
  /**
   * The Supertonic voice is installed but its model isn't on this computer yet. Reading aloud never downloads it;
   * Settings > Voice offers an explicit download (tts.downloadVoice).
   */
  needsDownload?: boolean;
  /**
   * Supertonic itself (the Python package, not the model) isn't set up on this Mac yet. Settings > Voice offers
   * an explicit in-app install (tts.installVoice), which never runs on its own.
   */
  needsInstall?: boolean;
}
export interface TtsPreviewVoice { voice: TtsVoice; label: string; url: string | null }
export interface TtsPreviews { voices: TtsPreviewVoice[]; missing: number }

/** File names the careeros-file://tts/ host serves: a cache entry or a voice preview. Nothing else. */
export const TTS_CACHE_NAME = /^[0-9a-f]{64}\.wav$/;
export const TTS_PREVIEW_NAME = /^preview-([FM][1-5])\.wav$/;
/** Audio made from an unlocked locked-folder file: .careeros/tts-private/, served only while the grant holds. */
export const TTS_PRIVATE_NAME = /^private-([0-9a-f]{64})\.wav$/;
export const ttsMediaUrl = (name: string): string => `careeros-file://tts/${name}`;

// ---- text preparation -----------------------------------------------------------------------

const FENCE = /^\s{0,3}(```|~~~)/;
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>()]+[^\s<>().,;:!?'"]/gi;

/** One block of markdown (or plain text) -> the words a person would say. URLs become "link"; code is dropped. */
export function speakable(input: string): string {
  let s = input.replace(/\r\n?/g, "\n");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, (_m, alt: string) => (alt.trim() ? ` ${alt} ` : " "));
  s = s.replace(/\[([^\]]+)\]\((?:[^()]|\([^)]*\))*\)/g, "$1");
  s = s.replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1");
  s = s.replace(/<(?:https?:\/\/|mailto:)[^>]+>/gi, " link ");
  s = s.replace(/<\/?[A-Za-z][^>]*>/g, " ");
  s = s.replace(URL_RE, " link ");
  s = s.replace(/`{3,}[^`]*`{3,}/g, " ");
  s = s.replace(/`([^`]+)`/g, "$1");
  s = s.split("\n").map((line) => line
    .replace(/^\s{0,3}#{1,6}\s+/, "")
    .replace(/\s+#+\s*$/, "")
    .replace(/^\s*>\s?/, "")
    .replace(/^\s*(?:[-*+]|\d{1,3}[.)])\s+(?:\[[ xX]\]\s+)?/, "")
    .replace(/^\s*\|?(\s*:?-{2,}:?\s*\|)+\s*:?-*:?\s*$/, "")
    .replace(/\s*\|\s*/g, ", ")
    .replace(/^[-*_]{3,}\s*$/, "")).join("\n");
  s = s.replace(/(\*\*|__)(.+?)\1/g, "$2").replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,;:!?]|$)/g, "$1$2").replace(/~~(.+?)~~/g, "$1");
  s = s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'");
  s = s.replace(/^[ \t,]+|[ \t,]+$/gm, "");
  s = s.replace(/\blink(\s+link)+\b/g, "link");
  return speakDates(s.replace(/\s+/g, " ").replace(/ ([.,;:!?])/g, "$1").trim());
}

const MONTHS: Record<string, string> = {
  jan: "January", feb: "February", mar: "March", apr: "April", jun: "June", jul: "July", aug: "August",
  sep: "September", sept: "September", oct: "October", nov: "November", dec: "December",
};
/** "8 Oct 2026" -> "8 October 2026", so the voice doesn't say "oct". Only after a day number, so "Mar" stays a word elsewhere. */
export function speakDates(s: string): string {
  // An abbreviation's own dot goes only before a year ("8 Oct. 2026"); otherwise it may end the sentence.
  return s.replace(/\b(\d{1,2}) (Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)(?:\.(?= \d{4}))?(?=[\s,.;:!?)]|$)/g, (_m, d: string, mon: string) => `${d} ${MONTHS[mon.toLowerCase()]}`);
}

/** Splits a long paragraph at sentence ends (or, failing that, at spaces) so no piece is over `max`. */
export function splitLong(text: string, max = MAX_CHUNK_CHARS): string[] {
  if (text.length <= max) return text ? [text] : [];
  const sentences = text.match(/[^.!?]+(?:[.!?]+["')\]]*|$)\s*/g) ?? [text];
  const out: string[] = [];
  let cur = "";
  const push = () => { if (cur.trim()) out.push(cur.trim()); cur = ""; };
  for (const s of sentences) {
    if (s.length > max) {
      push();
      let rest = s.trim();
      while (rest.length > max) {
        const cut = rest.lastIndexOf(" ", max);
        const at = cut > max / 2 ? cut : max;
        out.push(rest.slice(0, at).trim());
        rest = rest.slice(at).trim();
      }
      cur = rest ? `${rest} ` : "";
      continue;
    }
    if ((cur + s).length > max) push();
    cur += s;
  }
  push();
  return out;
}

/**
 * Markdown -> spoken paragraphs, in reading order. Fenced code blocks are skipped. Headings and each
 * list item are their own paragraph, like the rendered page. Long paragraphs are split at sentence ends.
 */
export function chunkMarkdown(md: string, max = MAX_CHUNK_CHARS): string[] {
  const blocks: string[] = [];
  let cur: string[] = [];
  let inFence = false;
  const flush = () => { if (cur.length) blocks.push(cur.join("\n")); cur = []; };
  for (const line of md.replace(/\r\n?/g, "\n").split("\n")) {
    if (FENCE.test(line)) { flush(); inFence = !inFence; continue; }
    if (inFence) continue;
    if (!line.trim()) { flush(); continue; }
    const heading = /^\s{0,3}#{1,6}\s/.test(line);
    const item = /^\s*(?:[-*+]|\d{1,3}[.)])\s+/.test(line);
    if (heading || item) flush();
    cur.push(line);
    if (heading) flush();
  }
  flush();
  return blocks.flatMap((b) => splitLong(speakable(b), max));
}

/** Plain paragraphs (already split by the caller) -> spoken paragraphs. */
export function chunkBlocks(blocks: readonly string[], max = MAX_CHUNK_CHARS): string[] {
  return blocks.flatMap((b) => splitLong(speakable(b), max));
}

/** Like chunkBlocks, but each spoken paragraph remembers which source block it came from (for the highlight). */
export function chunkBlocksIndexed(blocks: readonly string[], max = MAX_CHUNK_CHARS): { text: string; block: number }[] {
  return blocks.flatMap((b, block) => splitLong(speakable(b), max).map((text) => ({ text, block })));
}

/** Short neighbouring blocks are joined up to this many characters, so the voice doesn't stop after every line. */
export const MERGE_CHARS = 500;
/** The first chunk is kept short, so the first words come quickly. */
export const FIRST_CHUNK_CHARS = 220;

/** One spoken chunk: its text, the first block it reads, and where each block's words start (0..1 of the text). */
export interface SpokenChunk { text: string; block: number; parts: { block: number; from: number }[] }

/**
 * Blocks -> chunks for read aloud. Each block is cleaned (`speakable`) and split only at sentence ends when it is
 * long. Short neighbours (headings, list items, key-fact rows) are joined into one chunk of up to `target`
 * characters, each ending with a full stop so the voice pauses naturally ("Source: LinkedIn. Fetched 8 October
 * 2026."). The first chunk stops at `first` characters so the voice can start quickly.
 */
export function mergeSpoken(blocks: readonly { text: string; block: number }[], o: { target?: number; first?: number; max?: number } = {}): SpokenChunk[] {
  const target = o.target ?? MERGE_CHARS;
  const first = o.first ?? FIRST_CHUNK_CHARS;
  const max = o.max ?? MAX_CHUNK_CHARS;
  const pieces = blocks.flatMap((b) => splitLong(speakable(b.text), max).map((text) => ({
    // A line with no end mark gets a full stop when it is joined, so the voice pauses; a "Label:" keeps its colon.
    text: /[.!?:;,…"')\]]$/.test(text) ? text : `${text}.`, block: b.block,
  })));
  const out: SpokenChunk[] = [];
  let cur: { text: string; parts: { block: number; at: number }[] } | null = null;
  const push = () => {
    if (!cur) return;
    const len = cur.text.length || 1;
    out.push({ text: cur.text, block: cur.parts[0]!.block, parts: cur.parts.map((p) => ({ block: p.block, from: p.at / len })) });
    cur = null;
  };
  for (const p of pieces) {
    const limit = out.length === 0 ? first : target;
    if (cur && cur.text.length + 1 + p.text.length > limit) push();
    if (!cur) { cur = { text: p.text, parts: [{ block: p.block, at: 0 }] }; continue; }
    const at: number = cur.text.length + 1;
    cur.text = `${cur.text} ${p.text}`;
    if (cur.parts[cur.parts.length - 1]!.block !== p.block) cur.parts.push({ block: p.block, at });
  }
  push();
  return out;
}

/** A client-made id for one tts.speak call, so the player can cancel it. */
export const TTS_REQUEST_ID = /^[a-z0-9]{1,16}(-[a-z0-9]{1,16}){0,3}$/;
