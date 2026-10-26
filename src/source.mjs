import { execFileSync } from "node:child_process";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Read-only signals about the source app. Everything here is labelled
// best-effort: the transcript is Codex's local session file, which the hooks
// docs call "not a stable interface", and a process list says the app is open,
// not that a turn is still running.

const codexHome = () => process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
const TAIL_BYTES = 512 * 1024;

/** Only transcripts inside the Codex home are read; a recorded path is never a general file read. */
const transcriptPath = (file) => {
  if (typeof file !== "string" || !file.endsWith(".jsonl")) return undefined;
  const resolved = path.resolve(file);
  const home = path.resolve(codexHome()) + path.sep;
  return resolved.toLowerCase().startsWith(home.toLowerCase()) ? resolved : undefined;
};

const tailLines = (file) => {
  const fd = openSync(file, "r");
  try {
    const { size } = statSync(file);
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString("utf8").split("\n");
    if (length < size) lines.shift(); // partial first line
    return lines;
  } finally {
    closeSync(fd);
  }
};

// Limit detection reads structured records only, never prose: an agent or user
// message that *mentions* a usage limit is not a limit. The shapes below are
// the ones Codex 0.163 (desktop 26.1016) ships in codex.exe: an `error` event
// whose codex_error_info names a limit variant, the "You’ve hit your usage
// limit" message, and rate_limit_reached_type / used_percent in token_count.
// No real limit has been observed on this machine; see scripts/fixtures/limits.
const LIMIT_ERROR_INFO = /usage_limit|quota_exceeded|credits_depleted/i;
const LIMIT_MESSAGE = /hit your usage limit/i;
const APPROACHING_PERCENT = 80;
const KNOWN_TYPES = new Set(["session_meta", "event_msg", "response_item", "turn_context", "compacted", "world_state", "token_usage_record"]);

/**
 * Classifies transcript lines as limit_reached | approaching | no_limit_signal | unknown.
 * "unknown" means no record this code recognizes was found, so nothing can be
 * concluded; it is never upgraded to a limit or to "no limit".
 */
export const classifyLimit = (lines) => {
  let recognized = 0;
  let unparsed = 0;
  let lastLimit;
  let lastWindows;
  let lastActivityAfterLimit;
  let lastTurnEnd;
  let lastLineTorn = false;
  const evidence = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
      lastLineTorn = false;
    } catch {
      unparsed += 1; // truncated or torn line: skipped, never guessed at
      lastLineTorn = true;
      continue;
    }
    if (!KNOWN_TYPES.has(record?.type)) continue;
    recognized += 1;
    const p = record.payload ?? {};
    if (record.type !== "event_msg") continue;
    const at = record.timestamp;
    if (p.type === "error" && (LIMIT_ERROR_INFO.test(JSON.stringify(p.codex_error_info ?? "")) || LIMIT_MESSAGE.test(String(p.message ?? "")))) {
      lastLimit = { at, kind: "error event", detail: String(p.message ?? p.codex_error_info).slice(0, 200) };
      evidence.push(lastLimit);
      lastActivityAfterLimit = undefined;
    } else if (p.type === "token_count" && p.rate_limits) {
      const r = p.rate_limits;
      lastWindows = { at, windows: ["primary", "secondary"].filter((w) => r[w]).map((w) => ({
        window: w,
        usedPercent: r[w].used_percent,
        windowMinutes: r[w].window_minutes,
        resetsAt: r[w].resets_at ? new Date(r[w].resets_at * 1000).toISOString() : undefined
      })) };
      // At the real limit seen on this machine (2026-10-20) Codex wrote used_percent 100 with
      // rate_limit_reached_type null and no error record, then a snapshot with primary: null.
      // An empty snapshot says nothing; a window below 100% after the limit means it reset.
      if (r.rate_limit_reached_type || lastWindows.windows.some((w) => Number(w.usedPercent) >= 100)) {
        lastLimit = { at, kind: "rate limit snapshot", detail: r.rate_limit_reached_type ?? "a usage window at 100%", windows: lastWindows.windows };
        evidence.push(lastLimit);
        lastActivityAfterLimit = undefined;
      } else if (lastLimit?.windows?.some((lw) => lastWindows.windows.some((w) => w.window === lw.window && Number(w.usedPercent) < 100))) {
        lastActivityAfterLimit = at;
      }
    } else if (p.type === "task_started" && lastLimit) {
      lastActivityAfterLimit = at; // work resumed after the limit (e.g. reset or model switch)
    }
    if (p.type === "task_complete" || p.type === "turn_aborted") lastTurnEnd = { at, type: p.type, reason: p.reason };
  }
  const base = { recognizedRecords: recognized, unparsedLines: unparsed, windows: lastWindows?.windows ?? [], rateLimitsObservedAt: lastWindows?.at, lastTurnEnd };
  if (recognized === 0) return { ...base, status: "unknown", detail: "No record in a recognized Codex transcript shape; nothing can be concluded." };
  if (lastLimit && !lastActivityAfterLimit) {
    return { ...base, status: "limit_reached", signal: lastLimit, signalCount: evidence.length };
  }
  if (lastLineTorn) return { ...base, status: "unknown", detail: "The newest record is truncated, so the latest state cannot be read." };
  const approaching = (lastWindows?.windows ?? []).some((w) => Number(w.usedPercent) >= APPROACHING_PERCENT);
  return {
    ...base,
    status: approaching ? "approaching" : "no_limit_signal",
    ...(lastActivityAfterLimit ? { detail: `A limit was signalled at ${lastLimit.at}, but work started again at ${lastActivityAfterLimit}.` } : {})
  };
};

