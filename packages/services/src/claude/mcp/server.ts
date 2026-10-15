import readline from "node:readline";
import type { Readable, Writable } from "node:stream";
import { ArgError } from "@careeros/contract";
import { mcpCap, MCP_TOOL_NAMES, MCP_TOOLS, assertServable, type McpSession, type McpToolName } from "./tools.js";

/**
 * A minimal MCP server over stdio (newline-delimited JSON-RPC 2.0): initialize, tools/list, tools/call, ping.
 * Pinned to one workspace and to the tools named at start. Errors go back as plain one-line text with no paths.
 */
export const MCP_PROTOCOL = "2025-06-18";
/** Room for a 200 KB ad with JSON escaping. */
const MAX_LINE = 1024 * 1024;

type Json = Record<string, unknown>;

export function handleMcp(session: McpSession, msg: unknown): Json | null {
  const { tools } = session;
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } };
  const m = msg as Json;
  const id = (typeof m.id === "string" || typeof m.id === "number") ? m.id : null;
  const isNote = !("id" in m);
  const reply = (result: unknown) => (isNote ? null : { jsonrpc: "2.0", id, result });
  const fail = (code: number, message: string) => (isNote ? null : { jsonrpc: "2.0", id, error: { code, message } });
  switch (m.method) {
    case "initialize":
      return reply({ protocolVersion: MCP_PROTOCOL, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "careeros", version: "1" } });
    case "notifications/initialized": case "notifications/cancelled": return null;
    case "ping": return reply({});
    case "tools/list":
      return reply({ tools: tools.map((n) => ({ name: n, description: MCP_TOOLS[n].description, inputSchema: MCP_TOOLS[n].inputSchema })) });
    case "tools/call": {
      const p = (m.params && typeof m.params === "object" ? m.params : {}) as Json;
      const name = p.name;
      if (typeof name !== "string" || !(tools as readonly string[]).includes(name)) return fail(-32602, "That tool isn't available for this request.");
      const tool = MCP_TOOLS[name as McpToolName];
      try {
        const args = tool.validate(p.arguments ?? {}, name);
        const used = session.counts[tool.name] ?? 0;
        const cap = mcpCap(session, tool.name);
        if (cap !== undefined && used >= cap) throw new Error(`This request has used ${tool.name} ${cap} times, the most one request may.`);
        const out = tool.run(session, args);
        session.counts[tool.name] = used + 1;
        return reply({ content: [{ type: "text", text: JSON.stringify(out) }] });
      } catch (e) {
        const text = e instanceof ArgError ? e.message : (e as Error).message;
        return reply({ content: [{ type: "text", text: noAbsPaths(text.split("\n")[0]!).slice(0, 300) }], isError: true });
      }
    }
    default: return fail(-32601, "Method not found");
  }
}

/**
 * Never echo an absolute path back to the model (F8: only absolute ones, at a word start, so "me/identity" in a
 * message stays readable). POSIX `/x/y`, `~/x`, Windows `C:\x` and `\\server\x`.
 */
export function noAbsPaths(text: string): string {
  return text.replace(/(^|[\s"'(=:])(?:~?\/(?:[^\s"'/]+\/)*[^\s"'/]+|[A-Za-z]:[\\/][^\s"']*|\\\\[^\s"']+)/g, "$1a file");
}

/** Serves until `input` ends. Requests are answered in order, one at a time. */
export function serveMcp(session: McpSession, input: Readable, output: Writable): Promise<void> {
  assertServable(session.root);
  for (const t of session.tools) if (!(MCP_TOOL_NAMES as readonly string[]).includes(t)) throw new Error(`unknown tool ${t}`);
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  let chain: Promise<void> = Promise.resolve();
  rl.on("line", (line) => {
    if (!line.trim()) return;
    chain = chain.then(async () => {
      let out: Json | null;
      if (line.length > MAX_LINE) out = { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Request too large" } };
      else {
        let msg: unknown;
        try { msg = JSON.parse(line); } catch { msg = undefined; }
        if (msg === undefined) out = { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } };
        else {
          try { out = handleMcp(session, msg); } catch { out = { jsonrpc: "2.0", id: null, error: { code: -32603, message: "Internal error" } }; }
        }
      }
      if (out) output.write(JSON.stringify(out) + "\n");
    });
  });
  return new Promise((resolve) => rl.on("close", () => { void chain.then(() => resolve()); }));
}
