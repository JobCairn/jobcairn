import fs from "node:fs";
import path from "node:path";
import { insideRoot, writeFileAtomic } from "@careeros/core";
import { CancelledError } from "./errors.js";
import { copyFileNoFollow, type MediaBundle } from "./expander.js";
import { sha256 } from "./hash.js";
import { creditsMarkdown, gatherMedia, withCredits, type Credit } from "./media.js";
import type { ProcessRunner } from "./process.js";
import { mixSound, SOUND_CREDITS } from "./sound.js";
import type { Timeline } from "./timeline.js";
import type { SceneSpec, VideoOptions, VideoSettings, VideoSubject, VideoType } from "./types.js";

/**
 * The media stage, kept out of pipeline.ts so the pipeline only calls one function: gather the pictures (only for
 * types with `media: "offline"`), mix the sound (every type, unless sound is off), and write the credits into
 * credits.md and the Credits section of notes.md. A sound problem never stops the video: it is made without the
 * effects and the stage says so.
 */
export interface MediaStageInput {
  root: string; folder: string; abs: string; type: VideoType; subject: VideoSubject; spec: SceneSpec; templatesDir: string;
  settings: VideoSettings; options: VideoOptions;
}
export interface MediaStageOutput { media: MediaBundle | undefined; audio: string | undefined; motion: "full" | "reduced" | undefined; key: string; said?: string }

/** Effects on unless this video says "off", or (when it says nothing) Settings says "off". */
export function soundChoice(settings: VideoSettings, options: VideoOptions): { effects: boolean; music: boolean } {
  const effects = options.sound ? options.sound === "on" : settings.sound !== "off";
  return { effects, music: settings.music === true };
}

export function runMedia(i: MediaStageInput) {
  return {
    async run(o: { runner: ProcessRunner; ffmpeg: string; tl: Timeline; signal: AbortSignal; message(m: string): void }): Promise<MediaStageOutput> {
      const motion = i.settings.motion === "reduced" ? "reduced" as const : "full" as const;
      const credits: Credit[] = [];
      let media: MediaBundle | undefined;
      let mediaKey = "";
      const said: string[] = [];
      if (i.type.media !== "none") {
        o.message("Looking for pictures in your files");
        const g = gatherMedia({ root: i.root, folder: i.folder, subject: i.subject, templatesDir: i.templatesDir, spec: i.spec });
        // A bundled mark lives outside the workspace: copied into the video's work/ folder first, so the expander
        // only ever copies files from inside the workspace into the composition.
        const files = g.bundle.files.map((f) => {
          if (insideRoot(i.root, f.abs)) return f;
          const dir = path.join(i.abs, "work", "media");
          fs.mkdirSync(dir, { recursive: true });
          const dest = path.join(dir, path.basename(f.rel));
          fs.rmSync(dest, { force: true });
          copyFileNoFollow(f.abs, dest);
          return { abs: dest, rel: f.rel };
        });
        media = { refs: g.bundle.refs, files }; mediaKey = g.key; credits.push(...g.credits); said.push(g.summary);
      }
      const { effects, music } = soundChoice(i.settings, i.options);
      let audio: string | undefined;
      let soundKey = "off";
      if (effects || music) {
        o.message("Mixing the sound");
        try {
          const m = await mixSound({ runner: o.runner, ffmpeg: o.ffmpeg, folderAbs: i.abs, tl: o.tl, effects, music, signal: o.signal });
          if (m) { audio = m.file; soundKey = m.key; said.push(`${m.cues} sound effect${m.cues === 1 ? "" : "s"}${music ? " and a music bed" : ""}`); }
        } catch (e) {
          if (e instanceof CancelledError || o.signal.aborted) throw e instanceof CancelledError ? e : new CancelledError();
          said.push("the sound effects couldn't be made, so the video has the voice only");
        }
      }
      const extra = [...(audio ? SOUND_CREDITS(music, effects) : []), "Narration: a synthetic voice made on this computer.", "Fonts: Montserrat and JetBrains Mono (SIL Open Font License 1.1)."];
      writeCreditFiles(i.root, i.abs, creditsMarkdown(credits, extra));
      return { media, audio, motion, key: sha256(mediaKey, soundKey, motion), said: said.join(". ") };
    },
    summary(out: MediaStageOutput): string {
      const s = out.said || "No pictures or sound to add";
      return s.charAt(0).toUpperCase() + s.slice(1);
    },
  };
}

/** credits.md, and the Credits section of notes.md when the video has notes. Never follows a link. */
function writeCreditFiles(root: string, abs: string, md: string): void {
  const safe = (p: string) => { if (!insideRoot(root, p)) return false; try { return !fs.lstatSync(p).isSymbolicLink(); } catch { return true; } };
  const credits = path.join(abs, "credits.md");
  if (safe(credits)) writeFileAtomic(credits, `# Credits\n\n${md}\n`);
  const notes = path.join(abs, "notes.md");
  try {
    const st = fs.lstatSync(notes);
    if (st.isFile() && st.size < 512 * 1024 && safe(notes)) writeFileAtomic(notes, withCredits(fs.readFileSync(notes, "utf8"), md));
  } catch { /* no notes for this type */ }
}
