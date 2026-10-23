// Deterministic limit-detector checks on sanitized fixtures (scripts/fixtures/limits).
// The fixtures are MODELED on the record shapes and message text shipped in
// codex.exe 0.163 (desktop 26.1016); no real limit was hit to capture them.
// Also runs the real hook (dry-run launches) to check one takeover per signal.
// usage: node scripts/check-limits.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyLimit } from "../src/source.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => path.join(here, "fixtures", "limits", `${name}.jsonl`);
const classify = (name) => classifyLimit(readFileSync(fixture(name), "utf8").split("\n"));
const results = {};
const expect = (name, status, extra = () => {}) => {
  const r = classify(name);
  results[name] = r.status;
  assert.equal(r.status, status, `${name}: ${JSON.stringify(r)}`);
  extra(r);
};

expect("limit-error", "limit_reached", (r) => assert.equal(r.signal.kind, "error event"));
expect("prose", "no_limit_signal"); // messages that talk about limits are not limits
expect("approaching", "approaching"); // 92% is a warning, not a limit
expect("unfamiliar", "unknown"); // limit-like text in an unknown shape is not guessed at
expect("truncated", "unknown", (r) => assert.equal(r.unparsedLines, 1)); // newest record torn
expect("repeated", "limit_reached", (r) => assert.equal(r.signalCount, 3));
expect("resumed", "no_limit_signal", (r) => assert.match(r.detail, /work started again/)); // still/again working
// Shape of the real limit recorded on this machine on 2026-10-20 (values sanitized):
// used_percent 100, rate_limit_reached_type null, no error record, then an empty snapshot.
expect("window-full", "limit_reached", (r) => assert.equal(r.signal.windows[0].usedPercent, 100));
expect("window-reset", "no_limit_signal"); // the window later shows 3%: it reset

// Hook path: a Stop whose transcript says limit_reached launches once per signal.
const tmp = mkdtempSync(path.join(os.tmpdir(), "dc-limits-"));
const codexHome = path.join(tmp, "codex");
mkdirSync(codexHome);
const env = { ...process.env, CODEX_HOME: codexHome, DESKTOP_CONTINUITY_HOME: path.join(tmp, "store"), DESKTOP_CONTINUITY_TAKEOVER_DRYRUN: "1" };
const hook = (session, name, event) => {
  const transcript = path.join(codexHome, `${name}.jsonl`);
  copyFileSync(fixture(name), transcript);
  const r = spawnSync(process.execPath, [path.join(here, "..", "src", "hook.mjs")], {
    input: JSON.stringify({ session_id: session, hook_event_name: event, cwd: tmp, transcript_path: transcript }),
    env,
    encoding: "utf8"
  });
  assert.equal(r.status, 0, r.stderr);
};
const launches = () => {
  const file = path.join(tmp, "store", "takeover-launches.log");
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean) : [];
};

hook("01a16801-0000-7000-8000-000000000001", "limit-error", "Stop");
hook("01a16801-0000-7000-8000-000000000001", "limit-error", "Stop"); // same signal again
assert.equal(launches().length, 1, "a repeated signal must not open a second chat");
hook("01a16801-0000-7000-8000-000000000002", "prose", "Stop");
hook("01a16801-0000-7000-8000-000000000003", "approaching", "Stop");
hook("01a16801-0000-7000-8000-000000000004", "unfamiliar", "Stop");
hook("01a16801-0000-7000-8000-000000000005", "truncated", "Stop");
hook("01a16801-0000-7000-8000-000000000006", "resumed", "Stop");
hook("01a16801-0000-7000-8000-000000000007", "limit-error", "UserPromptSubmit"); // not a turn end
assert.equal(launches().length, 1, "only a turn end with limit_reached may launch");
assert.match(launches()[0], /dry-run 01a16801-0000-7000-8000-000000000001 via cowork\+folder usage limit \(error event at /, "an existing project folder is attached through the Cowork link");

// Watcher path: a recorded session whose transcript reaches a limit, with NO Stop hook
// (as if Codex never fired one). The watcher opens takeover once; a later pass and a
// later Stop for the same signal open nothing more.
const watchSession = "01a16801-0000-7000-8000-000000000009";
hook(watchSession, "window-full", "UserPromptSubmit");
const forSession = (id) => launches().filter((l) => l.includes(id));
const once = () => spawnSync(process.execPath, [path.join(here, "..", "src", "watch.mjs"), "--once"], { env, encoding: "utf8" });
assert.equal(once().status, 0);
assert.equal(forSession(watchSession).length, 1, "the watcher opens takeover without a Stop hook");
assert.match(forSession(watchSession)[0], /usage limit seen by the watcher/);
// Session ...0007 only ever got UserPromptSubmit, so no hook claimed it: the watcher covers it too.
assert.equal(forSession("01a16801-0000-7000-8000-000000000007").length, 1);
assert.equal(forSession("01a16801-0000-7000-8000-000000000001").length, 1, "a signal the hook already claimed is not reopened");
for (const id of ["000000000002", "000000000003", "000000000004", "000000000005", "000000000006"]) {
  assert.equal(forSession(`01a16801-0000-7000-8000-${id}`).length, 0, "no launch without limit_reached");
}
once();
hook(watchSession, "window-full", "Stop");
assert.equal(forSession(watchSession).length, 1, "watcher and hook share one claim per signal");

console.log("PASS limit detector:", JSON.stringify(results));
console.log("PASS watcher: opens once without a Stop hook; a second pass and a later Stop add nothing");
console.log("PASS takeover launches: 1 for 2 identical Stop signals; 0 for prose, approaching, unknown, truncated, resumed, non-Stop");
