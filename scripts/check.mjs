// Self-check with SYNTHETIC hook payloads in a throwaway store (no AI tool is used).
// Pipes payloads through the real hook entry, then talks to the real MCP server over stdio.
// usage: node scripts/check.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(path.join(os.tmpdir(), "dc-check-"));
const project = path.join(tmp, "project");
mkdirSync(project);
writeFileSync(path.join(project, "notes.md"), "# Notes\n\n## Part 1\nhello\nAPI_KEY=abcdef1234567890\n\n## Part 2\nTODO: write part 2\n");
writeFileSync(path.join(project, ".env"), "SECRET=1");
const codexHome = path.join(tmp, "codex");
mkdirSync(codexHome);
const transcript = path.join(codexHome, "rollout-test.jsonl");
writeFileSync(transcript, `${JSON.stringify({ timestamp: new Date().toISOString(), type: "event_msg", payload: { type: "token_count", rate_limits: { primary: { used_percent: 100, window_minutes: 300, resets_at: 1893456000 } } } })}\n`);
const env = { ...process.env, DESKTOP_CONTINUITY_HOME: path.join(tmp, "store"), CODEX_HOME: codexHome, DESKTOP_CONTINUITY_NO_AUTO_TAKEOVER: "1" };
const session = "01a16700-0000-7000-8000-000000000001";
const base = { session_id: session, transcript_path: transcript, cwd: project, model: "gpt-test", turn_id: "t1" };

const hook = (payload) => {
  const r = spawnSync(process.execPath, [path.join(here, "..", "src", "hook.mjs")], { input: JSON.stringify({ ...base, ...payload }), env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "", "hook must print nothing");
};

hook({ hook_event_name: "SessionStart", source: "startup" });
hook({ hook_event_name: "UserPromptSubmit", prompt: "Add a greeting to notes.md. token sk-proj-abcdefghijklmnopqrstuvwxyz123456" });
hook({ hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_use_id: "c1", tool_input: { command: "*** Begin Patch\n*** Update File: notes.md\n+hi\n*** End Patch" } });
hook({ hook_event_name: "PostToolUse", tool_name: "apply_patch", tool_use_id: "c1", tool_input: { command: "…" }, tool_response: "Success" });
// A file written by a shell command names no file in any structured field (as Codex desktop does with PowerShell).
writeFileSync(path.join(project, "shell-made.md"), "## Draft\nTODO: finish\n");
hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "c2", tool_input: { command: "npm test" } });
// SIMULATED interruption: no PostToolUse and no Stop for c2.

