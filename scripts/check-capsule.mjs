// Session Capsule integration check on SYNTHETIC hook payloads (no AI tool, no app launched).
// Simulates two computers in one throwaway folder: a "source" with its own Blocker
// store, Codex home and project, and a "destination" with separate stores. The source
// store, project and transcripts are DELETED before anything is imported, so every
// destination step runs with the source unavailable. Both computers are this machine,
// so this is not a live MacBook <-> PC demonstration.
// Needs a Session Capsule checkout: SESSION_CAPSULE_DIR, or ../session-capsule next to this repo.
// usage: node scripts/check-capsule.mjs
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, "..");
const capsuleDir = path.resolve(process.env.SESSION_CAPSULE_DIR ?? path.join(repo, "..", "session-capsule"));
const capsuleCli = path.join(capsuleDir, "app", "cli", "main.ts");
if (!existsSync(capsuleCli)) {
  console.error(`SKIP: no Session Capsule checkout at ${capsuleDir} (set SESSION_CAPSULE_DIR).`);
  process.exit(1);
}

const tmp = mkdtempSync(path.join(os.tmpdir(), "dc-capsule-"));
const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const run = (cmd, args, env, input) => {
  const r = spawnSync(cmd, args, { env: { ...process.env, ...env }, encoding: "utf8", input });
  return { ...r, all: `${r.stdout}${r.stderr}` };
};
const ok = (r, what) => {
  assert.equal(r.status, 0, `${what} failed:\n${r.all}`);
  return r.stdout;
};
const git = (cwd, ...args) => ok(run("git", ["-C", cwd, "-c", "user.name=check", "-c", "user.email=check@example.com", ...args], {}), `git ${args[0]}`);

// ---------- Source computer ----------
const src = { store: path.join(tmp, "src-store"), codex: path.join(tmp, "src-codex"), capsuleHome: path.join(tmp, "src-capsule-home"), project: path.join(tmp, "src-project") };
mkdirSync(src.codex, { recursive: true });
mkdirSync(path.join(src.project, "lib"), { recursive: true });
writeFileSync(path.join(src.project, "README.md"), "# Demo\n");
writeFileSync(path.join(src.project, "lib", "a.js"), "export const a = 1;\n");
writeFileSync(path.join(src.project, "lib", "b.js"), "// TODO: implement b\n");
writeFileSync(path.join(src.project, "old.txt"), "to be removed\n");
git(src.project, "init", "-q");
git(src.project, "add", "-A");
git(src.project, "commit", "-qm", "base");
// The destination already has the repository at the base commit (as a PC with a clone would).
const dest = path.join(tmp, "pc-project");
git(tmp, "clone", "-q", src.project, dest);

// Work in progress on the source: an edit, a new binary file, a deletion, a credential.
writeFileSync(path.join(src.project, "lib", "a.js"), "export const a = 2; // finished\n");
writeFileSync(path.join(src.project, "logo.bin"), Buffer.from([0, 1, 2, 3, 255, 0, 10, 13]));
rmSync(path.join(src.project, "old.txt"));
writeFileSync(path.join(src.project, ".env"), "API_TOKEN=supersecretvalue123\n");
const past = new Date(Date.now() - 60_000);
for (const f of ["lib/a.js", "logo.bin", ".env"]) utimesSync(path.join(src.project, f), past, past);

const transcript = path.join(src.codex, "rollout-src.jsonl");
writeFileSync(transcript, `${JSON.stringify({ timestamp: new Date().toISOString(), type: "session_meta", payload: { id: "x" } })}\n`);
const srcEnv = { DESKTOP_CONTINUITY_HOME: src.store, CODEX_HOME: src.codex, DESKTOP_CONTINUITY_NO_AUTO_TAKEOVER: "1", SESSION_CAPSULE_HOME: src.capsuleHome };
const session = "01a17000-0000-7000-8000-00000000c0de";
const hook = (env, payload) => ok(run(process.execPath, [path.join(repo, "src", "hook.mjs")], env, JSON.stringify({ session_id: session, transcript_path: transcript, cwd: src.project, model: "gpt-test", turn_id: "t1", ...payload })), "hook");
hook(srcEnv, { hook_event_name: "UserPromptSubmit", prompt: "Finish lib/a.js and lib/b.js. My key is sk-proj-abcdefghijklmnopqrstuvwxyz0123456789" });
hook(srcEnv, { hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_use_id: "p1", tool_input: { command: "*** Begin Patch\n*** Update File: lib/a.js\n+export const a = 2;\n*** End Patch" } });
hook(srcEnv, { hook_event_name: "PostToolUse", tool_name: "apply_patch", tool_use_id: "p1", tool_input: { command: "…" }, tool_response: "Success" });
hook(srcEnv, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "c2", tool_input: { command: "npm run migrate" } });
hook(srcEnv, { hook_event_name: "Interrupt" });

