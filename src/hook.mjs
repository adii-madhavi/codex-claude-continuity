// Capture: a Codex command hook (documented at https://learn.chatgpt.com/docs/hooks).
// Codex runs it with one JSON payload on stdin for each configured event in
// Codex threads and local-only Work threads of the ChatGPT desktop app. It
// appends one redacted, size-bounded event and exits 0 with no output, which
// Codex treats as "continue". It must never block or fail the source app.

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { sanitize } from "./redact.mjs";
import { appendEvent, storeRoot } from "./store.mjs";
import { readUsageSignals } from "./source.mjs";
import { openTakeover } from "./takeover.mjs";

const read = async () => {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  // A byte-order mark (PowerShell pipes add one) is not part of the JSON.
  return JSON.parse(Buffer.concat(chunks).toString("utf8").replace(/^﻿/, ""));
};

// One line per run (no content), so a hook that runs but cannot record is
// visible: the store's hook-runs.log, or the temp folder if the store is not writable.
const logRun = (line) => {
  for (const dir of [storeRoot(), os.tmpdir()]) {
    try {
      mkdirSync(dir, { recursive: true });
      appendFileSync(path.join(dir, dir === storeRoot() ? "hook-runs.log" : "desktop-continuity-hook-errors.log"), `${new Date().toISOString()} ${line}\n`);
      return;
    } catch {}
  }
};

// Strings are redacted and truncated per field; objects keep their shape so a
// patch or command stays readable.
const text = (value, max) => (value === undefined || value === null ? undefined : sanitize(value, max));

const toEvent = (p) => ({
  v: 1,
  ts: new Date().toISOString(),
  source: "codex-hook",
  session: p.session_id,
  event: p.hook_event_name,
  cwd: p.cwd,
  model: p.model,
  turn: p.turn_id,
  transcript: p.transcript_path ?? undefined,
  tool: p.tool_name,
  toolUseId: p.tool_use_id,
  input: text(p.tool_input, 2000),
  // Only PostToolUse carries a result. Its absence is recorded as absence, never as success.
  response: text(p.tool_response, 4000),
  prompt: text(p.prompt, 4000),
  lastAssistantMessage: text(p.last_assistant_message, 4000),
  startSource: p.source,
  reason: p.reason,
  agentType: p.agent_type
});

// Automatic takeover where it is supported: a turn that ends while the local
// transcript shows a usage window at 100% opens Claude Desktop with a
// prefilled continuation prompt (claude:// links only prefill; the user sends).
const maybeAutoTakeover = (event) => {
  if (event.event !== "Stop" || process.env.DESKTOP_CONTINUITY_NO_AUTO_TAKEOVER) return;
  const usage = readUsageSignals(event.transcript);
  if (!usage.limitReached) return;
  const marker = path.join(storeRoot(), "sessions", `${event.session}.takeover-opened`);
  if (existsSync(marker)) return;
  writeFileSync(marker, new Date().toISOString());
  openTakeover(event.session, "usage limit reported in the local Codex transcript");
};

let event;
try {
  event = toEvent(await read());
  appendEvent(event);
  logRun(`ok ${event.event} ${event.session}`);
  maybeAutoTakeover(event);
} catch (error) {
  // Recording is best-effort; Codex must continue regardless.
  const message = error instanceof Error ? error.message : String(error);
  logRun(`error ${event?.event ?? "?"} ${event?.session ?? "?"} cwd=${process.cwd()} LOCALAPPDATA=${process.env.LOCALAPPDATA ?? "unset"}: ${message.slice(0, 300)}`);
  try {
    process.stderr.write(`desktop-continuity hook: ${message}\n`);
  } catch {}
}
process.exit(0);
