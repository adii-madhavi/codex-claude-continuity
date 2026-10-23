// Read-only MCP retrieval for Claude Desktop (stdio). It serves recorded
// checkpoints, events and the recorded project's files. It has no tool that
// writes, runs commands, or drives any desktop app.

import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { buildCheckpoint, listSessions, sourceStatus } from "./checkpoint.mjs";
import { redactSecrets } from "./redact.mjs";
import { assertSessionId, readEvents } from "./store.mjs";
import { takeoverPrompt } from "./takeover.mjs";

const MAX_RESPONSE_CHARS = 20_000;
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const SECRET_FILE = /(^|[\\/])(\.env(\..*)?|.*\.(pem|key|p12|pfx)|id_(rsa|ed25519|ecdsa)|auth\.json|\.npmrc|\.netrc)$/i;
const SKIP_DIRS = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", "dist", "build", ".next"]);

const reply = (value) => {
  let text = typeof value === "string" ? value : JSON.stringify(value, null, 1);
  if (text.length > MAX_RESPONSE_CHARS) text = `${text.slice(0, MAX_RESPONSE_CHARS)}\n…[response truncated at ${MAX_RESPONSE_CHARS} chars; request a narrower range]`;
  return { content: [{ type: "text", text }] };
};

const guarded = (fn) => async (args) => {
  try {
    return reply(await fn(args));
  } catch (error) {
    return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
  }
};

const compact = (e) => ({
  seq: e.seq,
  at: e.ts,
  event: e.event,
  tool: e.tool,
  toolUseId: e.toolUseId,
  turn: e.turn,
  summary: [e.prompt, e.input, e.response, e.lastAssistantMessage, e.reason]
    .filter((v) => v !== undefined)
    .map((v) => (typeof v === "string" ? v : JSON.stringify(v)).slice(0, 240))
    .join(" | ") || undefined
});

/** The session's recorded working directory: the only tree file tools may read. */
const projectRoot = (sessionId) => {
  const cwd = readEvents(assertSessionId(sessionId)).findLast((e) => e.cwd)?.cwd;
  if (!cwd) throw new Error("This session has no recorded project directory.");
  return realpathSync(cwd);
};

const insideProject = (sessionId, relative) => {
  const root = projectRoot(sessionId);
  const target = realpathSync(path.resolve(root, relative ?? "."));
  const rel = path.relative(root, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("Path is outside the recorded project directory.");
  return { root, target, rel: rel || "." };
};

const server = new McpServer({ name: "desktop-continuity", version: "0.1.0" });
const sessionId = z.string().describe("Recorded session id (from list_sessions).");

server.registerTool("list_sessions", {
  title: "List recorded source sessions",
  description: "List Codex desktop sessions recorded by desktop-continuity, most recent first. Filter by project path substring to keep projects apart.",
  inputSchema: { project: z.string().optional(), limit: z.number().int().min(1).max(25).optional() },
  annotations: READ_ONLY
}, guarded(({ project, limit }) => listSessions(project, limit ?? 10)));

server.registerTool("get_checkpoint", {
  title: "Get continuation checkpoint",
  description: "Compact checkpoint for one recorded session: request, last reply, files touched, recent actions with recorded or UNKNOWN outcomes, source status, and what was not captured. Start here.",
  inputSchema: { session_id: sessionId },
  annotations: READ_ONLY
}, guarded(({ session_id }) => buildCheckpoint(assertSessionId(session_id))));

server.registerTool("get_source_status", {
  title: "Check whether the source app may still be working",
  description: "Fresh check of the source session: end-of-turn events, ChatGPT app process, transcript activity and usage-limit signals. Call before repeating an action or editing shared files.",
  inputSchema: { session_id: sessionId },
  annotations: { ...READ_ONLY, idempotentHint: false }
}, guarded(({ session_id }) => sourceStatus(readEvents(assertSessionId(session_id)))));

server.registerTool("get_events", {
  title: "Page through recorded events",
  description: "Compact rows of recorded events after a sequence number, optionally filtered by hook event name (UserPromptSubmit, PreToolUse, PostToolUse, Stop, Interrupt, SessionStart, SessionEnd, PreCompact).",
  inputSchema: {
    session_id: sessionId,
    after_seq: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(50).optional(),
    event: z.string().optional()
  },
  annotations: READ_ONLY
}, guarded(({ session_id, after_seq, limit, event }) => {
  const all = readEvents(assertSessionId(session_id));
  const rows = all.filter((e) => e.seq > (after_seq ?? 0) && (!event || e.event === event)).slice(0, limit ?? 20);
  return { total: all.length, rows: rows.map(compact), next_after_seq: rows.at(-1)?.seq };
}));

server.registerTool("get_event", {
  title: "Get one recorded event in full",
  description: "Full stored detail of one event (tool input, tool result, prompt or final message), already redacted and size-bounded at capture.",
  inputSchema: { session_id: sessionId, seq: z.number().int().min(1) },
  annotations: READ_ONLY
}, guarded(({ session_id, seq }) => {
  const event = readEvents(assertSessionId(session_id)).find((e) => e.seq === seq);
  if (!event) throw new Error(`No event ${seq} in session ${session_id}.`);
  return event;
}));

server.registerTool("list_project_files", {
  title: "List files in the recorded project",
  description: "List a directory inside the session's recorded project directory (read-only, max 200 entries).",
  inputSchema: { session_id: sessionId, dir: z.string().optional() },
  annotations: READ_ONLY
}, guarded(({ session_id, dir }) => {
  const { root, target, rel } = insideProject(session_id, dir);
  const entries = readdirSync(target, { withFileTypes: true })
    .filter((d) => !SKIP_DIRS.has(d.name))
    .slice(0, 200)
    .map((d) => {
      const full = path.join(target, d.name);
      return d.isDirectory() ? { name: `${d.name}/` } : { name: d.name, bytes: statSync(full).size, modified: statSync(full).mtime.toISOString() };
    });
  return { project: root, dir: rel, entries };
}));

server.registerTool("read_project_file", {
  title: "Read a file in the recorded project",
  description: "Read part of a text file inside the session's recorded project directory. Secrets are redacted; credential files are refused.",
  inputSchema: {
    session_id: sessionId,
    path: z.string(),
    offset: z.number().int().min(0).optional(),
    max_chars: z.number().int().min(1).max(15_000).optional()
  },
  annotations: READ_ONLY
}, guarded(({ session_id, path: file, offset, max_chars }) => {
  const { target, rel } = insideProject(session_id, file);
  if (SECRET_FILE.test(target)) throw new Error("Refusing to read a credential file.");
  const text = readFileSync(target, "utf8");
  const start = offset ?? 0;
  const slice = text.slice(start, start + (max_chars ?? 8_000));
  return `${rel} (chars ${start}-${start + slice.length} of ${text.length}, modified ${statSync(target).mtime.toISOString()})\n\n${redactSecrets(slice)}`;
}));

server.registerPrompt("continue_task", {
  title: "Continue a recorded Codex task",
  description: "Explicit takeover: continue a session recorded from the ChatGPT desktop app.",
  argsSchema: { session_id: z.string() }
}, ({ session_id }) => ({
  messages: [{ role: "user", content: { type: "text", text: takeoverPrompt(assertSessionId(session_id), "manual takeover") } }]
}));

await server.connect(new StdioServerTransport());