// Export gate: refused while the source may still be working (only testable when the
// live check says so on this machine; it depends on the ChatGPT process being present).
const { sourceStatus } = await (async () => {
  process.env.DESKTOP_CONTINUITY_HOME = src.store;
  process.env.CODEX_HOME = src.codex;
  return import("../src/checkpoint.mjs");
})();
const { readEvents } = await import("../src/store.mjs");
const live = sourceStatus(readEvents(session));
assert.equal(live.mayStillBeWorking, false, "fixture should look stopped");
// A second project that changed just now: still working, if the live check can say so here.
const { exportHandoff } = await import("../src/capsule/export.mjs");
const busy = "01a17000-0000-7000-8000-00000000b057";
const busyProject = path.join(tmp, "busy-project");
mkdirSync(busyProject);
ok(run(process.execPath, [path.join(repo, "src", "hook.mjs")], srcEnv, JSON.stringify({ session_id: busy, cwd: busyProject, transcript_path: transcript, hook_event_name: "UserPromptSubmit", prompt: "busy" })), "hook");
writeFileSync(path.join(busyProject, "draft.md"), "being written\n");
const soon = new Date(Date.now() + 5000);
utimesSync(path.join(busyProject, "draft.md"), soon, soon);
let gate = "not exercised: the ChatGPT process check reports it is not running here, so the source cannot look busy";
if (sourceStatus(readEvents(busy)).mayStillBeWorking) {
  assert.throws(() => exportHandoff(busy), /may still be working/, "export must be refused while the source may still be working");
  assert.equal(exportHandoff(busy, { force: true }).sourceStatusAtCapture.exportForced, true, "a forced export is recorded as forced");
  gate = "refused while busy; --force recorded";
}

const handoffFile = path.join(tmp, "task.handoff.json");
ok(run(process.execPath, [path.join(repo, "src", "capsule", "export.mjs"), session, "--out", handoffFile], srcEnv), "export");
const handoff = JSON.parse(readFileSync(handoffFile, "utf8"));
assert.equal(handoff.kind, "session-capsule.handoff");
assert.ok(!readFileSync(handoffFile, "utf8").includes("abcdefghijklmnopqrstuvwxyz0123456789"), "secret leaked into the export");
assert.equal(handoff.sourceStatusAtCapture.historical, true);
assert.equal(handoff.events.lastIncludedSeq, 5);
assert.match(handoff.checkpoint.observed.recentActions.find((a) => a.input?.includes("npm run migrate")).outcome, /^UNKNOWN/);
// The same document validates under Session Capsule's JSON Schema (shared contract).
const schemaCheck = run(process.execPath, ["--input-type=module", "-e", `
  import { validateNamed } from ${JSON.stringify(path.join(capsuleDir, "core", "common", "schema.ts"))};
  import fs from "node:fs";
  const errors = validateNamed("handoff", JSON.parse(fs.readFileSync(process.argv[1], "utf8")));
  if (errors.length) { console.error(errors.join("\\n")); process.exit(1); }`, handoffFile], {});
ok(schemaCheck, "Session Capsule schema validation of Blocker's export");

const capsuleFile = path.join(tmp, "task.capsule");
const packed = ok(run(process.execPath, [capsuleCli, "pack", "--project", src.project, "--handoff", handoffFile, "--out", capsuleFile, "--yes"], srcEnv), "capsule pack");
assert.match(packed, /NOT encrypted/, "an unencrypted capsule is identified as such");
const ctxCapsule = path.join(tmp, "task-context.capsule");
ok(run(process.execPath, [capsuleCli, "pack", "--project", src.project, "--handoff", handoffFile, "--mode", "context", "--out", ctxCapsule, "--yes"], srcEnv), "capsule pack (context only)");
const recorded = Object.fromEntries(["README.md", "lib/a.js", "lib/b.js", "logo.bin"].map((f) => [f, sha(path.join(src.project, f))]));

// ---------- Source switched off ----------
for (const p of [src.store, src.codex, src.project, src.capsuleHome, handoffFile]) rmSync(p, { recursive: true, force: true });

