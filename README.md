# desktop-continuity

This project records what the ChatGPT desktop app's Codex and local agent threads do while they work. When the source stops or hits its usage limit, Claude Desktop can read a compact checkpoint and selected details through a read-only MCP server, then continue the same work.

It is a separate project from `D:\keepitmovin`, which supervises terminal agents in a PTY; that is not used here. `src/redact.mjs` is adapted from keepitmovin under the MIT license (see `NOTICE`).

Tested on 2026-10-23 to 2026-10-26 with Windows 11, ChatGPT desktop 26.1016 (Codex 0.163) and Claude Desktop 3.6556.1.0 / 3.6556.2.0. macOS code paths exist but have not been run. **For handoff to another machine, see `HANDOFF.md`.**

Observed on these versions, which may change with app updates:
- **Cowork runs its agent in the cloud.** Its folder dialog says so. It reaches the local MCP servers configured in `claude_desktop_config.json`, although one help article says Cowork cannot.
- **The takeover link attaches the folder read-only.** Writing needs a separate native "Allow Claude to access this folder?" grant, which times out if nobody answers.
- **Link-filled prompts carry a caution banner.** Claude Code's permission check refused to let the agent press Send past it, or click any folder/permission dialog; those clicks are the user's.
- **`claude://` links can silently fail.** On 3.6556.2.0, `explorer.exe <url>` opened File Explorer, and a hidden or detached launcher never reached Claude. `src/takeover.mjs` now uses a normal `Start-Process` child, which opened the draft.

## Assessment against the original goal

1. **What now works**
   - Capture of local ChatGPT desktop agent threads, as each event happens.
   - A checkpoint that keeps observed facts, agent notes and inferred remaining work apart. It finds files written by shell commands and lists unfinished markers in files the source never touched. It flags results whose output reports an error and marks unknown outcomes and stale state.
   - Read-only MCP retrieval in Claude Desktop Chat and Cowork, with a `destinationMayEdit` gate.
   - Choosing the session to continue: `continue_latest` and `takeover.mjs` without an id pick only an unfinished session, and list the candidates when the choice is ambiguous.
   - A limit detector that classifies structured records only and answers "unknown" when it can't tell. A watcher works without the Stop hook. At most one takeover per limit signal.
2. **Demonstrated in the real desktop apps (all interruptions simulated with Stop)**
   - **Chat view, Markdown:** finished the same partial `glossary.md`. 3 finished sections byte-identical, 3 completed (`evidence/2026-10-23-glossary/`).
   - **Cowork, Markdown:** finished the same partial web-security `glossary.md`. 2 finished sections byte-identical, 4 completed in 4 separate edits (`evidence/2026-10-23-cowork-glossary/`).
   - **Cowork, multi-file Node project:**
     - The agent drove ChatGPT itself: Work mode, Send, then Stop during a deliberate pause. Codex had implemented 2 of 4 modules.
     - Cowork called only `get_checkpoint` and `get_source_status`, then wrote the other 2 modules. The finished files, tests and task file were unchanged.
     - `node --test` passes 4/4, run locally by the agent, not by Cowork. Cowork reports it ran `npm test` too (`evidence/2026-10-25-cowork-multifile/`).
   - **Simulated limit:** the real hook opened a Cowork draft with the takeover prompt and the folder, once per signal (`evidence/2026-10-23-simulated-limit/`).
3. **What used simulation**
   - Every interruption was a user or agent pressing Stop, during a deliberate `Start-Sleep` in the Cowork runs.
   - The limit trigger used `scripts/simulate-limit.mjs` with a sanitized transcript at the shape of a real limit seen on this machine. No real limit was hit or forced.
   - Whether Codex fires its Stop hook on a real limit is not established. The watcher removes that dependency, but it has not been run against a real limit either.
