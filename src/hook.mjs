// Capture: a Codex command hook (documented at https://learn.chatgpt.com/docs/hooks).
// Codex runs it with one JSON payload on stdin for each configured event in
// Codex threads and local-only Work threads of the ChatGPT desktop app. It
// appends one redacted, size-bounded event and exits 0 with no output, which
// Codex treats as "continue". It must never block or fail the source app.

import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { sanitize } from "./redact.mjs";
import { appendEvent, storeRoot } from "./store.mjs";
import { readUsageSignals } from "./source.mjs";
import { openTakeover } from "./takeover.mjs";

const read = async () => {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
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

try {
  const event = toEvent(await read());
  appendEvent(event);
  maybeAutoTakeover(event);
} catch (error) {
  // Recording is best-effort; Codex must continue regardless.
  try {
    process.stderr.write(`desktop-continuity hook: ${error instanceof Error ? error.message : String(error)}\n`);
  } catch {}
}
process.exit(0);
