# Handoff (2026-10-26)

For whoever continues this project, human or agent, on another machine. Read `README.md` first; this file holds only the current status and the next steps.

## Goal

When ChatGPT desktop's agent (Codex, or local Work) stops or hits its usage limit, Claude Desktop (Chat or Cowork) reads recorded progress through a read-only MCP server and **continues the same unfinished files**. It must not recreate them.

## Verified so far (Windows 11, ChatGPT desktop 26.1016, Claude Desktop 3.6556)

- **Capture.** Plugin hooks record prompts, tool calls with their results, and Stop/Interrupt events as they happen (`codex-plugin/`, `src/hook.mjs`).
- **Chat-view continuation passed** (`evidence/2026-10-23-glossary/`). Claude Desktop finished a partial `glossary.md` saved by ChatGPT. The 3 finished sections are byte-identical and the 3 TODO sections were completed; the validator reports VALID.
- **Cowork retrieval works.** Cowork sessions call the local `desktop-continuity` tools (`evidence/2026-10-23-simulated-limit/`, `evidence/2026-10-23-cowork-glossary/`).
- **Limit detector.** 9 fixtures pass, including the shape of a real 100% limit window found in this machine's history. A watcher (`src/watch.mjs`) does not depend on the Stop hook.

## Not finished

1. **Cowork editing a partial artifact.**
   - Session `01a167b2…` read the checkpoint and the file, then asked for folder access. The dialog said "this session runs in the cloud".
   - The folder that the takeover link attaches is **read-only** to Cowork, so writing needs a separate grant. The user has to click **Allow** on that native dialog; Claude Code's permission check refused to let the agent click it.
   - On the Windows PC that dialog was still open when work moved to the Mac. `glossary.md` there is still 2 finished + 4 TODO (`evidence/2026-10-23-cowork-glossary/before.md`).
2. **Multi-file continuation.**
   - Source half done: `D:\dc-demo-multifile`, recorded session `01a171ef…`. Codex implemented `slugify` and `titleCase`, then was stopped during a deliberate pause. 2 of 4 tests pass (`evidence/2026-10-25-cowork-multifile/`).
   - The Cowork half has not been run.
3. **Simulated limit into Cowork.** The trigger and the Cowork retrieval are done. A takeover that also *edits* after a simulated limit has not been run.
4. **`continue_latest` in the `/` menu.** Not confirmed. MCP prompts are user-invoked and their UI placement is app-specific. The supported invocation is `node src/takeover.mjs` (no id: newest unfinished session; it refuses when the choice is ambiguous).

The live state above (recorded sessions, partial files, the open dialog) is **only on the Windows PC**. On a new machine, rerun the demos from scratch.

## Continue on macOS

1. Clone, run `npm install`, then `node scripts/install.mjs --writable-folder <demo folder>`.
   - The installer points the plugin's hooks at this clone. It writes `~/.agents/plugins/marketplace.json`, `~/.codex/plugins/desktop-continuity`, and Claude's `~/Library/Application Support/Claude/claude_desktop_config.json`, backing each up first.
2. Restart ChatGPT. Install **Desktop continuity** from *Personal plugins* and trust its 8 hooks.
3. **Quit Claude Desktop fully and reopen it.** The MCP server only reloads on a full quit; a quick restart did not reload it on Windows.
4. Run the checks: `node scripts/check.mjs`, `node scripts/check-limits.mjs`, `node scripts/check-takeover.mjs`.

The macOS code paths are written but **not yet run on a Mac**: `open` and `pbcopy` in `src/takeover.mjs`, `pgrep -x ChatGPT` in `src/source.mjs`, and the installer's hook path. `scripts/demo/desktop.ps1` is Windows-only.

## Next steps

1. **Multi-file demo.** Create a fresh copy of the project (the 4 stubs, the tests and `TASK.md` are in `evidence/2026-10-25-cowork-multifile/before/`, with the stubs reset to TODO).
   - In ChatGPT Work mode, send the prompt (it is in the recorded events), then press Stop during the pause.
   - Run `node src/takeover.mjs <id> --wait=600`.
   - In Cowork: confirm the folder, press Send, Allow the tools, reply OK, grant write access, and approve the edits.
   - Validate with `npm test`, plus hashes showing the 2 finished files are unchanged.
2. **Glossary demo, in Cowork.** Same flow; check with `node scripts/validate-continuation.mjs before.md after.md`.
3. **Record and document.** Save the evidence, then update the README: Cowork runs in the cloud, the attached folder is read-only until a write grant, and count every user interaction.

## Gotchas found the hard way

- **Session id argument.** Claude Desktop's chat/Cowork bridge drops the string `session_id` argument. Use the integer `session_ref`; a string `path` does arrive.
- **Handed-off threads.** A thread started from ChatGPT Chat (and sometimes Work) is handed to an agent in an app-created folder (`Documents/Codex/<date>/referenced-chatgpt-conversation-…`). Takeover uses the folder recorded for the thread.
- **Background threads.** The ChatGPT app runs its own threads with no transcript (suggestion threads). They are recorded, and excluded from takeover.
- **How Codex writes files.** Codex desktop often writes with PowerShell, not `apply_patch`. The checkpoint therefore finds files by their on-disk timestamps, and flags tool results whose output reports an error.
- **Agent permissions.** The agent may not click security or permission dialogs, whatever the user allows: Claude Code denies it as "Security Weaken". Plan for the user to do those clicks.
