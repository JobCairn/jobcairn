#!/usr/bin/env python3
"""JobCairn narration: script text -> narration.wav + timing JSON.

Engines: Supertonic 3 (on-device, default) with macOS `say` as the fallback.
The voice comes from the user's settings: <workspace>/settings/integrations.json, key "voice".
Default when nothing is chosen yet: F4 (female); M3 is the recommended male voice. Once the
user has picked a voice, that choice always wins over the default.

Usage:
  narrate.py --workspace WS --type guide --text-file script.txt --out narration.wav
  narrate.py --text-file script.txt --voice M2 --lang en --out narration.wav   (explicit override)
  narrate.py --preview --out-dir DIR [--lang en] [--voices F4,M3] [--nice 10]  (one sample per preset voice)
  narrate.py --serve --no-download                                              (warm worker, JSON lines on stdin)

Script format: paragraphs separated by blank lines. Lines starting with "#" are ignored.
A paragraph that is only "[pause N]" inserts N seconds of silence (think time in drills).
Expression tags <laugh> <breath> <sigh> are kept for Supertonic when settings allow them,
and stripped otherwise (always stripped for `say`).

Run with the JobCairn venv: $HOME/.careeros/venv/bin/python narrate.py ...
Needs ffmpeg on PATH. Writes <out>.timing.json unless --timing is given.
Network: with --no-download, or when HF_HUB_OFFLINE=1 is set (the app always sets it for read aloud), the model
is never downloaded; a missing model counts as "Supertonic unavailable". `--check` says whether the model is on
this computer (no network); `--download` fetches it (the app runs that only from an explicit Setup click).
Exit codes: 0 ok, 2 bad input or settings, 3 engine unavailable, 4 synthesis failed, 5 model not downloaded.

--serve keeps the model loaded between paragraphs (the app uses it for read aloud). It prints
{"event": "ready", "engine": ...} once, then reads one JSON job per line on stdin:
  {"id": "j1", "op": "speak", "text": "...", "out": "/tmp/x.wav", "voice": "F4", "lang": "en"}
and answers each with one line: {"id": "j1", "ok": true, "engine": ..., "fell_back": ...} or
{"id": "j1", "ok": false, "code": 4, "error": "..."}. It exits when stdin closes or on {"op": "quit"}.
Only these protocol lines go to stdout; everything else (library chatter, warnings) goes to stderr.
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import wave

PRESETS = ["F1", "F2", "F3", "F4", "F5", "M1", "M2", "M3", "M4", "M5"]
DEFAULT_VOICE = "F4"  # owner decision: default narration voice (female); M3 is the recommended male voice
RECOMMENDED_MALE_VOICE = "M3"
# --preview samples the default and recommended voices first, then the rest of PRESETS.
PREVIEW_ORDER = [DEFAULT_VOICE, RECOMMENDED_MALE_VOICE] + [
    v for v in PRESETS if v not in (DEFAULT_VOICE, RECOMMENDED_MALE_VOICE)
]
TAGS = re.compile(r"\s*<(laugh|breath|sigh)>\s*", re.I)
PAUSE = re.compile(r"^\[pause\s+(\d+(?:\.\d+)?)\]$", re.I)
RATE = 44100
PREVIEW_TEXT = ("Hi, I'm your study voice. Let's walk through this topic together, "
                "one step at a time.")


def may_download():
    """False when the caller asked for no network: --no-download or HF_HUB_OFFLINE=1."""
    return not (NO_DOWNLOAD or os.environ.get("HF_HUB_OFFLINE") == "1")


NO_DOWNLOAD = False


def die(code, msg):
    print(f"narrate: {msg}", file=sys.stderr)
    sys.exit(code)


def load_settings(workspace, vtype):
    """Resolve engine, voice, lang and expressions from settings/integrations.json."""
    if not workspace:
        return {}
    path = os.path.join(workspace, "settings", "integrations.json")
    if not os.path.exists(path):
        return {}
    try:
        with open(path, encoding="utf-8") as f:
            v = (json.load(f) or {}).get("voice") or {}
    except (OSError, json.JSONDecodeError) as e:
        die(2, f"cannot read {path}: {e}")
    per = (v.get("per_type") or {}).get(vtype or "", "") if vtype else ""
    return {
        "engine": v.get("engine") or "supertonic",
        "voice": per or v.get("voice") or "",
        "lang": v.get("lang") or "en",
        "expressions": bool(v.get("expressions", True)),
    }


def read_blocks(path):
    """Return a list of ("speak", text) and ("pause", seconds) blocks."""
    with open(path, encoding="utf-8") as f:
        raw = f.read()
    blocks = []
    for para in re.split(r"\n\s*\n", raw):
        lines = [ln.strip() for ln in para.splitlines() if ln.strip() and not ln.strip().startswith("#")]
        if not lines:
            continue
        text = " ".join(lines)
        m = PAUSE.match(text)
        blocks.append(("pause", float(m.group(1))) if m else ("speak", text))
    if not any(k == "speak" for k, _ in blocks):
        die(2, f"no spoken paragraphs in {path}")
    return blocks


def strip_tags(text):
    return re.sub(r"\s{2,}", " ", TAGS.sub(" ", text)).strip()


def ffmpeg_to_pcm(src, dst):
    """Any audio file -> 44.1 kHz mono 16-bit PCM WAV."""
    r = subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", src, "-ac", "1", "-ar", str(RATE),
                        "-c:a", "pcm_s16le", dst], capture_output=True, text=True)
    if r.returncode != 0:
        die(4, f"ffmpeg failed on {src}: {r.stderr.strip()}")


_TTS = None
_STYLES = {}


def get_tts():
    """The Supertonic engine, loaded once per process (a --serve worker reuses it for every paragraph)."""
    global _TTS
    if _TTS is None:
        from supertonic import TTS  # noqa: import inside so the fallback works without it
        _TTS = TTS(auto_download=may_download())
    return _TTS


def get_style(voice):
    if voice not in _STYLES:
        _STYLES[voice] = get_tts().get_voice_style(voice_name=voice)
    return _STYLES[voice]


class Supertonic:
    name = "supertonic"

    def __init__(self, voice):
        self.tts = get_tts()
        self.style = get_style(voice)

    def say(self, text, lang, dst):
        wav, _dur = self.tts.synthesize(text, voice_style=self.style, lang=lang)
        self.tts.save_audio(wav, dst)


class MacSay:
    name = "macos_say"

    def __init__(self, voice):
        if not shutil.which("say"):
            die(3, "macOS `say` not found and Supertonic is unavailable")
        # Supertonic preset names mean nothing to `say`; use the system voice for those.
        self.voice = None if (not voice or voice in PRESETS) else voice

    def say(self, text, lang, dst):
        tmp = dst + ".txt"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(text)
        cmd = ["say", "-o", dst, "-f", tmp] + (["-v", self.voice] if self.voice else [])
        r = subprocess.run(cmd, capture_output=True, text=True)
        os.remove(tmp)
        if r.returncode != 0:
            die(4, f"`say` failed: {r.stderr.strip()}")


def make_engine(engine, voice):
    """Return (engine, fell_back). Falls back to `say` only if Supertonic cannot load."""
    if engine == "elevenlabs":
        die(3, "ElevenLabs is an optional engine this script does not run. Ask the user to "
               "switch the video voice to Supertonic or macOS say in Settings, or pass --engine.")
    if engine == "macos_say":
        return MacSay(voice), False
    try:
        return Supertonic(voice), False
    except Exception as e:  # ImportError, model download or voice errors
        print(f"narrate: WARNING Supertonic unavailable ({e}). Falling back to macOS say. "
              "Tell the user the voice changed for this video.", file=sys.stderr)
        return MacSay(voice), True


def pcm_frames(path):
    with wave.open(path, "rb") as w:
        return w.readframes(w.getnframes())


def silence(seconds):
    return b"\x00\x00" * int(round(seconds * RATE))


def estimate_words(text, start, end):
    """Spread a paragraph's words over its span by character length (rough, for fallback captions)."""
    words = text.split()
    total = sum(len(w) + 1 for w in words) or 1
    span, t, out = max(0.0, end - start), start, []
    for w in words:
        d = span * (len(w) + 1) / total
        out.append({"text": w, "start": round(t, 3), "end": round(t + d * 0.92, 3)})
        t += d
    return out


