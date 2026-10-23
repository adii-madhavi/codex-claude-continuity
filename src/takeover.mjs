import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { listSessionIds } from "./store.mjs";

// Desktop takeover. Claude Desktop's documented `claude://claude.ai/new?q=`
// link opens a new chat with the prompt prefilled; it never sends it
// (https://support.claude.com/en/articles/14729294). So takeover is one click
// on Send, and nothing here drives the Claude or ChatGPT UI.

export const takeoverPrompt = (sessionId, why) => [
  `Continue my interrupted Codex desktop task (recorded session ${sessionId}${why ? `; trigger: ${why}` : ""}).`,
  `1. Call the desktop-continuity tool get_checkpoint with session_id "${sessionId}" and read it fully.`,
  "2. Call get_source_status. If the source app may still be working on this task, stop and tell me instead of acting.",
  "3. Treat every action marked outcome unknown as not confirmed: inspect the files before repeating it.",
  "4. Fetch only the extra events or files you need, then tell me your plan before changing any shared file."
].join("\n");

export const takeoverUrl = (sessionId, why) => `claude://claude.ai/new?q=${encodeURIComponent(takeoverPrompt(sessionId, why))}`;

export const openTakeover = (sessionId, why) => {
  // explorer.exe hands a URL to its registered protocol handler without a shell parsing it.
  const child = spawn(process.platform === "win32" ? "explorer.exe" : "xdg-open", [takeoverUrl(sessionId, why)], {
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.on("error", () => {});
  child.unref();
};

// `node src/takeover.mjs [session_id]`: the explicit takeover action (defaults to the most recent session).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const sessionId = process.argv[2] ?? listSessionIds()[0]?.id;
  if (!sessionId) {
    console.error("No recorded Codex session yet.");
    process.exit(1);
  }
  openTakeover(sessionId, "manual takeover");
  console.log(`Opened Claude Desktop with a continuation prompt for session ${sessionId}. Review it, then press Send.`);
}
