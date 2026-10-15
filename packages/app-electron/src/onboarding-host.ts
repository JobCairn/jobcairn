import { execFile } from "node:child_process";
import path from "node:path";

/**
 * The bundled fictional example "Explore with an example" copies (main only; the renderer never sees it).
 * Development: <repo>/samples/alex-example. Packaged (installer carry): resources/careeros-example.
 */
export function sampleDirFor(opts: { packaged: boolean; resourcesPath: string; here: string }): string {
  return opts.packaged ? path.join(opts.resourcesPath, "careeros-example") : path.join(path.resolve(opts.here, "..", "..", ".."), "samples", "alex-example");
}

type Run = (cmd: string, args: string[]) => Promise<string>;

const runFile: Run = (cmd, args) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout: 2000, maxBuffer: 4096, encoding: "utf8" }, (err, out) => (err ? reject(err) : resolve(out)));
});

/** The computer account's full name, to prefill "What's your name?". macOS only; "" when unknown. */
export async function accountFullName(platform: NodeJS.Platform, run: Run = runFile): Promise<string> {
  if (platform !== "darwin") return "";
  try {
    const name = (await run("id", ["-F"])).trim();
    return name.length <= 120 ? name : "";
  } catch { return ""; }
}
