import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { redactSecrets } from "./redact.mjs";
import { readEvents, listSessionIds, sessionRef } from "./store.mjs";
import { readAgentMessages, readUsageSignals, sourceAppRunning } from "./source.mjs";

export const SKIP_DIRS = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", "dist", "build", ".next"]);
export const SECRET_FILE = /(^|[\\/])(\.env(\..*)?|.*\.(pem|key|p12|pfx)|id_(rsa|ed25519|ecdsa)|auth\.json|\.npmrc|\.netrc)$/i;
const UNFINISHED = /\b(TODO|TBD|FIXME|XXX)\b|\[(?:unfinished|incomplete|to be written)\]/i;
const MAX_SCAN = 2000;

/** Files under root modified after `sinceMs` (bounded walk, skips dependency folders). */
const changedSince = (root, sinceMs) => {
  const changed = [];
  let seen = 0;
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of entries) {
      if (++seen > MAX_SCAN || changed.length >= 20) return;
      const full = path.join(dir, d.name);
      if (d.isDirectory()) {
        if (!SKIP_DIRS.has(d.name)) walk(full);
      } else {
        try {
          const m = statSync(full).mtimeMs;
          if (m > sinceMs) changed.push({ path: path.relative(root, full), modifiedAt: new Date(m).toISOString() });
        } catch {}
      }
    }
  };
  walk(root);
  return { changed, truncated: seen > MAX_SCAN };
};

/** Current on-disk state of a touched file, read only when it resolves inside the project. */
const artifactState = (project, file, lastEventMs) => {
  try {
    const root = realpathSync(project);
    const target = realpathSync(path.resolve(root, file));
    const rel = path.relative(root, target);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return { exists: "outside project; not inspected" };
    const info = statSync(target);
    const state = { exists: true, relativePath: rel, bytes: info.size, modifiedAt: info.mtime.toISOString(), modifiedAfterLastEvent: info.mtimeMs > lastEventMs + 2000 };
    if (SECRET_FILE.test(target)) return { ...state, contents: "credential file; not inspected" };
    if (info.size > 1_000_000) return state;
    let heading;
    const unfinished = [];
    readFileSync(target, "utf8").split(/\r?\n/).forEach((line, i) => {
      if (/^#{1,6}\s/.test(line)) heading = line.trim();
      if (UNFINISHED.test(line) && unfinished.length < 15) unfinished.push({ line: i + 1, under: heading, text: redactSecrets(line.trim()).slice(0, 160) });
    });
    return { ...state, unfinished };
  } catch {
    return { exists: false };
  }
};

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
  // A SessionEnd after a Stop/Interrupt only closes the thread; the turn's own end decides.
  const end = after.findLast((e) => e.event === "Stop" || e.event === "Interrupt") ?? after.findLast((e) => e.event === "SessionEnd");
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
  const project = events.findLast((e) => e.cwd)?.cwd;
  // Files changed after the last recorded event: the source (or someone) kept
  // working without a hook seeing it, so the recording may be stale.
  const lastMs = Date.parse(last?.ts ?? 0);
  const projectChanges = project ? changedSince(project, lastMs + 2000) : { changed: [] };
  const recentChange = projectChanges.changed.some((c) => Date.now() - Date.parse(c.modifiedAt) < 120_000);
  const mayStillBeWorking = running !== false && (recentChange ||
    (status.state === "no end of turn recorded" && !usage.limitReached && (modifiedAgoSec === undefined || modifiedAgoSec < 180)));
  return {
    checkedAt: new Date().toISOString(),
    chatgptAppRunning: running ?? "unknown",
    lastRecordedEventAt: last?.ts,
    transcriptModifiedSecondsAgo: modifiedAgoSec,
    turn: status,
    usage,
    projectChangedAfterLastEvent: projectChanges.changed,
    mayStillBeWorking,
    // The gate a destination must respect before changing shared files. It is
    // advisory (this server cannot block writes made by other tools), so the
    // takeover prompt also requires the user's OK before the first edit.
    destinationMayEdit: !mayStillBeWorking,
    advice: mayStillBeWorking
      ? "The source app may still be working on this task. Do not repeat actions or edit shared files; ask the user to confirm it has stopped."
      : projectChanges.changed.length
        ? "Project files changed after the last recorded event, so the checkpoint may be stale. Read those files before relying on it."
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
    turn: turnStatus(events).state,
    ...(events.some((e) => e.simulated) ? { simulated: true } : {}),
    // No transcript path at all: an ephemeral thread, e.g. the app's own background
    // suggestions (hooks document transcript_path as nullable).
    ...(events.length && !events.some((e) => e.transcript) ? { ephemeral: true } : {})
  };
};

