import fs from "node:fs";
import path from "node:path";
import { extractDocText } from "./resume-fill.js";

/**
 * Reads a drop box file's text on this computer, for content classification and Add as a job. Main only: the text
 * never goes to the window. `null` means "can't read this kind of file here": the drop box falls back to name rules.
 */
export interface TextReader { read(abs: string, name: string): Promise<string | null> }

/** At most this much of a file is read for classification. */
export const MAX_CLASSIFY_BYTES = 256 * 1024;
const TEXT_EXT = new Set([".md", ".markdown", ".txt", ".text", ".eml", ".csv", ".html", ".htm", ""]);

/**
 * Plain text files (Markdown, text, saved emails): read directly, refused if they hold a NUL byte or aren't UTF-8.
 * PDF and Word: `pdfWord`, which in the app is Fill from my resume's worker-based extractor (resume-fill.ts).
 */
export function localTextReader(pdfWord?: (abs: string, name: string) => Promise<string | null>): TextReader {
  return {
    async read(abs, name) {
      const ext = path.extname(name).toLowerCase();
      if (ext === ".pdf" || ext === ".docx") return pdfWord ? pdfWord(abs, name).catch(() => null) : null;
      if (!TEXT_EXT.has(ext)) return null;
      const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
      let fd: number;
      try { fd = fs.openSync(abs, flags); } catch { return null; }
      try {
        const st = fs.fstatSync(fd);
        if (!st.isFile()) return null;
        const buf = Buffer.alloc(Math.min(st.size, MAX_CLASSIFY_BYTES));
        const n = fs.readSync(fd, buf, 0, buf.length, 0);
        const bytes = buf.subarray(0, n);
        if (bytes.includes(0)) return null;
        // A cut-off last character (the file is longer than the cap) is held back, not treated as invalid.
        try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: st.size > n }); } catch { return null; }
      } finally { fs.closeSync(fd); }
    },
  };
}

/** The reader in use: text files here, PDF and Word through Fill from my resume's extractor. */
export const defaultTextReader: TextReader = localTextReader((abs) => extractDocText(abs));

let reader: TextReader = defaultTextReader;
export const textReader = (): TextReader => reader;
/** Tests: use a different reader (for example one that "reads" PDFs). Returns the previous one. */
export function setTextReader(r: TextReader): TextReader { const prev = reader; reader = r; return prev; }
