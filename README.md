# desktop-continuity

This project records what the ChatGPT desktop app's Codex and local Work threads do while they work. Claude Desktop can then read a compact checkpoint, plus selected details, through a read-only MCP server and continue the task.

It is a separate project from `D:\keepitmovin`, which supervises terminal agents in a PTY. None of that applies here. `src/redact.mjs` is adapted from keepitmovin under the MIT license (see `NOTICE`).

## Status (2026-10-23, Windows 11, ChatGPT desktop 26.1016, Claude Desktop 3.6556)

| Step | Status |
|---|---|
| Capture from a real ChatGPT desktop thread (local Work) | **Verified live** |
| Saved before the interruption | **Verified live**. The Interrupt event was on disk at the moment of Stop. |
| Checkpoint built from the recording | **Verified** |
| Claude Desktop discovers the MCP servers | **Verified**. Handshake, tools and prompts are listed in Claude's `mcp.log`. |
| Claude Desktop reads the checkpoint and checks the source | **Verified live** (see `mcp-calls.log` below). |
| Claude continues the task | **Verified live.** It wrote the requested script and left the Codex project untouched. |
| Codex-mode thread with file edits | Not exercised live. Covered by synthetic checks only. |
| Automatic takeover on a usage limit | Not exercised. No limit was hit, and none was forced. |

## Capability assessment

On this PC, "ChatGPT desktop" and "Codex desktop" are **one installed app**. The Store package is `OpenAI.Codex`, it is shown as *ChatGPT*, and it has Chat, Work and Codex modes. Its data comes from separate sources depending on the mode.

| Question | Codex threads and local Work threads | Chat mode and cloud Work | Claude Desktop |
|---|---|---|---|
| 1. Read messages as they happen | **Partly, documented** (lifecycle hooks): the user prompt, and the final reply of a completed turn | **No.** There is no documented local or API access, so export or paste is the only route. | n/a |
| 2. Tool actions, results, changed files | **Yes** (PreToolUse/PostToolUse input and result; files from patch headers) | No | n/a |
| 3. Progress after an abrupt stop | **Yes.** Each event is written when it fires. Text streamed before Stop is **not** saved anywhere locally. | No | n/a |
| 4. Detect a usage limit | **Best-effort.** Usage-window percentages come from Codex's local transcript, which the docs call "not a stable interface". | No | n/a |
| 5. Start or submit a conversation | Prefill only (`codex://new?prompt=`) | Prefill only | **Prefill only** (`claude://claude.ai/new?q=`). The user presses Send. |
| 6. Local MCP in Claude Desktop | n/a | n/a | **Yes, documented** (stdio, `claude_desktop_config.json`) |
| 7. Files and tools to continue | n/a | n/a | Read through this server. Write through the official filesystem server, **only for configured folders**. **No shell.** |

