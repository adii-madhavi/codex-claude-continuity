# Handoff (2026-10-26)

For whoever continues this project, human or agent, on another machine. Read `README.md` first; this file holds only the current status and the next steps.

## Goal

When ChatGPT desktop's agent (Codex, or local Work) stops or hits its usage limit, Claude Desktop (Chat or Cowork) reads recorded progress through a read-only MCP server and **continues the same unfinished files**. It must not recreate them.

## Verified so far (Windows 11, ChatGPT desktop 26.1016, Claude Desktop 3.6556)

- **Capture.** Plugin hooks record prompts, tool calls with their results, and Stop/Interrupt events as they happen (`codex-plugin/`, `src/hook.mjs`).
- **Chat-view continuation passed** (`evidence/2026-10-23-glossary/`). Claude Desktop finished a partial `glossary.md` saved by ChatGPT. The 3 finished sections are byte-identical and the 3 TODO sections were completed; the validator reports VALID.
- **Cowork retrieval works.** Cowork sessions call the local `desktop-continuity` tools (`evidence/2026-10-23-simulated-limit/`, `evidence/2026-10-23-cowork-glossary/`).
- **Limit detector.** 9 fixtures pass, including the shape of a real 100% limit window found in this machine's history. A watcher (`src/watch.mjs`) does not depend on the Stop hook.

## Completed on the Windows PC (2026-10-26)

- **Cowork finished the partial web-security `glossary.md` in place.** 2 finished sections byte-identical, 4 completed (`evidence/2026-10-23-cowork-glossary/`).
- **Cowork finished the partial multi-file project.** Codex had implemented 2 of 4 modules; Cowork wrote the other 2; `node --test` 4/4, run locally (`evidence/2026-10-25-cowork-multifile/`).
- **The simulated-limit hook opened a Cowork takeover draft**, once per signal, after the opener fix (`evidence/2026-10-23-simulated-limit/`).

## Session Capsule integration (2026-10-29, merged in pull requests #2 to #4)

Adds cross-computer continuation without changing same-computer takeover. README, *Moving a task to another computer*, describes the flow and the route table. The contract is in `session-capsule/docs/blocker-integration.md`.

- **New:**
  - `src/capsule/schema.mjs`: the handoff object, mirrored from Session Capsule's JSON Schema.
  - `src/capsule/export.mjs`: checkpoint and events to a handoff. Refused while `sourceStatus` says the source may still be working.
  - `src/capsule/imported-store.mjs`: isolated imports, project mapping and deduplication.
  - `src/capsule/continue.mjs`: destination routes.
  - `scripts/check-capsule.mjs`.
- **Changed:**
  - `src/mcp-server.mjs`: 6 read-only import tools and the `continue_import` prompt. The existing tools are unchanged; the file listing and read code is now shared.
  - `src/takeover.mjs`: `openUrl` and `copyToClipboard` are exported with the same behaviour, and `importedTakeoverPrompt` is added.
  - `scripts/check.mjs`: the expected tool list includes the new tools.
- **Run on a Mac (2026-10-29):** `check`, `check-limits`, `check-takeover` and `check-capsule` all pass. `check-capsule` uses synthetic events on one machine. The export gate was exercised because ChatGPT was running; on a machine where it isn't, the check prints that the gate was not exercised.
- **Not yet done:**
  - A live MacBook → PC and PC → MacBook transfer with real Codex sessions.
  - `continue.mjs --to cowork` on macOS.
  - Any Claude Code or Codex launch route. Both are manual paste.
- **Open decisions:** backup retention (Session Capsule keeps import backups until removed) and whether encryption should be the default (it is optional; unencrypted capsules are labelled as such).

## Still open

1. **`continue_latest` in the `/` menu.** Not confirmed. MCP prompts are user-invoked and their UI placement is app-specific. The supported invocation is `node src/takeover.mjs` (no id: newest unfinished session; it refuses when the choice is ambiguous).
2. **Real-limit behaviour.** Whether Codex fires Stop on a real limit, and whether the takeover launch works from inside Codex's hook sandbox. `src/watch.mjs` avoids the first dependency; neither has been observed on a real limit.
3. **macOS, live.** Checks and code paths were run on a Mac on 2026-10-29 (README, *macOS*). Still to do there: install for real, trust the hooks, and repeat a demo end to end. That covers `open claude://cowork/...` and hooks inside Codex's macOS sandbox.

The recorded sessions and demo folders exist **only on the Windows PC**. On a new machine, rerun the demos from scratch.

## Continue on macOS

1. Clone, run `npm install`, then `node scripts/install.mjs --writable-folder <demo folder>`.
   - The installer points the plugin's hooks at this clone. It writes `~/.agents/plugins/marketplace.json`, `~/.codex/plugins/desktop-continuity`, and Claude's `~/Library/Application Support/Claude/claude_desktop_config.json`, backing each up first.
2. Restart ChatGPT. Install **Desktop continuity** from *Personal plugins* and trust its 8 hooks.
3. **Quit Claude Desktop fully and reopen it.** The MCP server only reloads on a full quit; a quick restart did not reload it on Windows.
4. Run the checks: `node scripts/check.mjs`, `node scripts/check-limits.mjs`, `node scripts/check-takeover.mjs`.

Run on a Mac on 2026-10-29: the three checks pass; `pbcopy` and `pgrep -x ChatGPT` work; the installer works against a throwaway `HOME`, and its hook records under a GUI-style minimal PATH (it now names node by absolute path). Not yet run: `open claude://...` and a live demo. Install from a permanent folder, because the hooks and MCP config point at the clone. `scripts/demo/desktop.ps1` is Windows-only.

## To reproduce a demo on a new machine

1. **Multi-file.** Create a fresh copy of the project from `evidence/2026-10-25-cowork-multifile/before/` (tests, `TASK.md`, `package.json`). In that copy `slugify.js` and `titleCase.js` are already implemented; replace them with the TODO stub that `truncate.js` shows.
   - In ChatGPT Work mode, send the prompt (it is in the recorded events), then press Stop during the pause.
   - Run `node src/takeover.mjs <id> --wait=600`, with Claude Desktop's Chat/Cowork view in front.
   - In Cowork: confirm the folder, press Send, reply OK, Allow write access, and approve the edits.
   - Validate with `npm test`, plus hashes showing the 2 finished files are unchanged.
2. **Glossary.** Same flow; check with `node scripts/validate-continuation.mjs before.md after.md`.

## Gotchas found the hard way

- **Session id argument.** Claude Desktop's chat/Cowork bridge drops the string `session_id` argument. Use the integer `session_ref`; a string `path` does arrive.
- **Handed-off threads.** A thread started from ChatGPT Chat (and sometimes Work) is handed to an agent in an app-created folder (`Documents/Codex/<date>/referenced-chatgpt-conversation-…`). Takeover uses the folder recorded for the thread.
- **Background threads.** The ChatGPT app runs its own threads with no transcript (suggestion threads). They are recorded, and excluded from takeover.
- **How Codex writes files.** Codex desktop often writes with PowerShell, not `apply_patch`. The checkpoint therefore finds files by their on-disk timestamps, and flags tool results whose output reports an error.
- **Agent permissions.** The agent may not click security or permission dialogs, whatever the user allows: Claude Code denies it as "Security Weaken". Plan for the user to do those clicks.