CACHE_VERSION = "narrate-paragraph-v1"


def paragraph_key(engine_name, voice, lang, keep_tags, spoken):
    """Cache key for one paragraph's audio: everything that changes how it sounds, plus a version salt."""
    h = hashlib.sha256()
    for part in (CACHE_VERSION, engine_name, voice or "", lang, "tags" if keep_tags else "plain", spoken):
        h.update(part.encode("utf-8"))
        h.update(b"\0")
    return h.hexdigest()


def cache_put(cache_dir, key, src):
    """Copy a paragraph's normalised PCM into the cache, atomically (a half-written file is never read)."""
    tmp = os.path.join(cache_dir, f".{key}.tmp")
    shutil.copyfile(src, tmp)
    os.replace(tmp, os.path.join(cache_dir, key + ".wav"))


def cache_prune(cache_dir, keep):
    """Drop cached paragraphs this script no longer uses, so the cache stays about one narration's size."""
    for name in os.listdir(cache_dir):
        if name.endswith(".wav") and name[:-4] not in keep:
            try:
                os.remove(os.path.join(cache_dir, name))
            except OSError:
                pass


def narrate(args):
    cfg = load_settings(args.workspace, args.type)
    voice = args.voice or cfg.get("voice")
    used_default_voice = False
    if not voice and (args.engine or cfg.get("engine", "supertonic")) == "supertonic":
        # No voice chosen yet (fresh workspace): fall back to the house default, don't block.
        # Once the user has chosen a voice (settings or --voice), always honor that instead.
        voice = DEFAULT_VOICE
        used_default_voice = True
        print(f"narrate: no voice chosen yet, using default {DEFAULT_VOICE}. Ask the user to "
              "pick one in Settings > Video if they want something else.", file=sys.stderr)
    lang = args.lang or cfg.get("lang") or "en"
    expressions = cfg.get("expressions", True) if args.expressions is None else args.expressions
    requested = args.engine or cfg.get("engine", "supertonic")
    blocks = read_blocks(args.text_file)
    cache_dir = args.cache_dir
    if cache_dir:
        os.makedirs(cache_dir, exist_ok=True)

    def keys_for(engine_name):
        tags = expressions and engine_name == "supertonic"
        return [paragraph_key(engine_name, voice, lang, tags, val if tags else strip_tags(val)) if kind == "speak" else None
                for kind, val in blocks]

    def cached(key):
        return bool(cache_dir and key and os.path.isfile(os.path.join(cache_dir, key + ".wav")))

    # With every paragraph already in the cache the engine (and its model) is never loaded.
    keys = keys_for(requested) if requested in ("supertonic", "macos_say") else None
    if keys is not None and all(cached(k) for k in keys if k):
        engine, fell_back = None, False
        engine_name = requested
    else:
        engine, fell_back = make_engine(requested, voice)
        engine_name = engine.name
        keys = keys_for(engine_name)
    keep_tags = expressions and engine_name == "supertonic"
    reused = made = 0

    pcm, t = bytearray(silence(args.lead)), args.lead
    paragraphs, words = [], []
    with tempfile.TemporaryDirectory() as tmp:
        for i, (kind, val) in enumerate(blocks):
            if kind == "pause":
                pcm += silence(val)
                t += val
                continue
            spoken = val if keep_tags else strip_tags(val)
            key = keys[i]
            if cached(key):
                frames = pcm_frames(os.path.join(cache_dir, key + ".wav"))
                reused += 1
            else:
                raw = os.path.join(tmp, f"p{i}.{'aiff' if engine_name == 'macos_say' else 'wav'}")
                norm = os.path.join(tmp, f"p{i}_n.wav")
                try:
                    engine.say(spoken, lang, raw)
                except SystemExit:
                    raise
                except Exception as e:
                    die(4, f"synthesis failed on paragraph {len(paragraphs) + 1}: {e}")
                ffmpeg_to_pcm(raw, norm)
                frames = pcm_frames(norm)
                made += 1
                if cache_dir:
                    cache_put(cache_dir, key, norm)
            dur = len(frames) / 2 / RATE
            if paragraphs:  # gap between spoken paragraphs
                pcm += silence(args.gap)
                t += args.gap
            start, end = t, t + dur
            pcm += frames
            t = end
            clean = strip_tags(val)
            paragraphs.append({"index": len(paragraphs), "text": clean,
                               "start": round(start, 3), "end": round(end, 3)})
            words += estimate_words(clean, start, end)
    pcm += silence(args.tail)
    total = round(t + args.tail, 2)
    if cache_dir:
        cache_prune(cache_dir, {k for k in keys if k})
        print(f"narrate: {made} paragraph(s) made, {reused} reused", file=sys.stderr)

    out = os.path.abspath(args.out)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    joined = out + ".joined.wav"
    with wave.open(joined, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(bytes(pcm))
    if args.no_normalize:
        os.replace(joined, out)
    else:  # speech loudness target for laptop speakers; duration is unchanged
        r = subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", joined, "-af",
                            "loudnorm=I=-16:TP=-1.5:LRA=11", "-ar", str(RATE), "-ac", "1",
                            "-c:a", "pcm_s16le", out], capture_output=True, text=True)
        os.remove(joined)
        if r.returncode != 0:
            die(4, f"ffmpeg loudnorm failed: {r.stderr.strip()}")

    # Default scene plan: one scene per spoken paragraph. Scene N+1 starts in the gap before
    # its paragraph; scene N stays mounted `transition` seconds longer so the seam can play.
    starts = [0.0] + [max(0.0, p["start"] - args.gap / 2) for p in paragraphs[1:]]
    scenes = []
    for i, s in enumerate(starts):
        e = starts[i + 1] + args.transition if i + 1 < len(starts) else total
        scenes.append({"index": i, "start": round(s, 2), "duration": round(min(e, total) - s, 2)})

    timing = {
        "audio": os.path.basename(out), "engine": engine_name, "voice": voice if engine_name == "supertonic" else "system",
        "paragraphs_made": made, "paragraphs_reused": reused,
        "used_default_voice": used_default_voice,
        "fell_back": fell_back, "lang": lang, "expressions": keep_tags,
        "lead": args.lead, "gap": args.gap, "tail": args.tail, "transition": args.transition,
        "total": total, "paragraphs": paragraphs, "scenes": scenes,
        "words_estimated": words,
    }
    tpath = args.timing or os.path.splitext(out)[0] + ".timing.json"
    with open(tpath, "w", encoding="utf-8") as f:
        json.dump(timing, f, indent=2)
    return {"ok": True, "audio": out, "timing": tpath, "total": total,
            "engine": engine_name, "voice": timing["voice"], "fell_back": fell_back}


