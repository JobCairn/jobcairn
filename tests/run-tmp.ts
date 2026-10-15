import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Each test run gets its own temp folder, and it is deleted when the run ends, so the many folders tests make
// with mkdtemp never pile up in the shared temp folder (they had filled the disk).
export default function setup(): () => void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobcairn-test-"));
  const before = process.env.TMPDIR;
  process.env.TMPDIR = dir;
  return () => {
    if (before === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = before;
    fs.rmSync(dir, { recursive: true, force: true });
  };
}
