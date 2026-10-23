// Installs the two integrations, backing up each file first and preserving every other setting:
//   1. Codex command hooks in ~/.codex/hooks.json (capture from the ChatGPT desktop app).
//   2. MCP servers in Claude Desktop's claude_desktop_config.json (read-only retrieval, plus an
//      optional writable filesystem server scoped to folders you name).
// usage: node scripts/install.mjs [--claude-config <path>] [--writable-folder <dir>]... [--dry-run]
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name) => args.flatMap((a, i) => (a === name ? [args[i + 1]] : [])).filter(Boolean);
const dryRun = args.includes("--dry-run");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");

// Claude Desktop on Windows (MSIX) keeps its config in its data folder; %APPDATA%\Claude is the documented default.
const claudeConfigCandidates = () => [
  ...flag("--claude-config"),
  ...(process.env.LOCALAPPDATA ? [path.join(process.env.LOCALAPPDATA, "Claude-Data", "claude_pzs8sxrjxfjjc", "claude_desktop_config.json")] : []),
  ...(process.env.APPDATA ? [path.join(process.env.APPDATA, "Claude", "claude_desktop_config.json")] : []),
  path.join(os.homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json")
];

const readJson = (file, fallback) => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : fallback);

const save = (file, value) => {
  const next = `${JSON.stringify(value, null, 2)}\n`;
  if (existsSync(file) && readFileSync(file, "utf8") === next) return console.log(`unchanged: ${file}`);
  // Never print the whole file: other servers' arguments can hold credentials.
  if (dryRun) return console.log(`[dry-run] would update ${file} (top-level keys: ${Object.keys(value).join(", ")})`);
  if (existsSync(file)) {
    copyFileSync(file, `${file}.bak-${stamp}`);
    console.log(`backup:  ${file}.bak-${stamp}`);
  }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, next);
  console.log(`wrote:   ${file}`);
};

// 1. Codex hooks. Forward slashes work for node in every shell Codex might use.
const hookScript = path.join(root, "src", "hook.mjs").replaceAll("\\", "/");
const command = `node ${hookScript.includes(" ") ? JSON.stringify(hookScript) : hookScript}`;
const EVENTS = { SessionStart: 10, UserPromptSubmit: 10, PreToolUse: 10, PostToolUse: 10, PreCompact: 10, Stop: 10, Interrupt: 3, SessionEnd: 3 };
const hooksFile = path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"), "hooks.json");
const hooks = readJson(hooksFile, {});
hooks.hooks ??= {};
for (const [event, timeout] of Object.entries(EVENTS)) {
  const groups = (hooks.hooks[event] ??= []);
  const ours = (h) => typeof h.command === "string" && h.command.includes("desktop-continuity/src/hook.mjs");
  for (const group of groups) group.hooks = (group.hooks ?? []).filter((h) => !ours(h));
  hooks.hooks[event] = groups.filter((g) => g.hooks.length > 0);
  hooks.hooks[event].push({ hooks: [{ type: "command", command, timeout, statusMessage: "Recording for desktop-continuity" }] });
}
save(hooksFile, hooks);

// 2. Claude Desktop MCP servers.
const claudeConfig = claudeConfigCandidates().find(existsSync) ?? claudeConfigCandidates()[0];
const config = readJson(claudeConfig, {});
config.mcpServers ??= {};
config.mcpServers["desktop-continuity"] = { command: process.execPath, args: [path.join(root, "src", "mcp-server.mjs")] };
const writable = flag("--writable-folder").map((dir) => path.resolve(dir));
if (writable.length > 0) {
  config.mcpServers["continuity-files"] = {
    command: process.execPath,
    args: [path.join(root, "node_modules", "@modelcontextprotocol", "server-filesystem", "dist", "index.js"), ...writable]
  };
}
save(claudeConfig, config);
console.log("\nNext: in ChatGPT, review and trust the new hooks; fully quit Claude Desktop from the tray and reopen it.");
