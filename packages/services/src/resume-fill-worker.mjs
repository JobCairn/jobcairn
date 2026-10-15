// "Fill from my resume": turns a PDF or Word resume into plain text, in a worker thread with a deadline and a
// bounded heap (resume-fill.ts starts it). Runs on this computer only: no network, no eval, nothing is logged.
// The text goes back to the main thread and is never written to a log.
import { parentPort, workerData } from "node:worker_threads";
import { unzipSync, strFromU8 } from "fflate";

const MAX_TEXT = 300_000;
const MAX_PAGES = 30;
/** The unpacked document part may be at most this big (a zip bomb stops here). */
const MAX_XML = 20 * 1024 * 1024;

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decode = (s) => s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|amp|lt|gt|quot|apos);/gi, (_m, e) => {
  const k = e.toLowerCase();
  if (k in ENTITIES) return ENTITIES[k];
  const n = k.startsWith("#x") ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
  return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : " ";
});

/** word/document.xml as text: paragraphs become lines, tabs stay, and each hyperlink keeps its address after its text. */
function wordText(bytes) {
  let files;
  try {
    files = unzipSync(bytes, {
      filter: (f) => (f.name === "word/document.xml" || f.name === "word/_rels/document.xml.rels") && f.originalSize <= MAX_XML,
    });
  } catch {
    return { ok: false, reason: "word" };
  }
  const doc = files["word/document.xml"];
  if (!doc || doc.length > MAX_XML) return { ok: false, reason: "word" };
  const rels = new Map();
  const relXml = files["word/_rels/document.xml.rels"] ? strFromU8(files["word/_rels/document.xml.rels"]) : "";
  for (const m of relXml.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /\bId="([^"]{1,40})"/.exec(m[0])?.[1];
    const target = decode(/\bTarget="([^"]{1,400})"/.exec(m[0])?.[1] ?? "");
    if (id && /TargetMode="External"/.test(m[0]) && /^https?:\/\/[^\s<>"]+$/i.test(target)) rels.set(id, target);
  }
  const xml = strFromU8(doc)
    .replace(/<w:hyperlink\b([^>]*)>([\s\S]*?)<\/w:hyperlink>/g, (_m, attrs, inner) => {
      const url = rels.get(/\br:id="([^"]{1,40})"/.exec(attrs)?.[1] ?? "");
      return url ? `${inner}<w:t> ${url} </w:t>` : inner;
    })
    .replace(/<w:tab\/>/g, "\t")
    .replace(/<w:(?:br|cr)\b[^>]*\/>/g, "\n")
    .replace(/<\/w:p>/g, "\n");
  const text = decode(xml.replace(/<[^>]{0,2000}>/g, ""));
  return { ok: true, text: text.slice(0, MAX_TEXT) };
}

async function pdfText(bytes) {
  const { getDocumentProxy } = await import("unpdf");
  let doc;
  try {
    doc = await getDocumentProxy(bytes, { isEvalSupported: false, useSystemFonts: false, disableFontFace: true, verbosity: 0, stopAtErrors: false });
  } catch (e) {
    return { ok: false, reason: e && e.name === "PasswordException" ? "locked" : "pdf" };
  }
  const out = [];
  let size = 0;
  for (let i = 1; i <= Math.min(doc.numPages, MAX_PAGES) && size < MAX_TEXT; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    let line = "";
    for (const item of content.items) {
      if (typeof item.str !== "string") continue;
      line += item.str;
      if (item.hasEOL) { out.push(line); size += line.length + 1; line = ""; }
    }
    if (line) { out.push(line); size += line.length + 1; }
    out.push("");
  }
  try { await doc.destroy(); } catch { /* finished anyway */ }
  return { ok: true, text: out.join("\n").slice(0, MAX_TEXT) };
}

async function main() {
  const { kind, bytes } = workerData;
  const data = new Uint8Array(bytes);
  try {
    parentPort.postMessage(kind === "pdf" ? await pdfText(data) : wordText(data));
  } catch {
    parentPort.postMessage({ ok: false, reason: kind === "pdf" ? "pdf" : "word" });
  }
}

void main();
