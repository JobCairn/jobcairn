import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "@careeros/core";
import { CancelledError, VideoError } from "./errors.js";
import { sha256 } from "./hash.js";
import type { ProcessRunner } from "./process.js";
import type { Timeline } from "./timeline.js";
import identity from "@careeros/brand/identity.json" with { type: "json" };

/**
 * Sound design for a video: a few quiet effects on scene changes and reveals, an optional music bed, and the voice
 * on top. Ideas adapted from the agentatelier audio plugin's mixing and mastering notes (Apache-2.0; see NOTICE.md):
 * effects sit under the voice by level, only the music is ducked (a sidechain keyed from the voice), and the mix is
 * normalised to one loudness target in two passes.
 *
 * Every sound is made here with ffmpeg from a fixed recipe (seeded noise and sine tones), so nothing is downloaded,
 * nothing needs a licence beyond our own (CC0, see credits), and the same video always gets the same sounds.
 */
export const SFX_IDS = ["whoosh", "pop", "click", "chime", "rise"] as const;
export type SfxId = (typeof SFX_IDS)[number];

/** ffmpeg lavfi recipes, 48 kHz mono. Short, soft, no hard transients above the voice. */
export const SFX_RECIPES: Record<SfxId, { src: string; filter: string }> = {
  whoosh: { src: "anoisesrc=d=0.55:c=pink:r=48000:a=0.6:seed=11", filter: "highpass=f=350,lowpass=f=2600,afade=t=in:d=0.32:curve=qsin,afade=t=out:st=0.32:d=0.23:curve=qsin" },
  pop: { src: "sine=f=740:d=0.14:r=48000", filter: "afade=t=in:d=0.004,afade=t=out:st=0.01:d=0.13:curve=exp,lowpass=f=3000" },
  click: { src: "anoisesrc=d=0.035:c=white:r=48000:a=0.5:seed=5", filter: "highpass=f=1800,afade=t=out:d=0.035:curve=exp" },
  chime: { src: "aevalsrc=0.5*sin(2*PI*1318.5*t)+0.35*sin(2*PI*1975.5*t):d=1.3:s=48000", filter: "afade=t=in:d=0.005,afade=t=out:st=0.02:d=1.28:curve=exp" },
  rise: { src: "aevalsrc=0.5*sin(2*PI*(260*t+220*t*t)):d=0.7:s=48000", filter: "afade=t=in:d=0.5:curve=qsin,afade=t=out:st=0.5:d=0.2" },
};
/** Each effect's level, in linear gain (about -20 to -28 dB): heard, never louder than the voice. */
export const SFX_GAIN: Record<SfxId, number> = { whoosh: 0.09, pop: 0.06, click: 0.05, chime: 0.07, rise: 0.06 };
/** The music bed: a soft three-note pad with a slow swell, low-passed so it never competes with speech. */
export const MUSIC_RECIPE = (seconds: number) => ({
  src: `aevalsrc=(0.16*sin(2*PI*220*t)+0.12*sin(2*PI*261.63*t)+0.1*sin(2*PI*329.63*t)+0.06*sin(2*PI*110*t))*(0.75+0.25*sin(2*PI*0.07*t)):d=${seconds.toFixed(2)}:s=48000`,
  filter: `lowpass=f=1400,afade=t=in:d=1,afade=t=out:st=${Math.max(0, seconds - 3).toFixed(2)}:d=3`,
});
/** Loudness target (EBU R128): -16 LUFS integrated, -1.5 dBTP, as for spoken education content. */
export const LOUDNESS = { I: -16, TP: -1.5, LRA: 11 };
/** At most this many effects in one video, and never two closer than MIN_GAP_S. Subtle beats busy. */
export const MAX_CUES = 120;
export const MIN_GAP_S = 0.35;

export interface SoundCue { id: SfxId; at: number }

/**
 * Where the effects go: a whoosh on each scene change, a soft pop as each item lands (at most 6 a scene), a rise
 * under the title's first reveal and a chime as the last scene arrives. Cues closer than MIN_GAP_S to the one before
 * are dropped; every time is finite and inside the video.
 */
