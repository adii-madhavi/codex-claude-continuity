import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listSessionIds, readEvents, sessionRef, storeRoot } from "./store.mjs";

// Desktop takeover, through Claude Desktop's documented links
// (https://support.claude.com/en/articles/14729294); none of them sends anything.
// - claude://cowork/new?q=&folder= : on Claude Desktop 3.6556 this prefills the
//   prompt and attaches the project folder after the user confirms it. Used
//   whenever the recorded project folder exists.
// - claude://claude.ai/new?q= : opened an empty chat on 3.6556. Fallback.
// The prompt also goes on the clipboard in case the prefill does not arrive.
// Nothing here drives the Claude or ChatGPT UI.

export const takeoverPrompt = (sessionId, why) => [
  `Continue my interrupted Codex desktop task (recorded session ${sessionId}${why ? `; trigger: ${why}` : ""}).`,
  `1. Call the desktop-continuity tool get_checkpoint with session_ref ${sessionRef(sessionId)} (an integer). Read it first: it holds my requests and answers, the files written so far, actions with unknown outcomes, and remaining work inferred from those files.`,
  "2. Call get_source_status with the same session_ref. If the source may still be working, or the project changed after the last recorded event, stop and tell me.",
  "3. Do not ask me again for anything the checkpoint records; ask only about what it marks missing.",
  "4. Read the files under filesTouched and continue those same files: keep finished parts as they are and complete what remains. Do not write a replacement.",
  "5. Before your first edit, tell me in one line the evidence that the source stopped and which files you will change, and wait for my OK.",
  "6. Treat actions marked UNKNOWN as unconfirmed: check the files before repeating them."
].join("\n");

/** The recorded project folder, when it still exists on disk. */
const projectFolder = (sessionId) => {
  const cwd = readEvents(sessionId).findLast((e) => e.cwd)?.cwd;
  try {
    return cwd && statSync(cwd).isDirectory() ? cwd : undefined;
  } catch {
    return undefined;
  }
};

export const takeoverUrl = (sessionId, why, route = process.env.DESKTOP_CONTINUITY_ROUTE) => {
  const q = encodeURIComponent(takeoverPrompt(sessionId, why));
  const folder = route === "chat" ? undefined : projectFolder(sessionId);
  return folder ? `claude://cowork/new?q=${q}&folder=${encodeURIComponent(folder)}` : `claude://claude.ai/new?q=${q}`;
};

const launchesFile = () => path.join(storeRoot(), "takeover-launches.log");
const claimsFile = (sessionId) => path.join(storeRoot(), "sessions", `${sessionId}.takeover.json`);

/** True the first time a (session, key) pair is claimed, so one signal opens at most one chat. */
export const claimTakeover = (sessionId, key) => {
  let claims = [];
  try {
    claims = JSON.parse(readFileSync(claimsFile(sessionId), "utf8"));
  } catch {}
  if (claims.some((c) => c.key === key)) return false;
  mkdirSync(path.dirname(claimsFile(sessionId)), { recursive: true });
  writeFileSync(claimsFile(sessionId), JSON.stringify([...claims, { key, at: new Date().toISOString() }]));
  return true;
};

export const takeoverClaims = (sessionId) => {
  try {
    return JSON.parse(readFileSync(claimsFile(sessionId), "utf8"));
  } catch {
    return [];
  }
};

/** Resolves when clip.exe has finished (or after 2 s), so a caller that exits next does not cut it off. */
const copyToClipboard = (text) => new Promise((resolve) => {
  if (process.platform !== "win32") return resolve();
  // The prompt is ASCII, which clip.exe copies as-is (a UTF-16 BOM would be pasted too).
  const clip = spawn("clip", [], { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
  const timer = setTimeout(resolve, 2000);
  clip.on("error", () => { clearTimeout(timer); resolve(); });
  clip.on("close", () => { clearTimeout(timer); resolve(); });
  clip.stdin.on("error", () => {});
  clip.stdin.end(text.replace(/[^\x20-\x7E\n]/g, "?"));
});

export const openTakeover = async (sessionId, why) => {
  const dryRun = Boolean(process.env.DESKTOP_CONTINUITY_TAKEOVER_DRYRUN);
  const url = takeoverUrl(sessionId, why);
  try {
    mkdirSync(storeRoot(), { recursive: true });
    appendFileSync(launchesFile(), `${new Date().toISOString()} ${dryRun ? "dry-run" : "launch"} ${sessionId} via ${url.startsWith("claude://cowork") ? "cowork+folder" : "chat"} ${why}\n`);
  } catch {}
  if (dryRun) return;
  await copyToClipboard(takeoverPrompt(sessionId, why));
  // explorer.exe hands a URL to its registered protocol handler without a shell parsing it.
  const child = spawn(process.platform === "win32" ? "explorer.exe" : "xdg-open", [url], {
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.on("error", () => {});
  child.unref();
};

// `node src/takeover.mjs [session_id] [--again]`: the explicit takeover action
// (defaults to the most recent session). Refuses a second chat for a session
// that already had one unless --again is given.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const again = process.argv.includes("--again");
  const sessionId = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? listSessionIds()[0]?.id;
  if (!sessionId) {
    console.error("No recorded Codex session yet.");
    process.exit(1);
  }
  const earlier = takeoverClaims(sessionId);
  if (earlier.length && !again) {
    console.error(`A takeover chat was already opened for ${sessionId} (${earlier.map((c) => `${c.key} at ${c.at}`).join("; ")}).\nContinue in that chat, or pass --again to open another.`);
    process.exit(2);
  }
  claimTakeover(sessionId, `manual@${new Date().toISOString()}`);
  await openTakeover(sessionId, "manual takeover");
  console.log(takeoverUrl(sessionId, "").startsWith("claude://cowork")
    ? `Opened a Claude Desktop Cowork session for ${sessionId} with the prompt prefilled and its project folder attached.\nConfirm the folder, review the prompt, then press Send. (The prompt is also on the clipboard.)`
    : `Opened a new Claude Desktop chat for ${sessionId}; the continuation prompt is on the clipboard.\nPress Ctrl+V, review it, then press Send.`);
}