4. **What remains manual (Cowork route), counted as separate interactions**
   1. Start the takeover: run `node src\takeover.mjs`, or let the automatic trigger do it. It opens a Cowork draft with the prompt and the recorded folder.
   2. Confirm the attached folder, if Claude Desktop asks.
   3. Press **Send**. The agent was not allowed to do this past the caution banner.
   4. Approve tool calls, if Claude Desktop asks; in these runs it did not ask separately.
   5. Reply **OK** after Claude states the evidence that the source stopped.
   6. **Allow** write access to the folder.
   7. Approve edits, if asked.

   If the folder has moved, the chat route is used instead, which adds Ctrl+V and Add folder.
5. **What cannot be recovered**
   - Hidden reasoning.
   - Text streamed but never completed as a message.
   - Unsaved editor state.
   - Chat-mode conversations and cloud agent threads, where hooks do not run.
6. **Continue or recreate?** The system can now continue saved, unfinished work instead of recreating it. This was shown for one Markdown artifact in one run. Content that was never saved to disk can still only be recreated.

## Supported desktop modes and exclusions

On this PC, "ChatGPT desktop" and "Codex desktop" are **one app** (Store package `OpenAI.Codex`, shown as *ChatGPT*, with Chat, Work and Codex modes).

| Source | Captured? | Why |
|---|---|---|
| Codex threads and local Work threads | **Yes** | Plugin lifecycle hooks run there ([hooks docs](https://learn.chatgpt.com/docs/hooks)). |
| A Chat conversation handed to an agent | **Yes, as an agent thread** | The app starts a local agent thread in a folder it creates (`Documents\Codex\<date>\referenced-chatgpt-conversation-…`). Both glossary runs came in this way. |
| Chat-mode conversations | **No** | No documented local or API access. The closest workflow is exporting or pasting the conversation into Claude yourself. |
| Cloud Work threads | **No** | The docs say local hooks do not run with cloud orchestration. |

The destination is Claude Desktop's **Chat view**, not its Code tab (Claude Code).

## Capability assessment

| Question | Codex and local agent threads | Chat mode and cloud Work | Claude Desktop |
|---|---|---|---|
| 1. Read messages as they happen | **Partly, documented.** Hooks deliver user prompts and the final reply of a completed turn. Completed interim agent messages come from the transcript, which is undocumented. | No | n/a |
| 2. Tool actions, results, changed files | **Yes.** Pre/PostToolUse input and result. Changed files come from patch headers and from on-disk timestamps inside the session, because Codex often writes files with PowerShell. | No | n/a |
| 3. Progress after an abrupt stop | **Yes**, for anything saved. Each event is written when it fires. Text streamed but never completed is not saved anywhere locally. | No | n/a |
| 4. Detect a usage limit | **Best-effort.** Structured transcript records only (undocumented format). | No | n/a |
| 5. Start or submit a conversation | Prefill only (`codex://new?prompt=&path=`). | Prefill only | **Prefill only.** `claude://cowork/new?q=&folder=` prefilled the prompt and attached the folder after you confirmed it. `claude://claude.ai/new?q=` opened an **empty** chat on this version. Nothing can press Send for you. |
| 6. Local MCP in Claude Desktop | n/a | n/a | **Yes, documented** ([local MCP](https://modelcontextprotocol.io/docs/develop/connect-local-servers)). |
| 7. Files and tools to continue | n/a | n/a | Reads go through this server. Writes go through `continuity-files` (configured folders only), or through Claude Desktop's own **Add folder**. With an added folder, Claude Desktop runs commands in its sandboxed VM with only that folder mounted. That is how the glossary edits were made. |

Other sources:
- [Projects and chats](https://learn.chatgpt.com/docs/projects)
- [Use ChatGPT](https://learn.chatgpt.com/docs/use-chatgpt)
- [Windows sandbox](https://learn.chatgpt.com/docs/windows/windows-sandbox)
- [Package a plugin](https://developers.openai.com/plugins/build/plugins)
- [Claude Desktop deep links](https://support.claude.com/en/articles/14729294-open-claude-desktop-with-a-link)

No cookies, tokens or account endpoints are used, and no approval control is bypassed.

## Architecture

```
ChatGPT desktop (Codex / local agent thread)
  └─ Codex plugin "desktop-continuity" ─ lifecycle hooks ─▶ src/hook.mjs            (capture)
        ~/.codex/plugins/data/desktop-continuity-personal/sessions/<thread>.jsonl      (storage)
Claude Desktop ─ stdio MCP ─▶ src/mcp-server.mjs (read-only) ─▶ src/checkpoint.mjs  (checkpoint, on demand)
src/takeover.mjs ─▶ claude://cowork/new?q=<prompt>&folder=<project> (+ clipboard)   (takeover)
```

- **Capture** (`src/hook.mjs`) writes one redacted, size-bounded line per event, and exits 0 silently so it never blocks Codex. Hooks run inside Codex's sandbox, where only a plugin's `PLUGIN_DATA` folder is writable; that is why capture ships as a plugin.
- **Checkpoint** (`src/checkpoint.mjs`) is read first. It has four parts:
  - `observed`: every user message in order, the touched files with their current on-disk state (size, time, unfinished markers under their headings), recent actions, and the count of actions with no recorded result (**UNKNOWN**, never counted as success).
  - `agentNotes`: final messages from the Stop hook, plus completed transcript messages. Each is labelled with where it came from and treated as a claim, not a fact.
  - `inferred`: remaining work found from unfinished markers, and a next step. These are derived, not recorded intent.
  - `missing`: what is absent, stale (files changed after the last recorded event) or simulated.
- **Source status** (`get_source_status`) combines:
  - the end-of-turn events (Stop, Interrupt, SessionEnd);
  - whether ChatGPT is running and how recently the transcript changed;
  - the limit classification;
  - project files changed after the last event. A recent change means the source may still be working.
- **MCP tools** (all read-only): `list_sessions`, `get_checkpoint`, `get_source_status`, `get_events` (paged), `get_event`, `list_project_files`, `read_project_file`.
  - Prompts: `continue_task` and `continue_latest` (no arguments).
  - Scope: limited to the thread's recorded project. Credential files are never read, and responses are capped at 20,000 characters.
  - Session argument: each tool takes an integer `session_ref`, because Claude Desktop's chat bridge drops the string `session_id`. A call naming no session is refused.
- **Limit detector** (`classifyLimit` in `src/source.mjs`) returns `limit_reached`, `approaching`, `no_limit_signal` or `unknown`. It reads structured records only: an `error` event with a limit `codex_error_info` or "You've hit your usage limit", a non-null `rate_limit_reached_type`, or a window at `used_percent` 100. Prose is ignored. Unfamiliar shapes and a truncated newest record give `unknown`. A later window below 100%, or a new turn, clears the limit.
- **Takeover** (`src/takeover.mjs`):
  - Automatic: on a Stop whose transcript classifies as `limit_reached`, once per signal.
  - Manual: `node src\takeover.mjs [thread]`, which refuses to open a second chat for the same thread without `--again`.
  - The prompt tells Claude to read the checkpoint first, not re-ask what is recorded, continue the same files, and state the evidence that the source stopped and wait for OK before its first edit.
  - Launches are logged in `takeover-launches.log`.

## Takeover: exact user actions

1. **Start it.** Either the automatic trigger fires on a classified limit, or you run `node D:\desktop-continuity\src\takeover.mjs`. Both open a Claude Desktop **Cowork** session with the prompt prefilled and the thread's project folder attached. The prompt also goes on the clipboard.
2. **Confirm and send.** Confirm the folder in Claude Desktop's dialog, review the prompt, and press **Send**.
3. **Allow the tools.** Allow the desktop-continuity tool calls, or choose Always allow for these read-only tools.
4. **Approve the plan.** Reply OK when Claude states the evidence that the source stopped and names the files it will change. Then approve its edits.

**Fallback.** If the project folder no longer exists, or you set `DESKTOP_CONTINUITY_ROUTE=chat`, a Chat-view conversation opens instead. Then press Ctrl+V, and click **Add folder** if the folder isn't a `continuity-files` folder.

**Verified:**
- The Cowork link prefills the prompt and attaches the folder.
- A Cowork session called the desktop-continuity tools (`trigger-and-calls.txt`).
- The glossary *edits* were made from a Chat-view session with an added folder.

**Not tested:** edits from a Cowork session, and whether `continue_latest` appears in the `/` menu.

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
1. Restart ChatGPT, install **Desktop continuity** from *Personal plugins*, and trust its 8 hooks.
2. Fully quit Claude Desktop from the tray and reopen it. Do this again after any change to `src/` that the MCP server uses.

Checks (no AI tool is used):
- `node scripts/check.mjs`: capture, redaction, artifacts, stale detection, MCP tools and prompts.
- `node scripts/check-limits.mjs`: limit fixtures and one launch per signal.
- `node scripts/validate-continuation.mjs <before> <after>`: whether a continued artifact kept its finished sections and completed the rest.

## Evidence

### Continuing an unfinished artifact (`evidence/2026-10-23-glossary/`)

1. **The source.** A ChatGPT desktop agent thread (`01a1678a…`, started from a Chat conversation) wrote `glossary.md` with the PowerShell tool:
   - a six-section skeleton of TODOs;
   - Latency, Throughput and Idempotency filled in, one edit each.
2. **The interruption (simulated).** The prompt told Codex to run `Start-Sleep 180` at that point. You pressed Stop during the pause, at 06:56:55Z, before any final handover.
3. **Before snapshot** (`before.md`). 1050 bytes, SHA-256 `6626e426…`, last written at 06:55:56Z.
   - The hooks recorded 28 events, and the sleep call has no result (UNKNOWN).
   - No project file changed after the last event, so the source had stopped modifying the project.
4. **Checkpoint** (`checkpoint-before-takeover.json`). It found `glossary.md` from its on-disk timestamp, listed the three TODO sections as remaining work, and included two completed Codex messages labelled by source.
5. **Claude Desktop chat** (`destination-calls.txt`):
   - 07:03:10–19Z: called `get_checkpoint`, `get_source_status`, and `get_event seq 2` (the full prompt, which the checkpoint had cut off).
   - It stated the evidence that Codex stopped, said it would change only `glossary.md` and would not re-run the interrupted pause, and waited for OK.
   - After OK, it made three writes (12:40:51, :55 and :59 local) through its VM, with only that folder mounted read-write.
6. **After** (`after.md`, `before-after.diff`, `validation.txt`):
   - Same file, now 2096 bytes, SHA-256 `f6ffc7ab…`.
   - The diff replaces exactly the three TODO lines and changes nothing else; no other files were created.
   - The validator reports **VALID**: the 3 finished sections are byte-identical, and the 3 unfinished sections are completed.

Before this run, the checkpoint found no files that Codex wrote with PowerShell. It now also lists files whose on-disk timestamps fall inside the session (commit `2f5518a`).

### Limit-triggered takeover (`evidence/2026-10-23-simulated-limit/`)

- **Detector checks** (`scripts/check-limits.mjs`, 9 sanitized fixtures):

  | Fixture | Result |
  |---|---|
  | Recognized limit error | `limit_reached` |
  | Prose about limits | `no_limit_signal` |
  | 92% warning | `approaching` |
  | Unfamiliar format | `unknown` |
  | Truncated newest record | `unknown` |
  | Repeated signal | `limit_reached`, signal count 3 |
  | Resumed after a limit | `no_limit_signal` |
  | Real 100%-window shape | `limit_reached` |
  | Window reset | `no_limit_signal` |

  Run through the real hook in dry-run mode, two identical Stops produce one launch. Prose, approaching, unknown, truncated, resumed and non-Stop events produce none.
- **Real history.** Across all 55 Codex transcripts on this PC (221 MB), 54 classify as `no_limit_signal` and 1 as `limit_reached`. That one is a **real** limit: on 2026-10-20 at 17:37Z, Codex wrote `used_percent: 100` for the 5-hour window, with `rate_limit_reached_type: null` and no error record, and the turn still ended normally. No false positives were found.
- **Simulated trigger with the real apps** (`trigger-and-calls.txt`):
  - `scripts/simulate-limit.mjs` fed the real hook a session marked `simulated`. Each simulated session launched exactly once, even though each got two Stops.
  - The first run exposed a bug: the hook exited before the clipboard copy finished. That run's launch therefore did not copy the prompt. Fixed in `3fdfeeb`.
  - Claude Desktop's chat then called `get_checkpoint` and `get_source_status` for the simulated session, which reported `limit_reached`, and changed no files.
- **What is still unverified.** Whether Codex fires the Stop hook for a turn that ends because of a real limit, and whether the automatic launch works from inside Codex's sandbox. The simulation ran the hook outside the sandbox.

### Efficiency (`evidence/2026-10-23-glossary/payload-sizes.json`)

| What | Bytes |
|---|---|
| Claude's MCP retrieval for the glossary takeover: checkpoint 11,177 + source status 1,331 + one event 2,709 | **15,217** |
| Our recorded timeline | 25,907 |
| Codex's full local transcript of that thread | 305,809 (about 20× the retrieval) |

Most of the transcript is Codex's system and skill instructions, not conversation. Claude also read the 1 KB artifact itself. These are bytes, re-measured with the current code; **token usage was not measured**.

On repeated questions:
- The glossary takeover asked only one question, about re-running the interrupted pause (an UNKNOWN action). It fetched the truncated prompt instead of asking.
- The three questions in the earlier horror-script run were necessary: the recorded request ("make me a script for a horror show") said nothing about format, style or destination.

### Earlier: task transfer without a saved artifact

A local Work thread ("make me a script for a horror show") was stopped after about 10 seconds. Claude Desktop read its checkpoint and wrote a new script as a Claude document. Codex's partial draft had never been saved, so this showed task transfer, not continuation.

## Findings worth knowing

- **Claude Desktop 3.6556's chat bridge drops some tool arguments.** A required, described string `session_id` arrived as `{}`, while integers and an optional undescribed string (`dir`) arrived intact. Its local MCP calls also do not appear in Claude's `mcp.log`. The server's own `mcp-calls.log` records them.
- **`claude://claude.ai/new?q=` opened an empty chat** on this version, while **`claude://cowork/new?q=&folder=` prefilled the prompt and attached the folder**. Cowork sessions reach the local MCP servers configured in `claude_desktop_config.json`: the calls arrived. One help article says they don't.
- **Standalone hooks cannot record in the desktop app.** They run in Codex's Windows sandbox and get `EPERM` outside the workspace. Plugin hooks get a writable `PLUGIN_DATA` folder.
- **The root `plugin.json` must contain only `name`.** With extra fields, Codex installed the plugin but silently loaded none of its hooks.
- **Codex desktop on Windows often writes files with PowerShell**, so file detection cannot rely on patch headers.
- **A Chat conversation handed to an agent runs in an app-created folder**, not the folder you picked. The destination needs that folder granted, through **Add folder** or `continuity-files`.

## Limitations

- **Capture coverage.** Chat mode and cloud Work threads are not captured.
- **Message coverage.** Hooks see only the final assistant message of a completed turn. Interim messages come from the undocumented transcript, completed messages only. Hidden reasoning and streamed-but-unfinished text are never available.
- **Limit detection.** It depends on Codex's undocumented local transcript format. Automatic takeover on a real limit has not been observed.
- **File detection by timestamp** can include files that something else changed during the session. They are labelled "writing tool not identified".
- **Writes in Claude Desktop** need a folder you grant (Add folder) or a configured `continuity-files` folder. This project does not widen write access on its own.
- **No full automation.** Takeover still needs a folder confirmation, Send, tool approval and your OK. There are no desktop-automation tools in this environment, and no documented interface submits a Claude Desktop message.
- **Test scope.** Only one unfinished artifact, a Markdown file, was continued live. A desktop Codex task editing a multi-file code project has not been tested.