// ---------- Destination computer ----------
const pc = { store: path.join(tmp, "pc-store"), capsuleHome: path.join(tmp, "pc-capsule-home"), codex: path.join(tmp, "pc-codex") };
mkdirSync(pc.codex, { recursive: true });
const pcEnv = { DESKTOP_CONTINUITY_HOME: pc.store, CODEX_HOME: pc.codex, DESKTOP_CONTINUITY_NO_AUTO_TAKEOVER: "1", DESKTOP_CONTINUITY_TAKEOVER_DRYRUN: "1", SESSION_CAPSULE_HOME: pc.capsuleHome };
// A local recording that must stay untouched by imports.
const localSession = "01a17000-0000-7000-8000-0000000010ca";
const localFile = path.join(pc.store, "sessions", `${localSession}.jsonl`);
ok(run(process.execPath, [path.join(repo, "src", "hook.mjs")], pcEnv, JSON.stringify({ session_id: localSession, cwd: dest, transcript_path: null, hook_event_name: "UserPromptSubmit", prompt: "local task" })), "local hook");
const localBefore = sha(localFile);

// A tampered capsule fails before any project write.
const tampered = path.join(tmp, "tampered.capsule");
const bytes = readFileSync(capsuleFile);
bytes[200] ^= 0xff;
writeFileSync(tampered, bytes);
const before = readdirSync(dest).sort().join(",");
const bad = run(process.execPath, [capsuleCli, "import", tampered, "--dest", dest, "--apply", "--deletions", "apply", "--yes"], pcEnv);
assert.notEqual(bad.status, 0, "a damaged capsule must be rejected");
assert.equal(readdirSync(dest).sort().join(","), before, "a rejected capsule must not write anything");

const preview = ok(run(process.execPath, [capsuleCli, "import", capsuleFile, "--dest", dest], pcEnv), "import preview");
assert.match(preview, /delete +old\.txt/);
assert.match(preview, /Preview only: nothing was written/);
const applied = ok(run(process.execPath, [capsuleCli, "import", capsuleFile, "--dest", dest, "--apply", "--deletions", "apply", "--yes"], pcEnv), "import apply");
for (const [f, h] of Object.entries(recorded)) assert.equal(sha(path.join(dest, f)), h, `${f} must be byte-identical after import`);
assert.ok(!existsSync(path.join(dest, "old.txt")), "recorded deletion applied");
assert.ok(!existsSync(path.join(dest, ".env")), "credential files are not transferred");
const reimport = ok(run(process.execPath, [capsuleCli, "import", capsuleFile, "--dest", dest], pcEnv), "re-import preview");
assert.match(reimport, /New 0, update 0, unchanged 4, conflicts 0, delete 0/, "importing twice changes nothing");

const capsuleId = applied.match(/\.session-capsule[\\/]([0-9a-f-]{36})/)[1];
const handoffFolder = path.join(dest, ".session-capsule", capsuleId);
const reg = (folder, extra = []) => ok(run(process.execPath, [path.join(repo, "src", "capsule", "imported-store.mjs"), "register", folder, ...extra], pcEnv), "register");
assert.match(reg(handoffFolder), /^registered: imp_/);
assert.match(reg(handoffFolder), /^already registered/, "registering twice is a no-op");
assert.equal(sha(localFile), localBefore, "local recordings are untouched by imports");

