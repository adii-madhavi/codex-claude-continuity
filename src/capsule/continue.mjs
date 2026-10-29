// Continue an imported capsule on this computer through a chosen destination.
// Only the Claude Desktop routes open anything, through the same claude:// links
// as same-computer takeover. Claude Code and Codex have no verified launch route
// here, so they get the copy-ready message (manual fallback). Nothing is sent,
// no permission dialog is answered, and no command from the capsule is run.
//
// usage: node src/capsule/continue.mjs <imported_id | import_ref> --to cowork|chat|claude-code|codex|manual

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { storeRoot } from "../store.mjs";
import { copyToClipboard, importedTakeoverPrompt, openUrl } from "../takeover.mjs";
import { readImport, resolveImport } from "./imported-store.mjs";

// Evidence behind each route; keep in sync with README "Supported routes".
export const ROUTES = {
  cowork: { opens: true, evidence: "claude://cowork/new prefill + folder attach observed on Windows 11, Claude Desktop 3.6556 (same-computer takeover). Not yet observed on macOS." },
  chat: { opens: true, evidence: "claude://claude.ai/new opened an empty chat on Claude Desktop 3.6556 (Windows); the prompt is pasted from the clipboard." },
  "claude-code": { opens: false, evidence: "No verified way to open Claude Code with a prompt. Manual: open the project folder, start a new session, paste." },
  codex: { opens: false, evidence: "No verified way to open Codex with a prompt. Manual: open the project folder, start a new thread, paste." },
  manual: { opens: false, evidence: "Copy the message and paste it into any agent that can read the project folder." }
};

/** The message for a route. MCP-capable routes use the import tools; the others read the handoff files. */
export const continuationFor = (importedId, route) => {
  const { record } = readImport(importedId);
  if (route === "cowork" || route === "chat") return importedTakeoverPrompt(record, `route ${route}`);
  const saved = path.join(record.handoffFolder ?? "", "message.txt");
  if (record.handoffFolder && existsSync(saved)) return readFileSync(saved, "utf8").trim();
  return [
    `Continue my coding task that was handed over from another computer (capsule ${record.capsuleId}). This is a new session; the original was not restored.`,
    `Read .session-capsule/${record.capsuleId}/continuation.md in this project first, then conversation.md for detail.`,
    "The source computer's status is historical and its current state is unknown. Check the project before repeating any action, and wait for my OK before your first edit."
  ].join("\n");
};

export const continueImport = async (importedId, route) => {
  const spec = ROUTES[route];
  if (!spec) throw new Error(`Unknown route "${route}". Use one of: ${Object.keys(ROUTES).join(", ")}.`);
  const { record } = readImport(importedId);
  const message = continuationFor(importedId, route);
  const url = route === "cowork" ? `claude://cowork/new?q=${encodeURIComponent(message)}&folder=${encodeURIComponent(record.projectRoot)}`
    : route === "chat" ? `claude://claude.ai/new?q=${encodeURIComponent(message)}` : null;
  const dryRun = Boolean(process.env.DESKTOP_CONTINUITY_TAKEOVER_DRYRUN);
  try {
    mkdirSync(storeRoot(), { recursive: true });
    appendFileSync(path.join(storeRoot(), "takeover-launches.log"), `${new Date().toISOString()} ${dryRun ? "dry-run" : "launch"} import ${importedId} via ${route}\n`);
  } catch {}
  if (!dryRun) {
    await copyToClipboard(message);
    if (url) await openUrl(url);
  }
  return { route, url, message, opened: Boolean(url) && !dryRun, evidence: spec.evidence, projectRoot: record.projectRoot };
};

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const route = args.find((a) => a.startsWith("--to="))?.slice(5) ?? (args.includes("--to") ? args[args.indexOf("--to") + 1] : "manual");
  const target = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--to");
  try {
    if (!target) throw new Error("usage: node src/capsule/continue.mjs <imported_id | import_ref> --to cowork|chat|claude-code|codex|manual");
    const id = /^\d+$/.test(target) ? resolveImport({ import_ref: Number(target) }) : resolveImport({ import_id: target });
    const r = await continueImport(id, route);
    if (r.opened) console.log(`Opened Claude Desktop (${route}) with the continuation prompt${route === "cowork" ? ` and folder ${r.projectRoot}` : ""}. Review it, then press Send. It is also on the clipboard.`);
    else {
      console.log(`Open ${r.projectRoot} in ${route === "claude-code" ? "Claude Code" : route === "codex" ? "Codex" : "your coding tool"}, start a new session, and paste this message${process.platform === "win32" || process.platform === "darwin" ? " (it is on the clipboard)" : ""}:\n`);
      console.log(r.message);
    }
    console.log(`\nRoute evidence: ${r.evidence}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
