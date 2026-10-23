// SIMULATED limit trigger for a live takeover test, without spending any quota.
// Feeds the real hook (src/hook.mjs) a small session marked `simulated: true`
// whose transcript is a sanitized fixture at the real 100%-window shape, then
// sends the same Stop again to show the second one does not open another chat.
// usage: node scripts/simulate-limit.mjs [run-number] [--dry-run]
// Each run number is its own simulated session (a repeated run of the same number launches nothing).
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { storeRoot } from "../src/store.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const run = Number.parseInt(process.argv.slice(2).find((a) => /^\d+$/.test(a)) ?? "1", 10);
const session = `01a167a0-0000-7000-8000-5151a7ed${String(run).padStart(4, "0")}`;
const project = "D:\\desktop-continuity-demo";
// Transcripts are only read from inside the Codex home, so the fixture is copied there.
const dir = path.join(storeRoot(), "simulated-transcripts");
mkdirSync(dir, { recursive: true });
const transcript = path.join(dir, `${session}.jsonl`);
copyFileSync(path.join(here, "fixtures", "limits", "window-full.jsonl"), transcript);

const env = { ...process.env, DESKTOP_CONTINUITY_SIMULATED: "1", ...(process.argv.includes("--dry-run") ? { DESKTOP_CONTINUITY_TAKEOVER_DRYRUN: "1" } : {}) };
const hook = (payload) => {
  const r = spawnSync(process.execPath, [path.join(here, "..", "src", "hook.mjs")], {
    input: JSON.stringify({ session_id: session, cwd: project, transcript_path: transcript, model: "simulated", ...payload }),
    env,
    encoding: "utf8"
  });
  if (r.status !== 0) throw new Error(r.stderr);
};
const launches = () => {
  const file = path.join(storeRoot(), "takeover-launches.log");
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter((l) => l.includes(session)) : [];
};

hook({ hook_event_name: "SessionStart", source: "startup" });
hook({ hook_event_name: "UserPromptSubmit", turn_id: "sim-1", prompt: "SIMULATED limit-trigger test. No real work was requested; do not edit any file." });
hook({ hook_event_name: "Stop", turn_id: "sim-1", last_assistant_message: "(simulated turn end)" });
const afterFirst = launches().length;
hook({ hook_event_name: "Stop", turn_id: "sim-1", last_assistant_message: "(simulated turn end, repeated)" });
console.log(`session ${session}: launches after first Stop=${afterFirst}, after repeated Stop=${launches().length}`);
console.log(launches().join("\n"));
