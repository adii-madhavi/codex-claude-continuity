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

const LIMIT_TEXT = /usage limit|rate limit|quota|too many requests|try again (?:at|in)/i;

export const readUsageSignals = (file) => {
  const resolved = transcriptPath(file);
  if (!resolved) return { available: false, note: "No Codex transcript path was recorded for this session." };
  let lines;
  let mtimeMs;
  try {
    lines = tailLines(resolved);
    mtimeMs = statSync(resolved).mtimeMs;
  } catch {
    return { available: false, note: "The recorded Codex transcript could not be read." };
  }
  let rateLimits;
  const errors = [];
  let lastTurnEnd;
  for (const line of lines) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const p = record?.payload ?? {};
    if (record.type !== "event_msg") continue;
    if (p.type === "token_count" && p.rate_limits) rateLimits = { at: record.timestamp, ...p.rate_limits };
    if (p.type === "task_complete" || p.type === "turn_aborted") lastTurnEnd = { at: record.timestamp, type: p.type, reason: p.reason };
    if (/error/.test(String(p.type)) && LIMIT_TEXT.test(String(p.message ?? ""))) {
      errors.push({ at: record.timestamp, type: p.type, message: String(p.message).slice(0, 300) });
    }
  }
  const windows = ["primary", "secondary"].map((name) => rateLimits?.[name] && {
    window: name,
    usedPercent: rateLimits[name].used_percent,
    windowMinutes: rateLimits[name].window_minutes,
    resetsAt: rateLimits[name].resets_at ? new Date(rateLimits[name].resets_at * 1000).toISOString() : undefined
  }).filter(Boolean);
  return {
    available: true,
    note: "Read from Codex's local transcript (undocumented format). Best-effort; absence of a limit signal does not prove the limit was not hit.",
    transcriptModifiedAt: new Date(mtimeMs).toISOString(),
    rateLimitsObservedAt: rateLimits?.at,
    windows,
    limitErrors: errors.slice(-3),
    lastTurnEnd,
    limitReached: windows.some((w) => Number(w.usedPercent) >= 100) || errors.length > 0
  };
};

/** Whether the ChatGPT desktop app process is running (Windows). */
export const sourceAppRunning = () => {
  if (process.platform !== "win32") return undefined;
  try {
    return /ChatGPT\.exe/i.test(execFileSync("tasklist", ["/FI", "IMAGENAME eq ChatGPT.exe", "/NH"], { encoding: "utf8", windowsHide: true }));
  } catch {
    return undefined;
  }
};
