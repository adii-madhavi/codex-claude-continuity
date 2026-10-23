import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listSessionIds, sessionRef, storeRoot } from "./store.mjs";

// Desktop takeover. Claude Desktop's documented `claude://claude.ai/new?q=`
// link opens a new chat and should prefill the prompt
// (https://support.claude.com/en/articles/14729294); it never sends it. Claude
// Desktop 3.6556 on Windows opened the chat but left the box empty, so the
// prompt also goes on the clipboard: takeover is Ctrl+V and Send. Nothing here
// drives the Claude or ChatGPT UI.

export const takeoverPrompt = (sessionId, why) => [
  `Continue my interrupted Codex desktop task (recorded session ${sessionId}${why ? `; trigger: ${why}` : ""}).`,
  `1. Call the desktop-continuity tool get_checkpoint with session_ref ${sessionRef(sessionId)} (an integer). Read it first: it holds my requests and answers, the files written so far, actions with unknown outcomes, and remaining work inferred from those files.`,
  "2. Call get_source_status with the same session_ref. If the source may still be working, or the project changed after the last recorded event, stop and tell me.",
  "3. Do not ask me again for anything the checkpoint records; ask only about what it marks missing.",
  "4. Read the files under filesTouched and continue those same files: keep finished parts as they are and complete what remains. Do not write a replacement.",
  "5. Before your first edit, tell me in one line the evidence that the source stopped and which files you will change, and wait for my OK.",
  "6. Treat actions marked UNKNOWN as unconfirmed: check the files before repeating them."
].join("\n");

export const takeoverUrl = (sessionId, why) => `claude://claude.ai/new?q=${encodeURIComponent(takeoverPrompt(sessionId, why))}`;

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
  try {
    mkdirSync(storeRoot(), { recursive: true });
    appendFileSync(launchesFile(), `${new Date().toISOString()} ${dryRun ? "dry-run" : "launch"} ${sessionId} ${why}\n`);
  } catch {}
  if (dryRun) return;
  await copyToClipboard(takeoverPrompt(sessionId, why));
  // explorer.exe hands a URL to its registered protocol handler without a shell parsing it.
  const child = spawn(process.platform === "win32" ? "explorer.exe" : "xdg-open", [takeoverUrl(sessionId, why)], {
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
  console.log(`Opened a new Claude Desktop chat for session ${sessionId}; the continuation prompt is on the clipboard.\nIf the message box is empty, press Ctrl+V. Review it, then press Send.`);
}