export function placeCues(tl: Timeline): SoundCue[] {
  const raw: SoundCue[] = [];
  tl.scenes.forEach((s, i) => {
    if (i === 0) raw.push({ id: "rise", at: Math.max(0, s.start + 0.1) });
    else raw.push({ id: i === tl.scenes.length - 1 ? "chime" : "whoosh", at: Math.max(0, s.start - 0.05) });
    Object.values(s.items).slice(0, 6).forEach((t) => raw.push({ id: "pop", at: t + 0.05 }));
  });
  const out: SoundCue[] = [];
  for (const c of raw.filter((c) => Number.isFinite(c.at) && c.at >= 0 && c.at < tl.total - 0.3).sort((a, b) => a.at - b.at)) {
    const last = out.at(-1);
    if (last && c.at - last.at < MIN_GAP_S) { if (c.id !== "pop" && last.id === "pop") out[out.length - 1] = c; continue; }
    out.push({ id: c.id, at: Math.round(c.at * 1000) / 1000 });
    if (out.length >= MAX_CUES) break;
  }
  return out;
}

/** The filter graph that lays the cues over the voice, ducks the bed and sums them. Input 0 is the voice, 1..n
 * the effects (in SFX_IDS order, only those used), and the bed last when there is one. */
export function mixGraph(cues: SoundCue[], used: SfxId[], music: boolean): string {
  const lines: string[] = [];
  const byId = new Map<SfxId, number[]>();
  cues.forEach((c, k) => byId.set(c.id, [...(byId.get(c.id) ?? []), k]));
  used.forEach((id, n) => {
    const ks = byId.get(id) ?? [];
    if (!ks.length) return;
    lines.push(`[${n + 1}:a]asplit=${ks.length}${ks.map((k) => `[r${k}]`).join("")}`);
    for (const k of ks) {
      const ms = Math.round(cues[k]!.at * 1000);
      lines.push(`[r${k}]adelay=${ms}|${ms},volume=${SFX_GAIN[id]}[c${k}]`);
    }
  });
  const voice = music ? "[v]" : "[0:a]";
  if (music) {
    lines.push("[0:a]asplit=2[v][key]");
    // Ducking (sidechain keyed from the voice) and a small carve where speech intelligibility lives.
    lines.push(`[${used.length + 1}:a]volume=0.5,equalizer=f=2500:t=q:w=1:g=-4[bed]`);
    lines.push("[bed][key]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=400[duck]");
  }
  const parts = [voice, ...cues.map((_, k) => `[c${k}]`), ...(music ? ["[duck]"] : [])];
  lines.push(`${parts.join("")}amix=inputs=${parts.length}:normalize=0:duration=first[mix]`);
  return lines.join(";\n");
}

export interface MixInput {
  runner: ProcessRunner; ffmpeg: string; folderAbs: string; tl: Timeline; effects: boolean; music: boolean; signal: AbortSignal;
}
export interface MixResult { file: string; cues: number; key: string; loudness: { I: number; TP: number } | null }

async function ff(i: MixInput, args: string[], what: string): Promise<string> {
  const r = await i.runner.run(i.ffmpeg, ["-hide_banner", "-nostdin", ...args], { cwd: i.folderAbs, signal: i.signal, timeoutMs: 10 * 60_000, lowPriority: true });
  if (r.cancelled || i.signal.aborted) throw new CancelledError();
  if (r.code !== 0) throw new VideoError("sound_failed", `Couldn't ${what}. The video is made without sound effects next time you try.`);
  return r.stderr;
}

/** The last loudnorm JSON block ffmpeg printed, or null. */
export function readLoudnorm(stderr: string): Record<string, string> | null {
  const at = stderr.lastIndexOf("{");
  if (at < 0) return null;
  try { return JSON.parse(stderr.slice(at, stderr.indexOf("}", at) + 1)) as Record<string, string>; } catch { return null; }
}

/**
 * Makes work/mix.wav: the narration with the effects and the optional bed, normalised in two passes. Reused when
 * nothing that goes into it changed (work/mix.key). Returns null when there is nothing to add (effects and music off).
 */