Sources:
- [Codex hooks](https://learn.chatgpt.com/docs/hooks)
- [Projects and chats](https://learn.chatgpt.com/docs/projects)
- [Use ChatGPT](https://learn.chatgpt.com/docs/use-chatgpt)
- [Windows sandbox](https://learn.chatgpt.com/docs/windows/windows-sandbox)
- [Package a plugin](https://developers.openai.com/plugins/build/plugins)
- [Claude Desktop deep links](https://support.claude.com/en/articles/14729294-open-claude-desktop-with-a-link)
- [Claude Desktop local MCP](https://modelcontextprotocol.io/docs/develop/connect-local-servers)

No cookies, tokens or account endpoints are used. Everything read is local data the apps write for the user.

## Architecture

```
ChatGPT desktop (Codex / local Work thread)
  └─ Codex plugin "desktop-continuity" ─ lifecycle hooks ─▶ src/hook.mjs   (capture)
        writes ~/.codex/plugins/data/desktop-continuity-personal/sessions/<thread>.jsonl  (storage)
Claude Desktop ─ stdio MCP ─▶ src/mcp-server.mjs (read-only) ─▶ src/checkpoint.mjs (checkpoint, on demand)
src/takeover.mjs ─▶ claude://claude.ai/new?q=<continuation prompt>   (takeover: prefill, user sends)
```

- **Capture** (`src/hook.mjs`) handles SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PreCompact, Stop, Interrupt and SessionEnd. It writes one redacted, size-bounded line per event and always exits 0 with no output, so it never blocks Codex.
- **Storage** (`src/store.mjs`) is one append-only file per thread. Readers skip torn lines. Each thread keeps its own project folder.
- **Checkpoint** (`src/checkpoint.mjs`) contains the request, the last reply, files touched, and recent actions. An action with no recorded result is marked **UNKNOWN: verify before repeating**, never treated as success. It also carries the source status and a list of what was not captured.
- **MCP** (`src/mcp-server.mjs`) offers `list_sessions`, `get_checkpoint`, `get_source_status`, `get_events` (paged), `get_event`, `list_project_files` and `read_project_file`. It also has the `continue_task` prompt.
  - Every tool is read-only and limited to the thread's recorded project.
  - Credential files are refused and secrets are redacted.
  - Responses are capped at 20,000 characters.
  - It cannot write files, run commands or control any app.
- **Takeover** is automatic when a turn ends while the transcript shows a usage window at 100%. Otherwise run `node D:\desktop-continuity\src\takeover.mjs [thread-id]`, or use the `continue_task` prompt. Claude Desktop only prefills; you press Send.
- **Before acting**, the prompt tells Claude to call `get_source_status`. That checks whether the turn ended, whether ChatGPT is running, and how recently the transcript was written. If the source may still be working, Claude must stop and ask.

## Setup

```
cd D:\desktop-continuity
npm install
node scripts/install.mjs --writable-folder D:\path\to\project
```

The installer backs up every file it changes and keeps all other settings:
- It copies `codex-plugin/` to `~/.codex/plugins/desktop-continuity` and lists it in `~/.agents/plugins/marketplace.json`.
- It adds `desktop-continuity` and, if you pass `--writable-folder`, `continuity-files` to Claude Desktop's config. On this MSIX install that is `%LOCALAPPDATA%\Claude-Data\claude_pzs8sxrjxfjjc\claude_desktop_config.json`.

Then:
1. Restart ChatGPT. Install **Desktop continuity** from *Personal plugins* and **trust its 8 hooks**.
2. Quit Claude Desktop from the tray and reopen it.

Run `node scripts/check.mjs` for the synthetic self-check.

## Verification evidence (live, 2026-10-23)

- **Source.** A new local Work thread `01a16748-43ca-7503-9d18-f0061fe976ad` with the prompt "make me a script for a horror show". You pressed Stop after about 10 seconds; that was a **simulated interruption**.
- **Saved before the interruption.** `hook-runs.log` shows `ok SessionStart 05:42:35Z`, `ok UserPromptSubmit 05:42:36Z` and `ok Interrupt 05:43:03Z`. The session file has the prompt, the model, the project folder and the Interrupt. Codex's own transcript agrees: `turn_aborted`, reason `interrupted`, at 05:43:03Z.
- **Checkpoint.** It reported state `interrupted`, no assistant output, no actions, and usage 2% (5-hour window) and 0% (weekly), so this was not a limit stop. That is why the automatic takeover correctly did not fire.
- **Discovery.** Claude's `mcp.log` at 05:38:18Z shows `desktop-continuity` and `continuity-files` doing initialize, tools/list and prompts/list successfully.
- **Takeover.** `src/takeover.mjs` opens a new Claude Desktop chat and puts the continuation prompt on the clipboard. You press Ctrl+V, then Send, then Allow for the tool calls.
- **Retrieval.** The server's own `mcp-calls.log` recorded the Claude Desktop chat calling, in order, at 06:20:59–06:21:20Z:
  - `get_checkpoint {"session_ref":1792734151626}`
  - `get_source_status` with the same ref
  - `get_events {"after_seq":0,"limit":10,...}`
  - `list_project_files` on the project root, then on `outputs`, then on `work`

  Claude saw that the turn was interrupted, the source was not still working, no limit was hit, and the project folders were empty, so nothing had been produced to repeat or avoid.
- **Continuation.** Claude asked three scoping questions: format (short film), flavor (supernatural), destination (editable doc). It then wrote "What the House Keeps", a 15-scene supernatural short of about 12 minutes, as a Claude Docs document. It reported that it did not touch the original Codex project folder.
  - Codex's partial draft from before the Stop was never saved locally, so Claude started the script fresh from the recorded request. It did not pick up the half-written text.

## Findings worth knowing

- **Claude Desktop 3.6556's chat drops some tool arguments.** `get_checkpoint` with a required, described string `session_id` arrived as `{}`, while optional integers and an optional undescribed string (`dir`) arrived intact. These calls also do not appear in Claude's `mcp.log`: the chat reaches local servers through its VM and bridge. So every session tool also takes an optional integer `session_ref` (from `list_sessions`). A call naming no session is refused.
- **`claude://claude.ai/new?q=` opened an empty chat** on this version; the documented prefill did not arrive. The takeover therefore also copies the prompt to the clipboard.

- **Standalone hooks cannot record in the desktop app.** Hooks in `~/.codex/hooks.json` run inside Codex's Windows sandbox (`mxc`). Writing outside the workspace fails with `EPERM`, and the temp folder is blocked too. Plugin hooks get a writable `PLUGIN_DATA`, so capture ships as a plugin.
- **The root `plugin.json` must contain only `name`.** With `$schema`, `version` or `description` in it, Codex 0.163 installed and enabled the plugin but silently loaded none of its hooks. The read-only `hooks/list` request to `codex app-server` showed this.
- **The hook strips a UTF-8 byte-order mark** from its input, which a PowerShell pipe adds.
- **Streamed text that never finished as a message is not saved anywhere local.** This includes a half-written Writing canvas. After a Stop, only the request and the interruption can be recovered.

## Limitations

- Chat mode and cloud Work threads are not captured. The closest supported workflow is an explicit export or paste into Claude. This project builds no UI that implies otherwise.
- Hooks see only the final assistant message of a completed turn, not messages between tool calls or hidden reasoning.
- Usage-limit detection reads an undocumented local transcript format and may break with app updates.
- Claude Desktop chat can write only in folders configured for `continuity-files`, and cannot run commands or tests.
- The automatic takeover's `explorer.exe` launch runs inside the hook's sandbox. It has not been verified to open Claude from there; the manual command does.
- Takeover needs you to press Ctrl+V and Send (plus Allow for each tool, unless you choose Always allow). Claude Desktop documents no way to submit a message from outside, and on this version the prefill link opened an empty chat.