const ELIGIBLE_STATES = new Set(["interrupted", "no end of turn recorded", "session ended"]);
const AMBIGUITY_WINDOW_MS = 12 * 3600_000;

/**
 * The session continue_latest may take over: the newest non-simulated session
 * that is unfinished (interrupted, never ended, limit reached, or with
 * unfinished markers in its files). If another unfinished session from a
 * different project was active within 12 hours of it, the choice is ambiguous
 * and nothing is picked. Completed tasks are never picked.
 */
export const pickLatestEligible = (scan = 20) => {
  const candidates = [];
  for (const { id } of listSessionIds().slice(0, scan)) {
    const s = sessionSummary(id);
    if (s.simulated || s.ephemeral || s.events === 0) continue;
    const cp = buildCheckpoint(id);
    const artifacts = cp.observed.artifacts.filter((a) => a.now.exists === true);
    // Interrupted, but every touched file is now marker-free and was changed after
    // the recording ended: someone already continued it. Not offered again.
    const continuedElsewhere = artifacts.length > 0 && cp.inferred.remainingWork.length === 0 && artifacts.some((a) => a.now.modifiedAfterLastEvent);
    let reason = ELIGIBLE_STATES.has(s.turn) && !continuedElsewhere ? `turn ${s.turn}` : undefined;
    if (!reason && cp.sourceStatus.usage.status === "limit_reached") reason = "usage limit reached";
    if (!reason && cp.inferred.remainingWork.length) reason = `${cp.inferred.remainingWork.length} unfinished marker(s) in touched files`;
    if (reason) candidates.push({ ...s, reason });
  }
  if (candidates.length === 0) return { status: "none", candidates };
  const [first, ...rest] = candidates;
  const rivals = rest.filter((c) => c.project?.toLowerCase() !== first.project?.toLowerCase() &&
    Date.parse(first.lastActivity) - Date.parse(c.lastActivity) < AMBIGUITY_WINDOW_MS);
  return rivals.length ? { status: "ambiguous", candidates: [first, ...rivals] } : { status: "picked", session: first, candidates };
};