export const readUsageSignals = (file) => {
  const resolved = transcriptPath(file);
  if (!resolved) return { available: false, status: "unknown", limitReached: false, note: "No Codex transcript path was recorded for this session." };
  let lines;
  let mtimeMs;
  try {
    lines = tailLines(resolved);
    mtimeMs = statSync(resolved).mtimeMs;
  } catch {
    return { available: false, status: "unknown", limitReached: false, note: "The recorded Codex transcript could not be read." };
  }
  const result = classifyLimit(lines);
  return {
    available: true,
    note: "Read from Codex's local transcript (undocumented format). Best-effort; no_limit_signal does not prove the limit was not hit.",
    transcriptModifiedAt: new Date(mtimeMs).toISOString(),
    ...result,
    limitReached: result.status === "limit_reached"
  };
};

/** Completed agent messages from the transcript tail (provenance: undocumented local format). */
export const readAgentMessages = (file, max = 5) => {
  const resolved = transcriptPath(file);
  if (!resolved) return [];
  try {
    const messages = [];
    for (const line of tailLines(resolved)) {
      try {
        const r = JSON.parse(line);
        const item = r?.payload?.item;
        // Desktop 26.1016 writes completed assistant messages as item_completed/AgentMessage
        // with content [{ type: "Text", text }]; streamed text that never completed is absent.
        if (r?.type === "event_msg" && r.payload.type === "item_completed" && item?.type === "AgentMessage" && Array.isArray(item.content)) {
          const text = item.content.map((c) => c?.text).filter((t) => typeof t === "string").join("\n");
          if (text) messages.push({ at: r.timestamp, phase: item.phase, text: text.slice(0, 600) });
        }
      } catch {}
    }
    return messages.slice(-max);
  } catch {
    return [];
  }
};

/** Whether the ChatGPT desktop app process is running (Windows and macOS; undefined elsewhere). */
export const sourceAppRunning = () => {
  try {
    if (process.platform === "win32") {
      return /ChatGPT\.exe/i.test(execFileSync("tasklist", ["/FI", "IMAGENAME eq ChatGPT.exe", "/NH"], { encoding: "utf8", windowsHide: true }));
    }
    if (process.platform === "darwin") {
      // pgrep exits 1 (throws) when no process matches.
      return execFileSync("pgrep", ["-x", "ChatGPT"], { encoding: "utf8" }).trim().length > 0;
    }
  } catch {
    return process.platform === "darwin" ? false : undefined;
  }
  return undefined;
};
