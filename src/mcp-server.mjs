// Read-only MCP retrieval for Claude Desktop (stdio). It serves recorded
// checkpoints, events and the recorded project's files. It has no tool that
// writes, runs commands, or drives any desktop app.

import { appendFileSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { SECRET_FILE, SKIP_DIRS, buildCheckpoint, listSessions, pickLatestEligible, sourceStatus } from "./checkpoint.mjs";
import { redactSecrets } from "./redact.mjs";
import { assertSessionId, readEvents, resolveSession, storeRoot } from "./store.mjs";
import { importedTakeoverPrompt, takeoverPrompt } from "./takeover.mjs";
import { importProjectRoot, listImports, mapToDestination, readImport, resolveImport } from "./capsule/imported-store.mjs";
import { createHash } from "node:crypto";

const MAX_RESPONSE_CHARS = 20_000;
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

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
  try {
    return realpathSync(cwd);
  } catch {
    throw new Error(`The recorded project folder ${cwd} no longer exists (moved or deleted). Ask the user where it is now; do not guess another folder.`);
  }
};

const insideProject = (sessionId, relative) => insideRoot(projectRoot(sessionId), relative);

const insideRoot = (root, relative) => {
  const target = realpathSync(path.resolve(root, relative ?? "."));
  const rel = path.relative(root, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("Path is outside the recorded project directory.");
  return { root, target, rel: rel || "." };
};

const listDir = (root, target, rel) => ({
  project: root,
  dir: rel,
  entries: readdirSync(target, { withFileTypes: true })
    .filter((d) => !SKIP_DIRS.has(d.name))
    .slice(0, 200)
    .map((d) => {
      const full = path.join(target, d.name);
      return d.isDirectory() ? { name: `${d.name}/` } : { name: d.name, bytes: statSync(full).size, modified: statSync(full).mtime.toISOString() };
    })
});

const readSlice = (target, rel, offset, maxChars) => {
  if (SECRET_FILE.test(target)) throw new Error("Refusing to read a credential file.");
  const text = readFileSync(target, "utf8");
  const start = offset ?? 0;
  const slice = text.slice(start, start + (maxChars ?? 8_000));
  return `${rel} (chars ${start}-${start + slice.length} of ${text.length}, modified ${statSync(target).mtime.toISOString()})\n\n${redactSecrets(slice)}`;
};

// Imported capsules (from another computer, via Session Capsule). Everything is
// read from Blocker's imported store and the project folder the user mapped on
// this computer; nothing depends on the source computer or its paths.
const importedCheckpoint = (id) => {
  const { record, handoff } = readImport(id);
  const root = importProjectRoot(id);
  const capsuleFiles = new Map((handoff.capsule?.files ?? []).map((f) => [f.path, f.sha256]));
  const artifacts = handoff.checkpoint?.observed?.artifacts ?? [];
  const destinationFiles = artifacts.slice(0, 50).map((a) => {
    const rel = mapToDestination(a.now?.relativePath ?? a.path, handoff.session.sourceProjectPath);
    if (!rel) return { recordedPath: a.path, state: "not mapped: path is outside the source project folder" };
    let state;
    try {
      const { target } = insideRoot(root, rel);
      const sha = createHash("sha256").update(readFileSync(target)).digest("hex");
      state = !capsuleFiles.has(rel) ? "exists; not in the capsule's file manifest" : capsuleFiles.get(rel) === sha ? "matches the capsule" : "differs from the capsule";
    } catch {
      state = "missing on this computer";
    }
    return { recordedPath: a.path, destinationPath: rel, state };
  });
  return {
    import_ref: record.import_ref,
    imported_id: record.imported_id,
    note: "History handed over from another computer. It is read-only; new work here is a new session.",
    provenance: {
      recorder: handoff.createdBy,
      capturedAt: handoff.capturedAt,
      source: handoff.source,
      originalSession: handoff.session,
      lastIncludedSeq: handoff.events?.lastIncludedSeq,
      eventsIncluded: handoff.events?.included,
      eventsOmittedBefore: handoff.events?.omittedBefore,
      sourcePaths: "Paths in the history refer to the source computer. File tools below read the mapped folder on this computer."
    },
    destination: { projectRoot: root, mode: record.mode, filesApplied: record.filesApplied, contextCheck: record.contextCheck, registeredAt: record.registeredAt },
    observed: handoff.checkpoint?.observed ?? null,
    agentNotes: handoff.checkpoint?.agentNotes ?? null,
    inferred: handoff.checkpoint?.inferred ?? null,
    destinationFiles,
    sourceStatus: { historical: true, ...(handoff.sourceStatusAtCapture ?? { note: "No source status was captured." }) },
    liveSourceStatus: {
      status: "unknown",
      detail: "Not checked. The source computer is not reachable from here and Blocker has no remote check; this computer's processes and files say nothing about it. Ask the user if it matters."
    },
    coverage: handoff.coverage,
    userNotes: handoff.notes,
    missing: [
      ...(handoff.checkpoint?.missing ?? handoff.coverage.missing),
      "Recorded on another computer: hidden reasoning, unsaved editor state, unfinished streamed text and running processes did not transfer.",
      ...(record.mode === "context-only" ? ["Context-only capsule: project files were moved separately; check contextCheck and destinationFiles for mismatches."] : [])
    ]
  };
};

const server = new McpServer({ name: "desktop-continuity", version: "0.1.0" });
// Every session tool takes session_ref (integer, from list_sessions) or
// session_id. Both stay optional and undescribed: in Claude Desktop 3.6556's
// chat, a required, described string session_id arrived as {} while optional
// integers arrived intact (mcp-calls.log). resolveSession enforces "one of them".
const sessionArgs = { session_ref: z.number().int().optional(), session_id: z.string().optional() };

server.registerTool("list_sessions", {
  title: "List recorded source sessions",
  description: "List Codex desktop sessions recorded by desktop-continuity, most recent first. Filter by project path substring to keep projects apart. Each row has a session_ref integer: pass it as session_ref to the other tools.",
  inputSchema: { project: z.string().optional(), limit: z.number().int().min(1).max(25).optional() },
  annotations: READ_ONLY
}, guarded(({ project, limit }) => listSessions(project, limit ?? 10)));

server.registerTool("get_checkpoint", {
  title: "Get continuation checkpoint",
  description: "Compact checkpoint for one recorded session: request, last reply, files touched, recent actions with recorded or UNKNOWN outcomes, source status, and what was not captured, separated into observed facts, agent notes and inferences. Start here. Identify the session with session_ref (integer from list_sessions).",
  inputSchema: { ...sessionArgs },
  annotations: READ_ONLY
}, guarded((args) => buildCheckpoint(resolveSession(args))));

server.registerTool("get_source_status", {
  title: "Check whether the source app may still be working",
  description: "Fresh check of the source session: end-of-turn events, ChatGPT app process, transcript activity and usage-limit signals. Call before repeating an action or editing shared files.",
  inputSchema: { ...sessionArgs },
  annotations: { ...READ_ONLY, idempotentHint: false }
}, guarded((args) => sourceStatus(readEvents(resolveSession(args)))));

server.registerTool("get_events", {
  title: "Page through recorded events",
  description: "Compact rows of recorded events after a sequence number, optionally filtered by hook event name (UserPromptSubmit, PreToolUse, PostToolUse, Stop, Interrupt, SessionStart, SessionEnd, PreCompact).",
  inputSchema: {
    ...sessionArgs,
    after_seq: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(50).optional(),
    event: z.string().optional()
  },
  annotations: READ_ONLY
}, guarded(({ after_seq, limit, event, ...args }) => {
  const all = readEvents(resolveSession(args));
  const rows = all.filter((e) => e.seq > (after_seq ?? 0) && (!event || e.event === event)).slice(0, limit ?? 20);
  return { total: all.length, rows: rows.map(compact), next_after_seq: rows.at(-1)?.seq };
}));

server.registerTool("get_event", {
  title: "Get one recorded event in full",
  description: "Full stored detail of one event (tool input, tool result, prompt or final message), already redacted and size-bounded at capture.",
  inputSchema: { ...sessionArgs, seq: z.number().int().min(1) },
  annotations: READ_ONLY
}, guarded(({ seq, ...args }) => {
  const id = resolveSession(args);
  const event = readEvents(id).find((e) => e.seq === seq);
  if (!event) throw new Error(`No event ${seq} in session ${id}.`);
  return event;
}));

server.registerTool("list_project_files", {
  title: "List files in the recorded project",
  description: "List a directory inside the session's recorded project directory (read-only, max 200 entries).",
  inputSchema: { ...sessionArgs, dir: z.string().optional() },
  annotations: READ_ONLY
}, guarded(({ dir, ...args }) => {
  const { root, target, rel } = insideProject(resolveSession(args), dir);
  return listDir(root, target, rel);
}));

server.registerTool("read_project_file", {
  title: "Read a file in the recorded project",
  description: "Read part of a text file inside the session's recorded project directory. Secrets are redacted; credential files are refused.",
  inputSchema: {
    ...sessionArgs,
    path: z.string(),
    offset: z.number().int().min(0).optional(),
    max_chars: z.number().int().min(1).max(15_000).optional()
  },
  annotations: READ_ONLY
}, guarded(({ path: file, offset, max_chars, ...args }) => {
  const { target, rel } = insideProject(resolveSession(args), file);
  return readSlice(target, rel, offset, max_chars);
}));

// Imported capsules: separate, read-only tools. import_ref is its own integer
// space; it is never a session_ref.
const importArgs = { import_ref: z.number().int().optional(), import_id: z.string().optional() };

server.registerTool("list_imports", {
  title: "List capsules imported from another computer",
  description: "List task handoffs imported from another computer (via Session Capsule), newest first. Each row has an import_ref integer for the other import tools. These are history, not live sessions.",
  inputSchema: {},
  annotations: READ_ONLY
}, guarded(() => listImports().map((r) => {
  const { handoff } = readImport(r.imported_id);
  return {
    import_ref: r.import_ref,
    imported_id: r.imported_id,
    projectOnThisComputer: r.projectRoot,
    mode: r.mode,
    capturedAt: handoff.capturedAt,
    sourcePlatform: handoff.source.platform,
    firstRequest: String(handoff.events?.items?.find((e) => e.event === "UserPromptSubmit")?.prompt ?? "").slice(0, 160) || undefined
  };
})));

server.registerTool("get_imported_checkpoint", {
  title: "Get the checkpoint of an imported task",
  description: "Checkpoint of a task handed over from another computer: observed facts, agent notes, inferences and missing context as recorded there, the HISTORICAL source status (current source activity is unknown), and the state of recorded files in the project folder on this computer. Start here for imports; do not call get_source_status for them.",
  inputSchema: { ...importArgs },
  annotations: READ_ONLY
}, guarded((args) => importedCheckpoint(resolveImport(args))));

server.registerTool("get_imported_events", {
  title: "Page through an imported task's recorded events",
  description: "Compact rows of the events recorded on the source computer, in their original order and seq numbers, after a sequence number.",
  inputSchema: { ...importArgs, after_seq: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(50).optional(), event: z.string().optional() },
  annotations: READ_ONLY
}, guarded(({ after_seq, limit, event, ...args }) => {
  const items = readImport(resolveImport(args)).handoff.events?.items ?? [];
  const rows = items.filter((e) => e.seq > (after_seq ?? 0) && (!event || e.event === event)).slice(0, limit ?? 20);
  return { total: items.length, rows: rows.map(compact), next_after_seq: rows.at(-1)?.seq };
}));

server.registerTool("get_imported_event", {
  title: "Get one imported event in full",
  description: "Full detail of one event recorded on the source computer (redacted and size-bounded at capture and again at export).",
  inputSchema: { ...importArgs, seq: z.number().int().min(1) },
  annotations: READ_ONLY
}, guarded(({ seq, ...args }) => {
  const id = resolveImport(args);
  const event = (readImport(id).handoff.events?.items ?? []).find((e) => e.seq === seq);
  if (!event) throw new Error(`No event ${seq} in imported capsule ${id}.`);
  return event;
}));

server.registerTool("list_imported_project_files", {
  title: "List files in an imported task's project folder",
  description: "List a directory inside the project folder chosen on this computer for an imported task (read-only, max 200 entries).",
  inputSchema: { ...importArgs, dir: z.string().optional() },
  annotations: READ_ONLY
}, guarded(({ dir, ...args }) => {
  const { root, target, rel } = insideRoot(importProjectRoot(resolveImport(args)), dir);
  return listDir(root, target, rel);
}));

server.registerTool("read_imported_project_file", {
  title: "Read a file in an imported task's project folder",
  description: "Read part of a text file inside the project folder chosen on this computer for an imported task. Secrets are redacted; credential files are refused.",
  inputSchema: { ...importArgs, path: z.string(), offset: z.number().int().min(0).optional(), max_chars: z.number().int().min(1).max(15_000).optional() },
  annotations: READ_ONLY
}, guarded(({ path: file, offset, max_chars, ...args }) => {
  const { target, rel } = insideRoot(importProjectRoot(resolveImport(args)), file);
  return readSlice(target, rel, offset, max_chars);
}));

server.registerPrompt("continue_import", {
  title: "Continue a task imported from another computer",
  description: "Explicit continuation of a capsule imported from another computer, using the import tools.",
  argsSchema: { import_id: z.string() }
}, ({ import_id }) => ({
  messages: [{ role: "user", content: { type: "text", text: importedTakeoverPrompt(readImport(resolveImport({ import_id })).record, "manual continuation") } }]
}));

server.registerPrompt("continue_task", {
  title: "Continue a recorded Codex task",
  description: "Explicit takeover: continue a session recorded from the ChatGPT desktop app.",
  argsSchema: { session_id: z.string() }
}, ({ session_id }) => ({
  messages: [{ role: "user", content: { type: "text", text: takeoverPrompt(assertSessionId(session_id), "manual takeover") } }]
}));

// No arguments, so nothing for a client bridge to drop. It names the session it
// picked inside the message, which the user sees before sending.
server.registerPrompt("continue_latest", {
  title: "Continue the latest unfinished Codex task",
  description: "Explicit takeover of the newest unfinished session recorded from the ChatGPT desktop app. Lists the candidates instead of picking when the choice is ambiguous."
}, () => {
  const pick = pickLatestEligible();
  const line = (c) => `- session_ref ${c.session_ref}: ${c.project} — "${c.firstRequest ?? "(no request recorded)"}" (${c.reason}, last activity ${c.lastActivity})`;
  const text = pick.status === "picked"
    ? takeoverPrompt(pick.session.session_id, `manual takeover of the latest unfinished session (${pick.session.project})`)
    : pick.status === "ambiguous"
      ? `More than one recorded Codex task is unfinished, so none was chosen automatically:\n${pick.candidates.map(line).join("\n")}\nAsk me which one to continue, then follow the desktop-continuity takeover steps for that session_ref.`
      : "No unfinished recorded Codex task was found (completed and simulated sessions are excluded). Tell me so, and call list_sessions if I want to choose one anyway.";
  return { messages: [{ role: "user", content: { type: "text", text } }] };
});

// Call log: which tool arrived with which arguments, before validation. Claude
// Desktop's chat reaches this server through a bridge that does not appear in
// its own MCP logs, so this is the only record of what actually arrived.
// Arguments are redacted and cut short; this is local evidence, not telemetry.
const logCall = (msg) => {
  if (msg?.method !== "tools/call") return;
  try {
    mkdirSync(storeRoot(), { recursive: true });
    const args = redactSecrets(JSON.stringify(msg.params?.arguments ?? null)).slice(0, 300);
    appendFileSync(path.join(storeRoot(), "mcp-calls.log"), `${new Date().toISOString()} ${msg.params?.name} args=${args} paramKeys=${Object.keys(msg.params ?? {}).join(",")}\n`);
  } catch {}
};

const transport = new StdioServerTransport();
await server.connect(transport);
const deliver = transport.onmessage;
transport.onmessage = (msg, extra) => {
  logCall(msg);
  // Some bridges rename the argument; accept the obvious aliases rather than fail.
  const args = msg?.method === "tools/call" ? msg.params?.arguments : undefined;
  if (args && typeof args === "object" && args.session_id === undefined) {
    const alias = args.sessionId ?? args.sessionID ?? args.session ?? args.id;
    if (typeof alias === "string") args.session_id = alias;
  }
  deliver?.(msg, extra);
};