export async function mixSound(i: MixInput): Promise<MixResult | null> {
  if (!i.effects && !i.music) return null;
  const work = path.join(i.folderAbs, "work");
  fs.mkdirSync(path.join(work, "sfx"), { recursive: true });
  const voice = path.join(i.folderAbs, "narration.wav");
  const cues = i.effects ? placeCues(i.tl) : [];
  const used = SFX_IDS.filter((id) => cues.some((c) => c.id === id));
  const key = sha256("mix-v1", fs.readFileSync(voice), JSON.stringify(cues), String(i.music), JSON.stringify(SFX_RECIPES), JSON.stringify(LOUDNESS));
  const out = path.join(work, "mix.wav");
  const keyFile = path.join(work, "mix.key");
  try { if (fs.readFileSync(keyFile, "utf8") === key && fs.lstatSync(out).isFile()) return { file: out, cues: cues.length, key, loudness: null }; } catch { /* make it */ }

  for (const id of used) {
    const f = path.join(work, "sfx", `${id}.wav`);
    if (fs.existsSync(f)) continue;
    const r = SFX_RECIPES[id];
    await ff(i, ["-y", "-f", "lavfi", "-i", r.src, "-af", r.filter, "-ac", "1", "-ar", "48000", f], "make the sound effects");
  }
  const inputs = ["-i", voice, ...used.flatMap((id) => ["-i", path.join(work, "sfx", `${id}.wav`)])];
  if (i.music) {
    const m = MUSIC_RECIPE(i.tl.total);
    const bed = path.join(work, "sfx", "bed.wav");
    await ff(i, ["-y", "-f", "lavfi", "-i", m.src, "-af", m.filter, "-ac", "1", "-ar", "48000", bed], "make the music bed");
    inputs.push("-i", bed);
  }
  const graphFile = path.join(work, "mix.filter");
  writeFileAtomic(graphFile, mixGraph(cues, used, i.music));
  const raw = path.join(work, "mix-raw.wav");
  await ff(i, ["-y", ...inputs, "-filter_complex_script", graphFile, "-map", "[mix]", "-ac", "1", "-ar", "48000", "-c:a", "pcm_s16le", raw], "mix the sound");
  // Two-pass loudness: measure, then apply linearly so the dynamics of the voice are kept.
  const target = `I=${LOUDNESS.I}:TP=${LOUDNESS.TP}:LRA=${LOUDNESS.LRA}`;
  const m = readLoudnorm(await ff(i, ["-i", raw, "-af", `loudnorm=${target}:print_format=json`, "-f", "null", "-"], "measure the loudness"));
  const measured = m && ["input_i", "input_tp", "input_lra", "input_thresh", "target_offset"].every((k) => Number.isFinite(Number(m[k])))
    ? `:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`
    : "";
  const last = await ff(i, ["-y", "-i", raw, "-af", `loudnorm=${target}${measured}:print_format=json`, "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", out], "set the loudness");
  const after = readLoudnorm(last);
  fs.rmSync(raw, { force: true });
  let made = false;
  try { const st = fs.lstatSync(out); made = st.isFile() && st.size > 44; } catch { made = false; }
  if (!made) throw new VideoError("sound_failed", "The sound mix came out empty.");
  writeFileAtomic(keyFile, key);
  const I = Number(after?.output_i), TP = Number(after?.output_tp);
  return { file: out, cues: cues.length, key, loudness: Number.isFinite(I) && Number.isFinite(TP) ? { I, TP } : null };
}

export const SOUND_CREDITS = (music: boolean, effects: boolean): string[] => [
  ...(effects ? [`Sound effects: made by ${identity.name} with ffmpeg from fixed recipes (whoosh, pop, click, chime, rise). CC0.`] : []),
  ...(music ? [`Music bed: a soft pad made by ${identity.name} with ffmpeg. CC0.`] : []),
  "Mixing ideas adapted from the agentatelier audio plugin (Apache-2.0): voice on top, effects under it by level, music ducked under the voice, loudness set to -16 LUFS.",
];