def preview(args):
    """One short sample per preset voice so the settings screen can play them.

    Generates the default voice and the recommended male voice first
    (DEFAULT_VOICE, RECOMMENDED_MALE_VOICE), then the rest of PRESETS, so the
    settings screen can show/play those two as soon as they're ready.
    """
    order = PREVIEW_ORDER
    if args.voices:
        wanted = [v.strip() for v in args.voices.split(",") if v.strip()]
        bad = [v for v in wanted if v not in PRESETS]
        if bad:
            die(2, f"unknown preview voice(s): {', '.join(bad)}")
        order = [v for v in PREVIEW_ORDER if v in wanted]
    try:
        tts = get_tts()
    except ImportError as e:
        die(3, f"Supertonic is not installed in this Python ({e}); previews need it")
    os.makedirs(args.out_dir, exist_ok=True)
    text = args.preview_text or PREVIEW_TEXT
    made = []
    with tempfile.TemporaryDirectory() as tmp:
        for v in order:
            try:
                wav, _ = tts.synthesize(text, voice_style=get_style(v), lang=args.lang or "en")
                raw = os.path.join(tmp, f"{v}.wav")
                tts.save_audio(wav, raw)
                # Written next to the target, then renamed: a sample killed half-way never leaves a broken file.
                part = os.path.join(args.out_dir, f".{v}.wav.part")
                ffmpeg_to_pcm(raw, part)
                os.replace(part, os.path.join(args.out_dir, f"{v}.wav"))
                made.append({"voice": v, "file": f"{v}.wav"})
            except SystemExit:
                raise
            except Exception as e:
                print(f"narrate: preview for {v} failed: {e}", file=sys.stderr)
    index = os.path.join(args.out_dir, "voices.json")
    known = {}
    try:
        with open(index, encoding="utf-8") as f:
            old = json.load(f) or {}
        if old.get("text") == text and old.get("lang") == (args.lang or "en"):
            known = {m["voice"]: m for m in old.get("voices", []) if isinstance(m, dict) and m.get("voice") in PRESETS}
    except (OSError, ValueError, AttributeError, TypeError):
        known = {}
    known.update({m["voice"]: m for m in made})
    with open(index, "w", encoding="utf-8") as f:
        json.dump({"text": text, "lang": args.lang or "en",
                   "voices": [known[v] for v in PREVIEW_ORDER if v in known]}, f, indent=2)
    print(json.dumps({"ok": bool(made), "out_dir": args.out_dir, "voices": [m["voice"] for m in made]}))
    if not made:
        sys.exit(4)


