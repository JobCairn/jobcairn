import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { serveMediaFile } from "../src/media.js";
import { ttsUrlToName } from "../src/tts-media.js";

const HASH = "a".repeat(64);

describe("careeros-file://tts/ names", () => {
  it("accepts only a cache hash or a preset preview", () => {
    expect(ttsUrlToName(`careeros-file://tts/${HASH}.wav`)).toBe(`${HASH}.wav`);
    expect(ttsUrlToName("careeros-file://tts/preview-M3.wav")).toBe("preview-M3.wav");
    expect(ttsUrlToName(`careeros-file://tts/private-${HASH}.wav`)).toBe(`private-${HASH}.wav`); // the services check the grant
    expect(ttsUrlToName(`careeros-file://tts/private-${HASH}.mp3`)).toBeNull();
  });
  it("refuses everything else", () => {
    for (const url of [
      `careeros-file://ws/${HASH}.wav`, `careeros-file://tts/x/${HASH}.wav`, `careeros-file://tts/${HASH}.wav?x=1`, `careeros-file://tts/${HASH}.wav#t`,
      `careeros-file://tts/..%2F${HASH}.wav`, `careeros-file://tts/%2E%2E/workspace.json`, "careeros-file://tts/preview-F9.wav", "careeros-file://tts/preview-F4.mp3",
      `careeros-file://alex@tts/${HASH}.wav`, `careeros-file://tts:1/${HASH}.wav`, "careeros-file://tts/", "not a url", `careeros-file://tts/${HASH.toUpperCase()}.wav`,
    ]) expect(ttsUrlToName(url), url).toBeNull();
  });
  it("serves audio with the content type the caller names", async () => {
    const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "careeros-tts-media-")));
    const file = path.join(dir, `${HASH}.wav`);
    fs.writeFileSync(file, "RIFFdata");
    const st = fs.statSync(file);
    const r = serveMediaFile({ real: file, dev: st.dev, ino: st.ino }, null, "audio/wav");
    expect(r.status).toBe(200);
    expect(r.headers.get("Content-Type")).toBe("audio/wav");
    expect(await r.text()).toBe("RIFFdata");
  });
});