// ---------- Retrieval over MCP on the destination, source unavailable ----------
const client = new Client({ name: "check-capsule", version: "0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(repo, "src", "mcp-server.mjs")], env: { ...process.env, ...pcEnv } }));
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  assert.ok(!r.isError, `${name}: ${r.content[0].text}`);
  return r.content[0].text;
};
const imports = JSON.parse(await call("list_imports", {}));
assert.equal(imports.length, 1, "one import after registering twice");
const ref = imports[0].import_ref;
const cp = JSON.parse(await call("get_imported_checkpoint", { import_ref: ref }));
assert.equal(cp.sourceStatus.historical, true, "imported source status is labelled historical");
assert.equal(cp.liveSourceStatus.status, "unknown", "live source status is never inferred on the destination");
assert.match(cp.observed.recentActions.find((a) => a.input?.includes("npm run migrate")).outcome, /^UNKNOWN/, "unknown outcomes stay unknown");
assert.equal(cp.observed.recentActions.find((a) => a.tool === "apply_patch").outcome, "result recorded", "recorded results are not upgraded to success");
assert.equal(cp.destination.projectRoot, realpathSync(dest), "file access is mapped to the folder chosen on the destination");
assert.equal(cp.destinationFiles.find((f) => f.destinationPath === "lib/a.js")?.state, "matches the capsule", "recorded files resolve through the destination mapping");
assert.ok(!JSON.stringify(cp).includes("abcdefghijklmnopqrstuvwxyz0123456789"), "secret leaked into the imported checkpoint");
const page = JSON.parse(await call("get_imported_events", { import_ref: ref }));
assert.deepEqual(page.rows.map((r) => r.seq), [1, 2, 3, 4, 5], "event order and seq are preserved");
assert.match(await call("read_imported_project_file", { import_ref: ref, path: "lib/a.js" }), /finished/);
const escape = await client.callTool({ name: "read_imported_project_file", arguments: { import_ref: ref, path: "../" } });
assert.ok(escape.isError, "reads outside the mapped folder are refused");
const sessions = JSON.parse(await call("list_sessions", {}));
assert.deepEqual(sessions.map((s) => s.session_id), [localSession], "imports never appear as local sessions");
const local = await client.callTool({ name: "get_checkpoint", arguments: { session_id: localSession } });
assert.ok(!local.isError, "local checkpoints still work");
const prompt = await client.getPrompt({ name: "continue_import", arguments: { import_id: imports[0].imported_id } });
assert.match(prompt.messages[0].content.text, /get_imported_checkpoint/);
assert.match(prompt.messages[0].content.text, /Do not call get_source_status/);
assert.ok((await client.listTools()).tools.every((t) => t.annotations?.readOnlyHint === true), "MCP stays read-only");
await client.close();

// ---------- Destination routes (dry run: nothing opened) ----------
const viaCodex = ok(run(process.execPath, [path.join(repo, "src", "capsule", "continue.mjs"), String(ref), "--to", "codex"], pcEnv), "continue codex");
assert.match(viaCodex, /new session receiving handed-off context/, "manual routes use the Session Capsule message");
ok(run(process.execPath, [path.join(repo, "src", "capsule", "continue.mjs"), String(ref), "--to", "cowork"], pcEnv), "continue cowork");
assert.match(readFileSync(path.join(pc.store, "takeover-launches.log"), "utf8"), /dry-run import imp_[0-9a-f]+ via cowork/);

// ---------- Context-only capsule against a mismatched folder ----------
const ctxDest = path.join(tmp, "pc-context");
git(tmp, "clone", "-q", dest, ctxDest);
for (const f of Object.keys(recorded)) {
  mkdirSync(path.dirname(path.join(ctxDest, f)), { recursive: true });
  writeFileSync(path.join(ctxDest, f), readFileSync(path.join(dest, f)));
}
writeFileSync(path.join(ctxDest, "lib", "b.js"), "// a different local version\n");
const ctx = ok(run(process.execPath, [capsuleCli, "import", ctxCapsule, "--dest", ctxDest, "--apply"], pcEnv), "context-only import");
assert.match(ctx, /3 of 4 recorded files match; 0 are missing and 1 differ/);
assert.equal(readFileSync(path.join(ctxDest, "lib", "b.js"), "utf8"), "// a different local version\n", "context-only never writes project files");
const ctxId = ctx.match(/\.session-capsule[\\/]([0-9a-f-]{36})/)[1];
reg(path.join(ctxDest, ".session-capsule", ctxId));
const client2 = new Client({ name: "check-capsule-2", version: "0" });
await client2.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(repo, "src", "mcp-server.mjs")], env: { ...process.env, ...pcEnv } }));
const ctxImport = JSON.parse((await client2.callTool({ name: "list_imports", arguments: {} })).content[0].text).find((i) => i.mode === "context-only");
const ctxCp = JSON.parse((await client2.callTool({ name: "get_imported_checkpoint", arguments: { import_ref: ctxImport.import_ref } })).content[0].text);
assert.deepEqual(ctxCp.destination.contextCheck.different, ["lib/b.js"], "context-only mismatch is reported to the destination agent");
await client2.close();

// ---------- Reverse direction (destination becomes the source) ----------
writeFileSync(path.join(dest, "lib", "b.js"), "export const b = 2;\n");
const back = path.join(tmp, "back.capsule");
ok(run(process.execPath, [capsuleCli, "pack", "--project", dest, "--tool", "manual", "--out", back, "--yes"], pcEnv), "reverse pack");
const home = path.join(tmp, "home-again");
git(tmp, "clone", "-q", dest, home);
ok(run(process.execPath, [capsuleCli, "import", back, "--dest", home, "--apply", "--deletions", "apply", "--yes"], { ...pcEnv, SESSION_CAPSULE_HOME: path.join(tmp, "home-capsule") }), "reverse import");
assert.equal(readFileSync(path.join(home, "lib", "b.js"), "utf8"), "export const b = 2;\n");

rmSync(tmp, { recursive: true, force: true });
console.log(`Export gate: ${gate}.`);
console.log("PASS capsule: export redaction, shared schema, pack (full + context), source deleted, tampered capsule rejected with no writes, byte-identical apply + deletion, idempotent re-import, isolated dedup registration, MCP retrieval offline (historical status, unknown outcomes, mapped files, order), routes, context-only mismatch, reverse direction");
