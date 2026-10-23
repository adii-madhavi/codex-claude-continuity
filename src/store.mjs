import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Durable local timeline: one append-only JSONL file per Codex thread
// (`<store>/sessions/<session_id>.jsonl`). Each hook process appends one line
// as the event happens, so whatever was observed survives the app or its model
// stopping. Readers skip unparseable lines, including a torn final line.

// Codex runs hooks inside its sandbox, where only a plugin's PLUGIN_DATA folder
// is documented as writable. The MCP server (outside Codex) reads the same
// folder: ~/.codex/plugins/data/<plugin>-<marketplace>.
export const MARKETPLACE = "personal";
export const storeRoot = () =>
  process.env.DESKTOP_CONTINUITY_HOME ??
  process.env.PLUGIN_DATA ??
  path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"), "plugins", "data", `desktop-continuity-${MARKETPLACE}`);

const sessionsDir = () => path.join(storeRoot(), "sessions");

// Validating the shape is also what keeps a requested id from becoming a path.
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,80}$/;

export const assertSessionId = (id) => {
  if (typeof id !== "string" || !SESSION_ID.test(id)) throw new Error(`Not a recorded session id: ${JSON.stringify(String(id).slice(0, 80))}`);
  return id;
};

const sessionFile = (id) => path.join(sessionsDir(), `${assertSessionId(id)}.jsonl`);

/**
 * A stable integer per session: the first 12 hex digits of its id (for Codex's
 * UUIDv7 ids, the creation time in ms). Claude Desktop 3.6556's chat bridge
 * delivered integer tool arguments but dropped the string session_id, so tools
 * also accept this. Null when the id does not start with 12 hex digits.
 */
export const sessionRef = (id) => {
  const hex = id.replace(/-/g, "").slice(0, 12);
  return /^[0-9a-f]{12}$/i.test(hex) ? Number.parseInt(hex, 16) : null;
};

/** The one session named by session_id or session_ref; never a guess. */
export const resolveSession = ({ session_id, session_ref } = {}) => {
  if (typeof session_id === "string" && session_id) return assertSessionId(session_id);
  if (Number.isSafeInteger(session_ref)) {
    const matches = listSessionIds().filter(({ id }) => sessionRef(id) === session_ref);
    if (matches.length === 1) return matches[0].id;
    throw new Error(matches.length ? `session_ref ${session_ref} is ambiguous; pass session_id.` : `No recorded session has session_ref ${session_ref}.`);
  }
  throw new Error("Pass session_ref (an integer from list_sessions) or session_id.");
};

/** One write per event; the line is complete or (if the process dies mid-write) skipped by readers. */
export const appendEvent = (event) => {
  mkdirSync(sessionsDir(), { recursive: true });
  appendFileSync(sessionFile(event.session), `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
};

/** Events in recorded order; `seq` is the 1-based line position among valid events. */
export const readEvents = (id) => {
  let text;
  try {
    text = readFileSync(sessionFile(id), "utf8");
  } catch {
    return [];
  }
  const events = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push({ seq: events.length + 1, ...JSON.parse(line) });
    } catch {
      // torn or corrupt line: skipped, never guessed at
    }
  }
  return events;
};

/** Recorded sessions, most recently active first. */
export const listSessionIds = () => {
  try {
    return readdirSync(sessionsDir())
      .filter((name) => name.endsWith(".jsonl") && SESSION_ID.test(name.slice(0, -6)))
      .map((name) => ({ id: name.slice(0, -6), mtimeMs: statSync(path.join(sessionsDir(), name)).mtimeMs }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch {
    return [];
  }
};

export const sameProject = (a, b) =>
  typeof a === "string" && typeof b === "string" && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