def serve(args):
    """Warm worker for read aloud: loads the model once, then speaks one JSON job per stdin line."""
    proto = sys.stdout
    sys.stdout = sys.stderr  # library chatter must never corrupt the protocol

    def reply(obj):
        proto.write(json.dumps(obj) + "\n")
        proto.flush()

    engine_name, fell_back = "macos_say", False
    if (args.engine or "supertonic") == "supertonic":
        try:
            get_tts()
            engine_name = "supertonic"
        except Exception as e:  # ImportError, a missing model: jobs use `say` instead
            print(f"narrate: WARNING Supertonic unavailable ({e}). Serving with macOS say.", file=sys.stderr)
            fell_back = True
    reply({"event": "ready", "engine": engine_name, "fell_back": fell_back})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            job = json.loads(line)
        except ValueError:
            reply({"id": None, "ok": False, "code": 2, "error": "bad job line"})
            continue
        if not isinstance(job, dict):
            reply({"id": None, "ok": False, "code": 2, "error": "bad job line"})
            continue
        jid = job.get("id")
        op = job.get("op")
        if op == "quit":
            break
        if op != "speak":
            reply({"id": jid, "ok": False, "code": 2, "error": f"unknown op {op!r}"})
            continue
        text, out = job.get("text"), job.get("out")
        if not isinstance(text, str) or not text.strip() or not isinstance(out, str) or not out:
            reply({"id": jid, "ok": False, "code": 2, "error": "a job needs text and out"})
            continue
        try:
            with tempfile.TemporaryDirectory() as tmp:
                tf = os.path.join(tmp, "text.txt")
                with open(tf, "w", encoding="utf-8") as f:
                    f.write(text.replace("\n", " ") + "\n")
                ns = argparse.Namespace(
                    workspace=None, type=None, text_file=tf, out=out, timing=os.path.join(tmp, "timing.json"),
                    voice=job.get("voice") or None, lang=job.get("lang") or None,
                    engine=None if engine_name == "supertonic" else "macos_say", expressions=False,
                    lead=float(job.get("lead", 0)), gap=float(job.get("gap", 0)), tail=float(job.get("tail", 0.25)),
                    transition=0.6, no_normalize=False)
                r = narrate(ns)
            reply({"id": jid, "ok": True, "engine": r["engine"], "fell_back": bool(r["fell_back"] or fell_back)})
        except SystemExit as e:  # die(): a plain message is already on stderr
            reply({"id": jid, "ok": False, "code": e.code if isinstance(e.code, int) else 4, "error": "synthesis failed"})
        except Exception as e:
            reply({"id": jid, "ok": False, "code": 4, "error": str(e)[:200]})