export const buildCheckpoint = (id) => {
  const events = readEvents(id);
  if (events.length === 0) throw new Error(`No events recorded for session ${id}.`);
  const project = events.findLast((e) => e.cwd)?.cwd;
  const lastMs = Date.parse(events.at(-1).ts);
  const prompts = events.filter((e) => e.event === "UserPromptSubmit");
  const actions = pairActions(events);
  const files = new Map();
  for (const a of actions) for (const f of a.files) files.set(f.path.toLowerCase(), { path: f.path, change: f.change, outcome: a.outcome, seq: a.startedSeq ?? a.resultSeq });
  // Codex desktop also writes files through shell commands (PowerShell Set-Content
  // etc.), which name no file in a structured field. So also list every project file
  // whose on-disk mtime falls inside the recorded session, whatever wrote it.
  if (project) {
    const firstMs = Date.parse(events[0].ts) - 2000;
    // Files changed after the recording stay listed (now.modifiedAfterLastEvent is set),
    // so a file the source wrote and someone later finished is not dropped.
    for (const c of changedSince(project, firstMs).changed) {
      const key = path.resolve(project, c.path).toLowerCase();
      if (![...files.keys()].some((k) => path.resolve(project, k).toLowerCase() === key)) {
        const after = Date.parse(c.modifiedAt) > lastMs + 2000;
        files.set(c.path.toLowerCase(), {
          path: c.path,
          change: after ? "changed on disk after the recording ended (by the source or someone else)" : "modified on disk during the session (writing tool not identified)",
          outcome: "observed on disk"
        });
      }
    }
  }
  const artifacts = [...files.values()].slice(-30).map((f) => ({ ...f, now: project ? artifactState(project, f.path, lastMs) : { exists: "unknown" } }));
  const finalMessages = events.filter((e) => e.lastAssistantMessage).slice(-3);
  const transcript = events.findLast((e) => e.transcript)?.transcript;
  const transcriptMessages = readAgentMessages(transcript).map((m) => ({ ...m, text: redactSecrets(m.text) }));
  const remaining = artifacts.flatMap((a) => (a.now.unfinished ?? []).map((u) => ({ file: a.now.relativePath ?? a.path, ...u })));
  const status = sourceStatus(events);
  const missing = [
    "Hidden reasoning, unsaved editor state, and text streamed but never completed as a message.",
    "ChatGPT Chat-mode conversations and cloud Work threads (hooks do not run there)."
  ];
  if (finalMessages.length === 0) missing.push("No final assistant message: no turn was recorded as completed.");
  if (transcriptMessages.length === 0) missing.push("No completed assistant messages found in the transcript tail.");
  if (status.projectChangedAfterLastEvent.length) missing.push("STALE: project files changed after the last recorded event (see sourceStatus).");
  if (artifacts.some((a) => a.now.exists === false)) missing.push("Some recorded files no longer exist on disk.");
  if (events.some((e) => e.simulated)) missing.unshift("SIMULATED: this session contains events produced by a test trigger, not by Codex.");
  return {
    session_ref: sessionRef(id),
    session_id: id,
    source: "ChatGPT desktop app (Codex or local Work thread), captured by the desktop-continuity Codex plugin's hooks",
    project,
    model: events.findLast((e) => e.model)?.model,
    recordedEvents: events.length,
    firstRecordedAt: events[0].ts,
    lastRecordedAt: events.at(-1).ts,
    observed: {
      note: "Recorded by hooks as it happened, or read from disk now.",
      userMessages: prompts.slice(-10).map((p) => ({ seq: p.seq, at: p.ts, text: clip(p.prompt) })),
      artifacts,
      recentActions: actions.slice(-15).map((a) => ({
        seq: a.startedSeq ?? a.resultSeq,
        tool: a.tool,
        input: clip(a.input, 300),
        outcome: a.outcome,
        result: a.response === undefined ? undefined : clip(a.response, 300)
      })),
      unknownOutcomes: actions.filter((a) => !a.resultSeq).length
    },
    agentNotes: {
      note: "Written by the source agent. Its statements are claims, not verified facts.",
      finalMessages: finalMessages.map((e) => ({ seq: e.seq, at: e.ts, provenance: "Stop hook", text: clip(e.lastAssistantMessage, 1500) })),
      transcriptMessages: transcriptMessages.map((m) => ({ ...m, provenance: "Codex local transcript (undocumented format), completed messages only" }))
    },
    inferred: {
      note: "Derived by desktop-continuity from file contents, not recorded intent. Confirm before relying on it.",
      remainingWork: remaining,
      nextStep: remaining[0] ? `Complete ${remaining[0].file}${remaining[0].under ? ` under "${remaining[0].under}"` : ""} (line ${remaining[0].line}).` : "No unfinished markers found in touched files."
    },
    sourceStatus: status,
    missing
  };
};

export const listSessions = (project, limit = 10) =>
  listSessionIds()
    .map(({ id }) => id)
    .slice(0, 200)
    .map(sessionSummary)
    .filter((s) => !project || (s.project && s.project.toLowerCase().includes(String(project).toLowerCase())))
    .slice(0, limit);
