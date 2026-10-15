import { describe, expect, it } from "vitest";
import { classifyInstall, installFailedText, shellPath, terminalFix } from "../src/install-error.js";

const NPM_EACCES = [
  "npm error code EACCES",
  "npm error syscall mkdir",
  "npm error path /fictional/home/.npm/_cacache",
  "npm error errno -13",
  "npm error Error: EACCES: permission denied, mkdir '/fictional/home/.npm/_cacache'",
  "npm error A complete log of this run can be found in: /fictional/home/.npm/_logs/x.log",
].join("\n");

describe("classifyInstall", () => {
  it("reads npm's and Homebrew's output into one plain problem", () => {
    expect(classifyInstall(NPM_EACCES).problem).toBe("permission");
    expect(classifyInstall("npm ERR! code EPERM\nnpm ERR! syscall rename").problem).toBe("permission");
    expect(classifyInstall("Error: The following directories are not writable by your user:\n/opt/homebrew/share").problem).toBe("permission");
    for (const net of ["npm error code ENOTFOUND", "npm error code ETIMEDOUT", "npm error code ECONNRESET", "npm error code EAI_AGAIN",
      "npm error code SELF_SIGNED_CERT_IN_CHAIN", "npm error code UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "npm error code CERT_HAS_EXPIRED",
      "npm error request to https://registry.npmjs.org/x failed, reason: tunneling socket could not be established (proxy)",
      "curl: (6) Could not resolve host: ghcr.io", "Error: Failed to download resource \"node\""]) {
      expect(classifyInstall(net).problem, net).toBe("network");
    }
    expect(classifyInstall("npm error code ENOSPC\nnpm error nospc ENOSPC: no space left on device").problem).toBe("disk");
    expect(classifyInstall("anything", { timedOut: true }).problem).toBe("timeout");
    expect(classifyInstall("npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/agent-browser - Not found").problem).toBe("other");
    expect(classifyInstall("").problem).toBe("other");
  });

  it("keeps the installer's own last error line, without paths, boilerplate or brew's progress lines", () => {
    expect(classifyInstall("npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/agent-browser - Not found\nnpm error A complete log of this run can be found in: /x/y.log").said)
      .toBe("404 Not Found - GET https://registry.npmjs.org/agent-browser - Not found");
    expect(classifyInstall("==> Pouring libgpg-error--1.50.arm64_sequoia.bottle.tar.gz\nError: No such keg: /opt/homebrew/Cellar/ffmpeg").said).toMatch(/^No such keg/);
    expect(classifyInstall("==> Pouring libgpg-error--1.50.arm64_sequoia.bottle.tar.gz").said).toBe("");
    expect(classifyInstall(NPM_EACCES).said).not.toContain("/fictional/home");
  });
});

describe("installFailedText", () => {
  it("says what happened and what to do, in plain words", () => {
    expect(installFailedText("The browser helper", { problem: "permission", said: "" })).toMatch(/permission denied.*Terminal/);
    expect(installFailedText("Node.js", { problem: "network", said: "" })).toMatch(/couldn't download.*proxy/);
    expect(installFailedText("Node.js", { problem: "timeout", said: "" })).toMatch(/took too long/);
    expect(installFailedText("Node.js", { problem: "disk", said: "" })).toMatch(/out of disk space/);
    expect(installFailedText("Node.js", { problem: "other", said: "No such keg" })).toBe('Node.js didn\'t install. The installer said: "No such keg". Try again, or run it in Terminal instead (below).');
  });
});

describe("terminalFix", () => {
  const helperCmd = 'npm install --prefix "$HOME/Library/Application Support/JobCairn/browser-helper" agent-browser@0.38.2';

  it("always offers the normal command first", () => {
    const f = terminalFix({ problem: "other", via: "homebrew", command: "brew install node" });
    expect(f.options[0]!.command).toBe("brew install node");
    expect(f.options).toHaveLength(1);
  });

  it("npm permission: a no-password fix in the home folder, then the sudo fix with what sudo asks", () => {
    const f = terminalFix({ problem: "permission", via: "npm", command: helperCmd, folder: '"$HOME/x"', pkg: "agent-browser@0.38.2" });
    expect(f.options.map((o) => o.command)).toEqual([
      helperCmd,
      'mkdir -p "$HOME/.npm-global"\nnpm install -g --prefix "$HOME/.npm-global" --cache "$HOME/.npm-global/_cache" agent-browser@0.38.2',
      `sudo chown -R "$(whoami)" "$HOME/.npm" "$HOME/x"\n${helperCmd}`,
    ]);
    expect(f.options[2]!.note).toMatch(/Mac password.*Nothing shows while you type/);
    // Never `sudo npm install`: that leaves files only an administrator can change in the app's own folder.
    expect(f.options.some((o) => /sudo npm/.test(o.command))).toBe(false);
  });

  it("Homebrew permission: brew doctor names the folders, never sudo brew", () => {
    const f = terminalFix({ problem: "permission", via: "homebrew", command: "brew install ffmpeg" });
    expect(f.options.map((o) => o.command)).toEqual(["brew install ffmpeg", "brew doctor"]);
    expect(f.options.some((o) => /sudo brew/.test(o.command))).toBe(false);
  });

  it("Claude Code permission: fixes ~/.local's owner, then runs the installer", () => {
    const f = terminalFix({ problem: "permission", via: "anthropic", command: "curl -fsSL https://claude.ai/install.sh | bash" });
    expect(f.options[1]!.command).toBe('sudo chown -R "$(whoami)" "$HOME/.local"\ncurl -fsSL https://claude.ai/install.sh | bash');
  });
});

describe("shellPath", () => {
  it("quotes a path for Terminal, writing the home folder as $HOME", () => {
    expect(shellPath("/fictional/home/Library/Application Support/JobCairn/browser-helper", "/fictional/home")).toBe('"$HOME/Library/Application Support/JobCairn/browser-helper"');
    expect(shellPath("/opt/x y", "/fictional/home")).toBe("'/opt/x y'");
    expect(shellPath("/fictional/home/it's", "/fictional/home")).toBe('"$HOME/it\'s"');
    expect(shellPath("/fictional/home/a$b`c\"d", "/fictional/home")).toBe('"$HOME/a\\$b\\`c\\"d"');
    expect(shellPath("/opt/it's", "/fictional/home")).toBe("'/opt/it'\\''s'");
  });
});
