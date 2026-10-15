import { useRef, useState } from "react";
import { Button, Card, Checkbox, Dialog, Pill, Select, Text, useToast, SectionTitle, Icons } from "@careeros/brand";
import {
  langLabel, READ_ALOUD_SPEEDS, TTS_VOICES, voiceLabel, voiceTag, VOICE_INFO, type SettingsChange, type TtsPreviewVoice, type TtsStatus, type TtsVoice,
} from "@careeros/contract";
import { errorText, useAction, useBridge, useLoad } from "../bridge-context";
import { errorSentence } from "../components/ErrorBanner";
import { ErrorState, Loading } from "../components/States";
import { useListenPlayer, type AudioLike } from "./context";
import { Pause, Play } from "./icons";
import { speedLabel } from "./PlayerBar";
import { readAloudFrom } from "./PlayerProvider";
import { ToolInstall } from "../components/ToolInstall";

const VOICE_TOOLS = ["python", "ffmpeg"] as const;

/** The engine's hint says "in Settings > Voice" for other screens; here the install rows are right below it. */
export function hereHint(hint: string): string {
  return hint.replace(/ in Settings > Voice/g, " below");
}

const ENGINE_TONE: Record<TtsStatus["engine"], "success" | "warning" | "danger"> = { supertonic: "success", macos_say: "warning", none: "danger" };
const ENGINE_PILL: Record<TtsStatus["engine"], string> = { supertonic: "Supertonic ready", macos_say: "Using the macOS voice", none: "Not installed" };
const VIDEO_ENGINES: [string, string][] = [["supertonic", "Supertonic (on your Mac, free)"], ["macos_say", "Mac built-in voice"], ["elevenlabs", "ElevenLabs (needs your API key)"]];
const VOICE_OPTIONS = TTS_VOICES.map((v) => { const tag = voiceTag(v); return { value: v, label: tag ? `${voiceLabel(v)} (${tag})` : voiceLabel(v) }; });
// Supertonic 3 has a single expressions switch, and it only acts on <laugh>/<breath>/<sigh> marks in a video
// script. Documents don't carry them, so reading aloud doesn't show it (owner decision, 2026-10-10). No emotion presets:
// the engine has none. An engine with styles (for example ElevenLabs, if set up later) would add its own control.
const EXPRESSIONS_HELP = "Supertonic 3 has one expression setting: on or off. On keeps the breaths, light laughs and sighs a video script marks. It has no emotion styles such as calm or excited.";

/** The engine's languages as options, keeping a saved value that isn't in the list so it still shows. */
function langOptions(languages: string[], current: string) {
  const list = languages.includes(current) ? languages : [...languages, current];
  return list.map((l) => ({ value: l, label: langLabel(l) }));
}

function usePreviewAudio() {
  const player = useListenPlayer();
  const ref = useRef<AudioLike | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const play = (v: Pick<TtsPreviewVoice, "voice" | "url">) => {
    if (!v.url) return;
    if (!ref.current) {
      ref.current = player?.createAudio() ?? (new Audio() as AudioLike);
      ref.current.addEventListener("ended", () => setPlaying(null));
      ref.current.addEventListener("error", () => setPlaying(null));
    }
    const a = ref.current;
    if (playing === v.voice) { a.pause(); setPlaying(null); return; }
    a.src = v.url;
    setPlaying(v.voice);
    Promise.resolve(a.play()).catch(() => setPlaying(null));
  };
  return { playing, play };
}