def check():
    """Is the model on this computer? Loads it with downloads off; never touches the network."""
    try:
        from supertonic import TTS
    except Exception as e:
        die(3, f"Supertonic is not installed in this Python ({e})")
    try:
        TTS(auto_download=False)
    except Exception as e:
        die(5, f"the Supertonic model isn't on this computer ({e})")
    print(json.dumps({"ok": True, "model": "present"}))


def download():
    """Fetches the model. Network; run only when the user asked for it."""
    try:
        from supertonic import TTS
    except Exception as e:
        die(3, f"Supertonic is not installed in this Python ({e})")
    try:
        TTS(auto_download=True)
    except Exception as e:
        die(4, f"the Supertonic model couldn't be downloaded ({e})")
    print(json.dumps({"ok": True, "model": "downloaded"}))


def main():
    global NO_DOWNLOAD
    p = argparse.ArgumentParser(description="JobCairn narration (Supertonic 3, fallback macOS say)")
    p.add_argument("--workspace", help="candidate workspace (reads settings/integrations.json)")
    p.add_argument("--type", choices=["guide", "interview", "slides"], help="video type for per_type voice")
    p.add_argument("--text-file", help="script: paragraphs separated by blank lines")
    p.add_argument("--out", default="narration.wav")
    p.add_argument("--timing", help="timing JSON path (default <out>.timing.json)")
    p.add_argument("--voice", help="override: F1-F5, M1-M5 (or a `say` voice name); default F4")
    p.add_argument("--lang", help="override language code, e.g. en")
    p.add_argument("--engine", choices=["supertonic", "macos_say"], help="override engine")
    p.add_argument("--expressions", dest="expressions", action="store_true", default=None)
    p.add_argument("--no-expressions", dest="expressions", action="store_false", default=None)
    p.add_argument("--lead", type=float, default=0.5, help="silence before the first word (s)")
    p.add_argument("--gap", type=float, default=0.45, help="silence between paragraphs (s)")
    p.add_argument("--tail", type=float, default=1.0, help="silence after the last word (s)")
    p.add_argument("--transition", type=float, default=0.6, help="scene seam overlap (s)")
    p.add_argument("--no-normalize", action="store_true", help="skip loudness normalisation")
    p.add_argument("--cache-dir", help="keep each paragraph's audio here and reuse it when the paragraph is unchanged")
    p.add_argument("--preview", action="store_true", help="write one sample WAV per preset voice")
    p.add_argument("--out-dir", help="folder for --preview samples")
    p.add_argument("--preview-text", help="sentence for --preview")
    p.add_argument("--voices", help="--preview only these voices, comma separated (default: all presets)")
    p.add_argument("--nice", type=int, default=0, help="run at a lower CPU priority (0-19), for background work")
    p.add_argument("--serve", action="store_true", help="warm worker: read JSON jobs on stdin (see the docstring)")
    p.add_argument("--no-download", action="store_true", help="never download the model (also: HF_HUB_OFFLINE=1)")
    p.add_argument("--check", action="store_true", help="exit 0 if the model is on this computer, 5 if not; no network")
    p.add_argument("--download", action="store_true", help="download the model (network)")
    args = p.parse_args()
    NO_DOWNLOAD = args.no_download
    if args.nice > 0:
        try:
            os.nice(min(19, args.nice))
        except (AttributeError, OSError):
            pass
    if args.check:
        return check()
    if args.download:
        return download()

    if not shutil.which("ffmpeg"):
        die(3, "ffmpeg not found on PATH")
    if args.serve:
        return serve(args)
    if args.preview:
        if not args.out_dir:
            die(2, "--preview needs --out-dir")
        return preview(args)
    if not args.text_file or not os.path.exists(args.text_file):
        die(2, "--text-file is required and must exist")
    print(json.dumps(narrate(args)))


if __name__ == "__main__":
    main()
