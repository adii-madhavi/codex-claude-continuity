// Takeover-reliability checks on SYNTHETIC hook payloads in a throwaway store (no AI tool, no app launched).
// Covers latest-session selection, background/simulated exclusion, a moved project folder,
// the still-working edit gate, and SessionEnd after Stop.
// usage: node scripts/check-takeover.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(path.join(os.tmpdir(), "dc-takeover-"));
const codexHome = path.join(tmp, "codex");
mkdirSync(codexHome);
Object.assign(process.env, { DESKTOP_CONTINUITY_HOME: path.join(tmp, "store"), CODEX_HOME: codexHome, DESKTOP_CONTINUITY_TAKEOVER_DRYRUN: "1" });
const { pickLatestEligible, sourceStatus, sessionSummary } = await import("../src/checkpoint.mjs");
const { takeoverPrompt, takeoverUrl } = await import("../src/takeover.mjs");
const { readEvents } = await import("../src/store.mjs");

const transcript = path.join(codexHome, "t.jsonl");
writeFileSync(transcript, `${JSON.stringify({ timestamp: new Date().toISOString(), type: "session_meta", payload: { id: "x" } })}\n`);
const project = (name) => {
  const dir = path.join(tmp, name);
  mkdirSync(dir, { recursive: true });
  return dir;
};
const hook = (session, cwd, payload, extraEnv = {}) => {
  const r = spawnSync(process.execPath, [path.join(here, "..", "src", "hook.mjs")], {
    input: JSON.stringify({ session_id: session, cwd, transcript_path: transcript, ...payload }),
    env: { ...process.env, ...extraEnv },
    encoding: "utf8"
  });
  assert.equal(r.status, 0, r.stderr);
};
const run = (session, cwd, endEvent, extra = {}) => {
  hook(session, cwd, { hook_event_name: "SessionStart" }, extra.env);
  hook(session, cwd, { hook_event_name: "UserPromptSubmit", prompt: extra.prompt ?? "task" }, extra.env);
  if (endEvent) hook(session, cwd, { hook_event_name: endEvent }, extra.env);
};

// 1. Completed task only: nothing eligible.
const done = project("done");
run("01a16900-0000-7000-8000-000000000001", done, "Stop");
hook("01a16900-0000-7000-8000-000000000001", done, { hook_event_name: "SessionEnd", reason: "other" });
assert.equal(sessionSummary("01a16900-0000-7000-8000-000000000001").turn, "turn ended", "SessionEnd after Stop keeps the turn's own end");
assert.equal(pickLatestEligible().status, "none", "a completed task is never picked");

// 2. A background thread with no transcript and a simulated session are never picked.
hook("01a16900-0000-7000-8000-000000000002", project("bg"), { hook_event_name: "UserPromptSubmit", prompt: "Generate 0 to 3 suggestions", transcript_path: null });
run("01a16900-0000-7000-8000-000000000003", project("sim"), "Interrupt", { env: { DESKTOP_CONTINUITY_SIMULATED: "1" } });
assert.equal(pickLatestEligible().status, "none", "background and simulated sessions are excluded");

// 3. One interrupted task: picked.
const alpha = project("alpha");
run("01a16900-0000-7000-8000-000000000004", alpha, "Interrupt", { prompt: "alpha task" });
const pick = pickLatestEligible();
assert.equal(pick.status, "picked");
assert.equal(pick.session.session_id, "01a16900-0000-7000-8000-000000000004");

// 4. A second unfinished task in another project, close in time: ambiguous, nothing picked.
const beta = project("beta");
run("01a16900-0000-7000-8000-000000000005", beta, null, { prompt: "beta task" });
const amb = pickLatestEligible();
assert.equal(amb.status, "ambiguous");
assert.deepEqual(amb.candidates.map((c) => c.session_id).sort(), ["01a16900-0000-7000-8000-000000000004", "01a16900-0000-7000-8000-000000000005"]);

// 5. Still working: a file changed just now after the last event blocks destination edits.
writeFileSync(path.join(beta, "draft.md"), "still being written\n");
const later = new Date(Date.now() + 5000);
(await import("node:fs")).utimesSync(path.join(beta, "draft.md"), later, later);
const working = sourceStatus(readEvents("01a16900-0000-7000-8000-000000000005"));
assert.equal(working.mayStillBeWorking, true);
assert.equal(working.destinationMayEdit, false, "a source that may still be working must block destination edits");
assert.equal(sourceStatus(readEvents("01a16900-0000-7000-8000-000000000004")).destinationMayEdit, true);

// 6. Moved folder: no folder attached, chat route, prompt says so.
assert.match(takeoverUrl("01a16900-0000-7000-8000-000000000004", "t"), /^claude:\/\/cowork\/new\?q=.*&folder=/);
renameSync(alpha, path.join(tmp, "alpha-moved"));
assert.match(takeoverUrl("01a16900-0000-7000-8000-000000000004", "t"), /^claude:\/\/claude\.ai\/new\?q=/, "a missing folder falls back to the chat route");
assert.match(takeoverPrompt("01a16900-0000-7000-8000-000000000004", "t"), /no longer exists at that path\. Ask me where it is now/);

console.log("PASS takeover: completed/background/simulated excluded, single pick, ambiguity refused, still-working gate, moved-folder fallback, SessionEnd after Stop");