export function VoiceSettings() {
  const bridge = useBridge();
  const toast = useToast();
  const { busy, run } = useAction();
  const settings = useLoad((b) => b.settings.get("integrations"), [], ["settings"]);
  const status = useLoad((b) => b.tts.status(), [], []);
  const previews = useLoad((b) => b.tts.previews(), [], ["settings"]);
  const preview = usePreviewAudio();
  const [confirmInstall, setConfirmInstall] = useState(false);
  /** The voice whose sample is being made right now (made on demand, one at a time). */
  const [making, setMaking] = useState<string | null>(null);

  if (settings.error && !settings.data) return <ErrorState title="Voice settings can't be shown" text={errorSentence(settings.error)} />;
  if (!settings.data) return <Loading />;
  const values = settings.data.values;
  const ra = readAloudFrom(values);
  const video = (values.voice ?? {}) as { engine?: string; voice?: string; lang?: string; expressions?: boolean };
  const save = (changes: SettingsChange[]) => run("voice-save", async () => { await bridge.settings.save("integrations", changes); });
  // A sample is made only when its Preview is pressed, then played. Read aloud always goes first.
  const sample = async (v: TtsVoice) => {
    setMaking(v);
    try {
      const r = await bridge.tts.previewVoice(v, ra.lang);
      previews.reload();
      const made = r.voices.find((x) => x.voice === v);
      if (made?.url) preview.play(made);
    } catch (e) {
      toast({ tone: "danger", text: errorText(e) });
    } finally { setMaking(null); }
  };
  const download = () => run("voice-download", async () => {
    await bridge.tts.downloadVoice();
    status.reload();
  }, "The Supertonic voice is ready");
  const install = () => run("voice-install", async () => {
    await bridge.tts.installVoice();
    status.reload();
  }, "The voice engine is installed");
  const stopWork = async () => { try { await bridge.tts.stopVoiceWork(); } catch (e) { toast({ tone: "danger", text: errorText(e) }); } };
  const clear = () => run("voice-clear", async () => {
    const n = await bridge.tts.clearCache();
    toast({ tone: "success", text: n ? `Removed ${n} saved recording${n === 1 ? "" : "s"}` : "Nothing was saved" });
  });
  const st = status.data;
  const pv = previews.data;
  const urlFor = (v: string) => pv?.voices.find((x) => x.voice === v) ?? null;
  const languages = st?.languages ?? ["en"];
  const langNote = st?.languagesNote ? <Text role="body-sm" muted>{st.languagesNote}</Text> : null;

  return (
    <div className="stack">
      <Card className="stack">
        <SectionTitle icon={Icons.listen} title="Voice engine" />
        {status.loading && !st ? <Text role="body" muted>Checking the voice on this Mac…</Text> : st ? (
          <div className="voice-status">
            <Pill tone={ENGINE_TONE[st.engine]}>{ENGINE_PILL[st.engine]}</Pill>
            <div className="stack">
              <Text role="body">{st.text}</Text>
              {st.hint ? <Text role="body-sm" muted>{hereHint(st.hint)}</Text> : null}
            </div>
          </div>
        ) : <Text role="body" muted>The voice couldn&apos;t be checked. {status.error}</Text>}
        <ToolInstall ids={VOICE_TOOLS} onInstalled={status.reload} intro="The voice needs these on this Mac:" />
        {st?.needsDownload ? (
          <div className="stack">
            <Text role="body-sm" muted>The voice model is downloaded once, from the internet, only when you press the button. After that it reads offline.</Text>
            <div className="row">
              <Button size="sm" variant="primary" loading={busy === "voice-download"} title="Download the Supertonic voice" onClick={() => void download()}>Download voice</Button>
              {busy === "voice-download" ? <Button size="sm" variant="ghost" onClick={() => void stopWork()}>Stop</Button> : null}
            </div>
          </div>
        ) : null}
        {st?.needsInstall ? (
          <div className="stack">
            <Text role="body-sm" muted>Installs the voice engine (about 200 MB) once, into its own folder. It runs only on this computer, never in the cloud.</Text>
            <div className="row">
              <Button size="sm" variant="primary" loading={busy === "voice-install"} title="Set up the natural voice" onClick={() => setConfirmInstall(true)}>Install voice…</Button>
              {busy === "voice-install" ? <Button size="sm" variant="ghost" onClick={() => void stopWork()}>Stop</Button> : null}
            </div>
          </div>
        ) : null}
        <Text role="body-sm" muted>Everything is spoken on this computer. A locked folder is read aloud only while you&apos;ve unlocked it, and that audio is deleted when it locks again.</Text>
      </Card>
      <Dialog open={confirmInstall} onClose={() => setConfirmInstall(false)} title="Set up the natural voice?"
        actions={<>
          <Button variant="ghost" onClick={() => setConfirmInstall(false)}>Cancel</Button>
          <Button variant="primary" loading={busy === "voice-install"} onClick={() => { setConfirmInstall(false); void install(); }}>Set up</Button>
        </>}>
        <Text role="body">This installs the voice engine (about 200 MB) into its own folder on this Mac. It runs only here, never in the cloud.</Text>
      </Dialog>

      <Card className="stack" aria-label="Reading aloud">
        <SectionTitle icon={Icons.guide} title="Reading aloud" />
        <Text role="body-sm" muted>Used by the Listen button on jobs, company research, guides and application documents.</Text>
        <fieldset className="stack">
          <legend className="field__label">Voice</legend>
          <ul className="voice-list">
            {TTS_VOICES.map((v) => {
              const p = urlFor(v);
              const info = VOICE_INFO[v];
              const tag = voiceTag(v);
              const accessibleLabel = tag ? `${voiceLabel(v)} (${tag})` : voiceLabel(v);
              return (
                <li key={v} className="voice-list__item">
                  <label>
                    <input type="radio" name="read-aloud-voice" value={v} checked={ra.voice === v} aria-label={accessibleLabel}
                      onChange={() => void save([{ path: "read_aloud.voice", value: v }])} />
                    <span className="voice-list__info">
                      <span className="voice-list__name-row">
                        <Text role="body" as="span" className="t-strong">{info.name}</Text>
                        {tag ? <Pill tone={tag === "Default" ? "accent" : "neutral"}>{tag}</Pill> : null}
                      </span>
                      <Text role="body-sm" as="span" muted>{info.style}</Text>
                    </span>
                  </label>
                  {p?.url ? (
                    <Button size="sm" variant="ghost" icon={preview.playing === v ? Pause : Play} aria-label={`${preview.playing === v ? "Stop preview of" : "Preview"} ${voiceLabel(v)}`}
                      onClick={() => preview.play(p)}>{preview.playing === v ? "Stop" : "Preview"}</Button>
                  ) : st?.engine === "supertonic" ? (
                    <Button size="sm" variant="ghost" icon={Play} loading={making === v} disabled={!!making && making !== v}
                      title={making && making !== v ? "Another sample is being made. One at a time keeps the Mac quick." : undefined}
                      aria-label={making === v ? `Making a sample of ${voiceLabel(v)}` : `Preview ${voiceLabel(v)}`}
                      onClick={() => void sample(v)}>{making === v ? "Making sample…" : "Preview"}</Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {pv && pv.missing > 0 ? (
            <Text role="body-sm" muted>
              {st?.engine === "supertonic"
                ? "A voice's sample is made the first time you press its Preview. That takes a few seconds, then it plays at once."
                : "Samples need the Supertonic voice, which isn't set up yet."}
            </Text>
          ) : null}
        </fieldset>
        <div className="row row--top">
          <Select label="Default speed" value={String(ra.speed)} onChange={(e) => void save([{ path: "read_aloud.speed", value: Number(e.target.value) }])}
            options={READ_ALOUD_SPEEDS.map((s) => ({ value: String(s), label: speedLabel(s) }))} help="You can change it while listening too." />
          <Select label="Language" value={ra.lang} onChange={(e) => void save([{ path: "read_aloud.lang", value: e.target.value }])} options={langOptions(languages, ra.lang)} />
        </div>
        {langNote}
        <div className="voice-cache">
          <Text role="body-sm" muted>Each paragraph is saved after it is first read, so it plays at once next time. The app keeps up to 200 MB and removes the oldest first.</Text>
          <div><Button size="sm" loading={busy === "voice-clear"} onClick={() => void clear()}>Delete recordings</Button></div>
        </div>
      </Card>

      <Card className="stack" aria-label="Videos">
        <SectionTitle icon={Icons.video} title="Videos" />
        <Text role="body-sm" muted>Used when Claude makes learning guides, interview prep and recap videos.</Text>
        <div className="row row--top">
          <Select label="Voice engine" value={video.engine ?? "supertonic"} onChange={(e) => void save([{ path: "voice.engine", value: e.target.value }])}
            options={VIDEO_ENGINES.map(([value, label]) => ({ value, label }))} />
          <Select label="Voice" value={video.voice ?? "F4"} onChange={(e) => void save([{ path: "voice.voice", value: e.target.value }])} options={VOICE_OPTIONS} />
          <Select label="Language" value={video.lang ?? "en"} onChange={(e) => void save([{ path: "voice.lang", value: e.target.value }])}
            options={langOptions(languages, video.lang ?? "en")} />
        </div>
        {langNote}
        <Checkbox label="Expressions" checked={video.expressions ?? true} help={EXPRESSIONS_HELP}
          onChange={(e) => void save([{ path: "voice.expressions", value: e.target.checked }])} />
      </Card>
      {settings.error ? <Text role="body-sm" muted>{errorText(settings.error)}</Text> : null}
    </div>
  );
}
