// Why an install failed, in plain words, and how to finish it in Terminal instead. One reader for every installer
// the app runs: the Setup cards (Homebrew, Anthropic's installer, through the setup runner) and the browser helper
// (npm). Commands are built from constants and known folders only, never from the installer's output.
import identity from "@careeros/brand/identity.json" with { type: "json" };
import type { InstallProblem, TerminalFix, TerminalOption } from "@careeros/contract";
import { scrubMessage } from "@careeros/video";

export interface InstallFailure { problem: InstallProblem; /** The installer's own last error line, without paths ("" when none). */ said: string }

const DISK = /\bENOSPC\b|no space left on device/i;
const PERMISSION = /\bE(ACCES|PERM)\b|permission denied|operation not permitted|not writable/i;
const NETWORK = new RegExp([
  String.raw`\b(ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|ERR_SOCKET_TIMEOUT)\b`,
  String.raw`\b(SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT|UNABLE_TO_GET_ISSUER_CERT(_LOCALLY)?|UNABLE_TO_VERIFY_LEAF_SIGNATURE|CERT_HAS_EXPIRED|ERR_SSL_\w+)\b`,
  String.raw`self[- ]signed certificate|SSL certificate problem|tunneling socket|\bproxy\b`,
  String.raw`Could not resolve host|Failed to connect to|Failed to download resource|network is unreachable`,
].join("|"), "i");
/** A line that says something went wrong. Homebrew's `==> Pouring libgpg-error…` progress lines don't count. */
const ERROR_LINE = /\b(error|failed|fatal|denied|not permitted|no such|cannot|can't|could not|refusing)\b/i;
/** npm's framing around the real error: field lines and "see the log" advice. */
const NPM_META = /^(code|syscall|path|errno|dest|A complete log|Log files were not written|You can rerun|This is related to npm|If you believe|It is likely|The operation was rejected|\[|\{|\}|\d+\s*$|\d+\s+')/i;

/** Reads an installer's output (npm, Homebrew, curl) into one problem the person can act on. */
export function classifyInstall(output: string, o: { timedOut?: boolean } = {}): InstallFailure {
  const text = output.length > 20_000 ? output.slice(-20_000) : output;
  const problem: InstallProblem = o.timedOut ? "timeout" : DISK.test(text) ? "disk" : PERMISSION.test(text) ? "permission" : NETWORK.test(text) ? "network" : "other";
  return { problem, said: saidLine(text) };
}

function saidLine(text: string): string {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  // npm: the first line after its `code`/`path` fields is the real one ("404 Not Found - GET …", "Error: EACCES: …").
  const npm = lines.filter((l) => /^npm (error|ERR!)/.test(l)).map((l) => l.replace(/^npm (error|ERR!)\s*/, "")).find((l) => l && !NPM_META.test(l));
  const t = npm ?? [...lines].reverse().find((l) => !l.startsWith("==>") && !/^[{}[\]"]/.test(l) && ERROR_LINE.test(l)) ?? "";
  return scrubMessage(t.replace(/^(error|fatal)\s*:\s*/i, ""), "", 200);
}

/** One or two sentences for the card: what happened, and what to do next. `name` starts the sentence. */
export function installFailedText(name: string, f: InstallFailure): string {
  switch (f.problem) {
    case "permission": return `${name} didn't install: your Mac said permission denied for a folder it needs. Run it in Terminal instead (below).`;
    case "network": return `${name} didn't install: it couldn't download. Check your internet connection. On a work or school network, a proxy or security certificate may be blocking it; your IT team can help.`;
    case "timeout": return `${name} took too long, so it was stopped. A slow connection is the usual cause. Try again, or run it in Terminal, where you can watch it.`;
    case "disk": return `${name} didn't install: your Mac is out of disk space. Free up some space, then try again.`;
    default: return `${name} didn't install.${f.said ? ` The installer said: "${f.said}".` : ""} Try again, or run it in Terminal instead (below).`;
  }
}

export const SUDO_NOTE = "sudo asks for your Mac password (the one you log in with). Nothing shows while you type it; that's normal. Type it and press Return.";
const AFTER = `When it finishes, come back to ${identity.name} and choose Check again.`;
const NOTE: Partial<Record<InstallProblem, string>> = {
  network: "On a work or school network, your IT team can tell you the proxy settings it needs.",
  timeout: "Terminal shows the download as it goes. Leave it open until it finishes.",
  disk: "Free up some space first (System Settings › General › Storage).",
};

/**
 * The commands to finish an install by hand. Permission problems get the fix that suits the installer: npm can
 * install into the home folder without a password (the app finds the helper in ~/.npm-global), or fix the owner of
 * npm's cache with sudo (never `sudo npm install`, which leaves files only an administrator can change); Homebrew
 * refuses sudo, and `brew doctor` names the folders to fix; Anthropic's installer writes to ~/.local.
 */
export function terminalFix(o: { problem: InstallProblem; via: "homebrew" | "anthropic" | "npm"; command: string; /** npm: the --prefix folder, already quoted (shellPath). */ folder?: string; /** npm: the package spec. */ pkg?: string }): TerminalFix {
  const options: TerminalOption[] = [{ title: "Run it in Terminal", command: o.command, note: [NOTE[o.problem], AFTER].filter(Boolean).join(" ") }];
  if (o.problem === "permission") {
    if (o.via === "npm" && o.pkg) {
      options.push({
        title: "If it says permission denied: install it in your home folder (no password)",
        command: `mkdir -p "$HOME/.npm-global"\nnpm install -g --prefix "$HOME/.npm-global" --cache "$HOME/.npm-global/_cache" ${o.pkg}`,
        note: `${identity.name} finds it there. ${AFTER}`,
      });
      options.push({ title: "Or fix the folders' owner, then install (asks for your password)", command: `sudo chown -R "$(whoami)" "$HOME/.npm"${o.folder ? ` ${o.folder}` : ""}\n${o.command}`, note: SUDO_NOTE });
    } else if (o.via === "homebrew") {
      options.push({ title: "If it says a folder isn't writable", command: "brew doctor", note: `Homebrew lists the folders with the wrong owner and the exact line that fixes them. That line starts with sudo: ${SUDO_NOTE}` });
    } else if (o.via === "anthropic") {
      options.push({ title: "If it says permission denied: fix your ~/.local folder's owner, then install", command: `sudo chown -R "$(whoami)" "$HOME/.local"\n${o.command}`, note: SUDO_NOTE });
    }
  }
  return { problem: o.problem, options };
}

/** A path quoted for Terminal: under the home folder as "$HOME/…" (so the person's name isn't shown), else in single quotes. */
export function shellPath(p: string, home: string): string {
  const h = home.replace(/\/+$/, "");
  if (h && p.startsWith(`${h}/`)) return `"$HOME/${p.slice(h.length + 1).replace(/[\\"$`]/g, (c) => `\\${c}`)}"`;
  return `'${p.replace(/'/g, "'\\''")}'`;
}
