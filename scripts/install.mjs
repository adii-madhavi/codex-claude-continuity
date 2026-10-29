// Installs the two integrations, backing up each file first and preserving every other setting:
//   1. A local Codex plugin whose lifecycle hooks capture activity in the ChatGPT desktop app.
//   2. MCP servers in Claude Desktop's claude_desktop_config.json (read-only retrieval, plus an
//      optional writable filesystem server scoped to folders you name).
// usage: node scripts/install.mjs [--claude-config <path>] [--writable-folder <dir>]... [--dry-run]
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MARKETPLACE } from "../src/store.mjs";

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

// macOS GUI apps start with a minimal PATH (no /opt/homebrew/bin), so outside Windows
// hooks and MCP servers name node by absolute path. Prefer the PATH entry (for example
// /opt/homebrew/bin/node) over process.execPath, which Homebrew resolves to a versioned
// Cellar folder that the next `brew upgrade node` removes.
const nodeBin = () => {
  if (process.platform === "win32") return process.execPath;
  for (const dir of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, "node");
    try {
      if (realpathSync(candidate) === realpathSync(process.execPath)) return candidate;
    } catch {}
  }
  return process.execPath;
};
const quoted = (p) => (/\s/.test(p) ? JSON.stringify(p) : p);

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

// 1. Codex capture, as a local plugin. Codex runs hooks inside its sandbox; a
//    standalone ~/.codex/hooks.json hook could not write anywhere (EPERM), while
//    plugin hooks get a writable PLUGIN_DATA folder. So remove any standalone
//    entries an earlier version added, then install the plugin into the documented
//    personal marketplace (https://developers.openai.com/plugins/build/plugins).
const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
const hooksFile = path.join(codexHome, "hooks.json");
if (existsSync(hooksFile)) {
  const hooks = readJson(hooksFile, {});
  const ours = (h) => typeof h.command === "string" && h.command.includes("desktop-continuity/src/hook.mjs");
  for (const [event, groups] of Object.entries(hooks.hooks ?? {})) {
    for (const group of groups) group.hooks = (group.hooks ?? []).filter((h) => !ours(h));
    hooks.hooks[event] = groups.filter((g) => g.hooks.length > 0);
    if (hooks.hooks[event].length === 0) delete hooks.hooks[event];
  }
  save(hooksFile, hooks);
}

const pluginDir = path.join(codexHome, "plugins", "desktop-continuity");
if (dryRun) console.log(`[dry-run] would copy ${path.join(root, "codex-plugin")} to ${pluginDir}`);
else {
  cpSync(path.join(root, "codex-plugin"), pluginDir, { recursive: true, force: true });
  // Point every hook at this clone's hook.mjs (the repo copy names the original D:\ checkout).
  // Forward slashes work for node in every shell Codex uses; quote only when needed.
  const hookScript = path.join(root, "src", "hook.mjs").replaceAll("\\", "/");
  const command = `${process.platform === "win32" ? "node" : quoted(nodeBin())} ${quoted(hookScript)}`;
  const hooksFile = path.join(pluginDir, "hooks", "hooks.json");
  const pluginHooks = readJson(hooksFile, { hooks: {} });
  for (const groups of Object.values(pluginHooks.hooks)) for (const g of groups) for (const h of g.hooks) h.command = command;
  writeFileSync(hooksFile, `${JSON.stringify(pluginHooks, null, 2)}\n`);
  console.log(`copied:  plugin to ${pluginDir} (hooks run: ${command})`);
}

// The marketplace root is the home folder; plugin paths are relative to it.
const marketplaceFile = path.join(os.homedir(), ".agents", "plugins", "marketplace.json");
const marketplace = readJson(marketplaceFile, { name: "personal", interface: { displayName: "Personal plugins" }, plugins: [] });
marketplace.plugins = (marketplace.plugins ?? []).filter((p) => p.name !== "desktop-continuity");
marketplace.plugins.push({
  name: "desktop-continuity",
  source: { source: "local", path: `./${path.relative(os.homedir(), pluginDir).replaceAll("\\", "/")}` },
  policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
  category: "Productivity"
});
save(marketplaceFile, marketplace);
if (marketplace.name !== MARKETPLACE) console.log(`note: marketplace is named "${marketplace.name}"; set DESKTOP_CONTINUITY_HOME for the MCP server.`);

// 2. Claude Desktop MCP servers.
const claudeConfig = claudeConfigCandidates().find(existsSync) ?? claudeConfigCandidates()[0];
const config = readJson(claudeConfig, {});
config.mcpServers ??= {};
config.mcpServers["desktop-continuity"] = { command: nodeBin(), args: [path.join(root, "src", "mcp-server.mjs")] };
const writable = flag("--writable-folder").map((dir) => path.resolve(dir));
if (writable.length > 0) {
  config.mcpServers["continuity-files"] = {
    command: nodeBin(),
    args: [path.join(root, "node_modules", "@modelcontextprotocol", "server-filesystem", "dist", "index.js"), ...writable]
  };
}
save(claudeConfig, config);
console.log(`\nNext: restart ChatGPT, install "Desktop continuity" from Personal plugins and trust its hooks;\nfully quit Claude Desktop (${process.platform === "darwin" ? "Cmd+Q" : "from the tray"}) and reopen it.`);
