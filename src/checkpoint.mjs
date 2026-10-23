import { readEvents, listSessionIds, sessionRef } from "./store.mjs";
import { readUsageSignals, sourceAppRunning } from "./source.mjs";

// Checkpoint construction: a compact, bounded summary of one recorded session,
// built on demand from the timeline. It reports what was observed and labels
// what was not; it never upgrades a missing result to success.

const clip = (value, max = 1500) => {
  if (value === undefined || value === null) return undefined;
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return s.length > max ? `${s.slice(0, max)}…[${s.length - max} more chars]` : s;
};

const PATCH_FILE = /^\*\*\* (Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm;

/** Paths an action touched or tried to touch, from apply_patch headers or a file_path argument. */
const touchedFiles = (event) => {
  const input = event.input;
  const files = [];
  const patch = typeof input === "string" ? input : typeof input?.command === "string" ? input.command : typeof input?.patch === "string" ? input.patch : undefined;
  if (patch) for (const m of patch.matchAll(PATCH_FILE)) files.push({ path: (m[2] ?? m[3]).trim(), change: m[1] ?? "Move" });
  for (const key of ["file_path", "path"]) if (typeof input?.[key] === "string") files.push({ path: input[key], change: event.tool });
  return files;
};

/** Tool calls paired by tool_use_id. No PostToolUse means the outcome is unknown, not failed and not succeeded. */
export const pairActions = (events) => {
  const actions = new Map();
  for (const e of events) {
    if (e.event !== "PreToolUse" && e.event !== "PostToolUse") continue;
    const key = e.toolUseId ?? `seq-${e.seq}`;
    const action = actions.get(key) ?? { toolUseId: e.toolUseId, tool: e.tool, turn: e.turn, startedSeq: undefined, resultSeq: undefined };
    if (e.event === "PreToolUse") Object.assign(action, { startedSeq: e.seq, startedAt: e.ts, input: e.input });
    else Object.assign(action, { resultSeq: e.seq, finishedAt: e.ts, response: e.response, input: action.input ?? e.input });
    actions.set(key, action);
  }
  return [...actions.values()].map((a) => ({
    ...a,
    outcome: a.resultSeq ? "result recorded" : "UNKNOWN: no result was recorded; verify before repeating",
    files: touchedFiles(a)
  }));
};

const turnStatus = (events) => {
  const lastPrompt = events.findLast((e) => e.event === "UserPromptSubmit");
  const after = lastPrompt ? events.filter((e) => e.seq > lastPrompt.seq) : events;
  const end = after.findLast((e) => ["Stop", "Interrupt", "SessionEnd"].includes(e.event));
  if (!lastPrompt) return { state: "no request recorded", detail: "Recording may have started mid-session." };
  if (end?.event === "Stop") return { state: "turn ended", detail: "Codex reported the end of the turn (Stop hook). This does not prove the task is finished." };
  if (end?.event === "Interrupt") return { state: "interrupted", detail: "The user interrupted the turn in the source app." };
  if (end?.event === "SessionEnd") return { state: "session ended", detail: `Session ended (${end.reason ?? "no reason given"}).` };
  return {
    state: "no end of turn recorded",
    detail: "The source may still be working, or it stopped abruptly (usage limit, crash, closed app). Check get_source_status before acting."
  };
};

export const sourceStatus = (events) => {
  const last = events.at(-1);
  const transcript = events.findLast((e) => e.transcript)?.transcript;
  const usage = readUsageSignals(transcript);
  const running = sourceAppRunning();
  const modifiedAgoSec = usage.transcriptModifiedAt ? Math.round((Date.now() - Date.parse(usage.transcriptModifiedAt)) / 1000) : undefined;
  const status = turnStatus(events);
  const mayStillBeWorking = running !== false && status.state === "no end of turn recorded" && !usage.limitReached &&
    (modifiedAgoSec === undefined || modifiedAgoSec < 180);
  return {
    checkedAt: new Date().toISOString(),
    chatgptAppRunning: running ?? "unknown",
    lastRecordedEventAt: last?.ts,
    transcriptModifiedSecondsAgo: modifiedAgoSec,
    turn: status,
    usage,
    mayStillBeWorking,
    advice: mayStillBeWorking
      ? "The source app may still be working on this task. Do not repeat actions or edit shared files; ask the user to confirm it has stopped."
      : "No sign of ongoing work was observed. Still inspect files before repeating any action whose outcome is unknown."
  };
};

export const sessionSummary = (id) => {
  const events = readEvents(id);
  const first = events.find((e) => e.event === "UserPromptSubmit");
  return {
    session_ref: sessionRef(id),
    session_id: id,
    project: events.findLast((e) => e.cwd)?.cwd,
    firstRequest: clip(first?.prompt, 160),
    events: events.length,
    lastActivity: events.at(-1)?.ts,
    turn: turnStatus(events).state
  };
};

export const buildCheckpoint = (id) => {
  const events = readEvents(id);
  if (events.length === 0) throw new Error(`No events recorded for session ${id}.`);
  const prompts = events.filter((e) => e.event === "UserPromptSubmit");
  const actions = pairActions(events);
  const files = new Map();
  for (const a of actions) for (const f of a.files) files.set(f.path, { path: f.path, change: f.change, outcome: a.outcome, seq: a.startedSeq ?? a.resultSeq });
  const lastReply = events.findLast((e) => e.lastAssistantMessage);
  return {
    session_ref: sessionRef(id),
    session_id: id,
    source: "ChatGPT desktop app (Codex or local Work thread), captured by the desktop-continuity Codex plugin's hooks",
    project: events.findLast((e) => e.cwd)?.cwd,
    model: events.findLast((e) => e.model)?.model,
    recordedEvents: events.length,
    firstRecordedAt: events[0].ts,
    originalRequest: clip(prompts[0]?.prompt),
    latestRequest: prompts.length > 1 ? clip(prompts.at(-1).prompt) : undefined,
    requestCount: prompts.length,
    lastAssistantMessage: lastReply
      ? { seq: lastReply.seq, at: lastReply.ts, text: clip(lastReply.lastAssistantMessage, 2000) }
      : "None recorded. Hooks only see the final message of a completed turn.",
    filesTouched: [...files.values()].slice(-30),
    recentActions: actions.slice(-15).map((a) => ({
      seq: a.startedSeq ?? a.resultSeq,
      tool: a.tool,
      input: clip(a.input, 300),
      outcome: a.outcome,
      result: a.response === undefined ? undefined : clip(a.response, 300)
    })),
    unknownOutcomes: actions.filter((a) => !a.resultSeq).length,
    sourceStatus: sourceStatus(events),
    notCaptured: [
      "Hidden reasoning, unsaved editor state, and anything not sent to a hook.",
      "Assistant messages between tool calls (only the final message of each completed turn is recorded).",
      "ChatGPT Chat-mode conversations and cloud Work threads (hooks do not run there)."
    ]
  };
};

export const listSessions = (project, limit = 10) =>
  listSessionIds()
    .map(({ id }) => id)
    .slice(0, 200)
    .map(sessionSummary)
    .filter((s) => !project || (s.project && s.project.toLowerCase().includes(String(project).toLowerCase())))
    .slice(0, limit);
