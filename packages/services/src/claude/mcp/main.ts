#!/usr/bin/env node
// `careeros mcp`: the stdio MCP server a Claude Code run talks to (spec 2026-10-10, R1). Started by Claude Code
// from the --mcp-config the engine generates: CAREEROS_WORKSPACE pins the workspace, --tools the allowed tools,
// --job the one job a job_event may touch.
import { parseMcpArgv } from "./argv.js";
import { serveMcp } from "./server.js";
import { chromeCli, realCliDeps } from "../../chrome/cli.js";

// `<entry> chrome --workspace <root> <command...>`: the jobcairn-chrome command Claude runs through Bash (chrome/cli.ts).
if (process.argv[2] === "chrome") {
  const argv = process.argv.slice(3);
  if (argv[0] !== "--workspace" || !argv[1]) { process.stderr.write("jobcairn-chrome: installed incorrectly\n"); process.exit(2); }
  chromeCli(argv[1]!, argv.slice(2), realCliDeps()).then((r) => { process.stdout.write(`${r.out}\n`); process.exit(r.code); }, (e: unknown) => {
    process.stdout.write(`The browser couldn't do that: ${(e as Error).message.split("\n")[0]}\n`);
    process.exit(1);
  });
} else {
  startMcp();
}

function startMcp(): void {
let session;
try {
  session = parseMcpArgv(process.argv.slice(2), process.env);
} catch (e) {
  process.stderr.write(`careeros mcp: ${(e as Error).message}\n`);
  process.exit(2);
}
serveMcp(session, process.stdin, process.stdout).then(() => process.exit(0), (e: unknown) => {
  process.stderr.write(`careeros mcp: ${(e as Error).message.split("\n")[0]}\n`);
  process.exit(2);
});
}