const client = new Client({ name: "check", version: "0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(here, "..", "src", "mcp-server.mjs")], env }));
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  assert.ok(!r.isError, `${name}: ${r.content[0].text}`);
  return r.content[0].text;
};

const tools = (await client.listTools()).tools.map((t) => t.name).sort();
assert.deepEqual(tools, ["get_checkpoint", "get_event", "get_events", "get_source_status", "list_project_files", "list_sessions", "read_project_file"]);
assert.ok((await client.listTools()).tools.every((t) => t.annotations?.readOnlyHint === true));

const sessions = JSON.parse(await call("list_sessions", {}));
assert.equal(sessions[0].session_id, session);
assert.equal(JSON.parse(await call("list_sessions", { project: "elsewhere" })).length, 0, "project filter keeps projects apart");

const cp = JSON.parse(await call("get_checkpoint", { session_id: session }));
assert.match(cp.observed.userMessages[0].text, /REDACTED:openai-key/);
assert.ok(!JSON.stringify(cp).includes("abcdefghijklmnopqrstuvwxyz123456"), "secret leaked into checkpoint");
assert.ok(!JSON.stringify(cp).includes("abcdef1234567890"), "secret from a touched file leaked into checkpoint");
assert.equal(cp.observed.recentActions.find((a) => a.tool === "apply_patch").outcome, "result recorded");
assert.match(cp.observed.recentActions.find((a) => a.tool === "Bash").outcome, /^UNKNOWN/, "missing result must not read as success");
assert.deepEqual(cp.observed.artifacts.map((f) => f.path).sort(), [".env", "notes.md", "shell-made.md"], "files written by shell commands are found on disk");
assert.equal(cp.observed.artifacts.find((f) => f.path === ".env").now.contents, "credential file; not inspected");
assert.equal(cp.observed.artifacts.find((f) => f.path === "shell-made.md").outcome, "observed on disk");
assert.equal(cp.observed.artifacts[0].now.exists, true);
assert.deepEqual(cp.inferred.remainingWork.map((r) => [r.file, r.under]).sort(), [["notes.md", "## Part 2"], ["shell-made.md", "## Draft"]], "unfinished marker found under its heading");
assert.match(cp.inferred.nextStep, /notes\.md.*Part 2/);
assert.equal(cp.agentNotes.finalMessages.length, 0);
assert.ok(cp.missing.some((m) => /No final assistant message/.test(m)), "missing context is marked");
assert.equal(cp.sourceStatus.turn.state, "no end of turn recorded");
assert.equal(cp.sourceStatus.usage.status, "limit_reached");
assert.deepEqual(cp.sourceStatus.projectChangedAfterLastEvent, []);

assert.equal(JSON.parse(await call("get_checkpoint", { sessionId: session })).session_id, session, "sessionId alias");
assert.match(readFileSync(path.join(tmp, "store", "mcp-calls.log"), "utf8"), /get_checkpoint args=\{"sessionId"/);
// Claude Desktop's chat bridge dropped the string session_id but kept integers.
const ref = sessions[0].session_ref;
assert.ok(Number.isSafeInteger(ref));
assert.equal(JSON.parse(await call("get_checkpoint", { session_ref: ref })).session_id, session, "session_ref");
assert.match(await call("get_events", { session_ref: ref, after_seq: 0, limit: 2 }), /"rows"/);
const missing = await client.callTool({ name: "get_checkpoint", arguments: {} });
assert.ok(missing.isError && /session_ref/.test(missing.content[0].text), "no session given must be refused, never guessed");

const page = JSON.parse(await call("get_events", { session_id: session, event: "PreToolUse" }));
assert.equal(page.rows.length, 2);
assert.equal(JSON.parse(await call("get_event", { session_id: session, seq: 4 })).response, "Success");

assert.match(await call("read_project_file", { session_id: session, path: "notes.md" }), /API_KEY=\[REDACTED:secret-assignment\]/);
const refused = await client.callTool({ name: "read_project_file", arguments: { session_id: session, path: ".env" } });
assert.ok(refused.isError);
const escape = await client.callTool({ name: "read_project_file", arguments: { session_id: session, path: "..\\codex\\rollout-test.jsonl" } });
assert.ok(escape.isError, "path escape must be refused");
const badId = await client.callTool({ name: "get_checkpoint", arguments: { session_id: "..\\..\\x" } });
assert.ok(badId.isError, "session id must not become a path");

hook({ hook_event_name: "Stop", last_assistant_message: "Added the greeting.", stop_hook_active: false });
assert.equal(JSON.parse(await call("get_source_status", { session_id: session })).turn.state, "turn ended");
assert.equal(JSON.parse(await call("get_checkpoint", { session_ref: ref })).agentNotes.finalMessages[0].text, "Added the greeting.");
// A file changed after the last recorded event: stale checkpoint, and the source may still be working.
const later = new Date(Date.now() + 10_000);
utimesSync(path.join(project, "notes.md"), later, later);
const stale = JSON.parse(await call("get_source_status", { session_ref: ref }));
assert.deepEqual(stale.projectChangedAfterLastEvent.map((c) => c.path), ["notes.md"]);
assert.equal(stale.mayStillBeWorking, true, "recent changes after the last event mean the source may still be working");
assert.ok(JSON.parse(await call("get_checkpoint", { session_ref: ref })).missing.some((m) => /^STALE/.test(m)));

const prompt = await client.getPrompt({ name: "continue_task", arguments: { session_id: session } });
assert.match(prompt.messages[0].content.text, /get_checkpoint/);
const latest = await client.getPrompt({ name: "continue_latest", arguments: {} });
assert.match(latest.messages[0].content.text, new RegExp(`session_ref ${ref}`), "continue_latest names the session it picked");

await client.close();
console.log("PASS: capture, redaction, unknown outcomes, project scoping, paging, file reads, artifacts and remaining work, stale detection, source status, prompts");
