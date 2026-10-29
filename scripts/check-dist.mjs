// Checks that dist/ runs on its own: each bundle is copied to an empty folder (no node_modules),
// the MCP server lists its tools over stdio, and each CLI prints only its own usage (a bundled
// module must not start another module's CLI).
// usage: node scripts/check-dist.mjs   (run `npm run build` first)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = mkdtempSync(path.join(os.tmpdir(), "dc-dist-"));
cpSync(path.join(repo, "dist"), path.join(tmp, "dist"), { recursive: true });
const env = { ...process.env, DESKTOP_CONTINUITY_HOME: path.join(tmp, "store"), DESKTOP_CONTINUITY_TAKEOVER_DRYRUN: "1", DESKTOP_CONTINUITY_NO_AUTO_TAKEOVER: "1" };

for (const [name, usage] of [["continue", /continue\.mjs <imported_id/], ["export", /export\.mjs <session_id/], ["imported-store", /imported-store\.mjs register/]]) {
  const r = spawnSync(process.execPath, [path.join(tmp, "dist", `${name}.mjs`)], { env, encoding: "utf8", cwd: tmp });
  const output = r.stdout + r.stderr;
  assert.match(output, usage, `${name}: own usage`);
  assert.equal(output.trim().split("\n").filter((l) => /^usage:/.test(l)).length, 1, `${name}: only its own CLI runs\n${output}`);
}

const client = new Client({ name: "check-dist", version: "0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(tmp, "dist", "mcp-server.mjs")], env, cwd: tmp }));
const tools = (await client.listTools()).tools.map((t) => t.name);
await client.close();
for (const t of ["list_sessions", "get_checkpoint", "list_imports", "get_imported_checkpoint", "read_imported_project_file"]) assert.ok(tools.includes(t), `MCP tool ${t}`);

rmSync(tmp, { recursive: true, force: true });
console.log(`PASS dist: runs without node_modules; MCP server lists ${tools.length} tools; continue, export and imported-store each start only their own CLI`);
