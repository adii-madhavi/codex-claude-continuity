# Cowork continuation, 2026-10-23 to 2026-10-26: PASSED

Source: ChatGPT desktop agent thread 01a167b2 (handed off from Work mode into an app-created folder). Interruption: SIMULATED (Stop during a deliberate Start-Sleep 300). Codex left 2 finished and 4 TODO sections; its CSRF edit failed with a PowerShell ParserError.

Destination: a Cowork session opened by src/takeover.mjs (prompt prefilled, folder attached read-only). It read the checkpoint, source status and glossary.md through MCP (first call 199 s after launch).

What stopped it, in order: (1) the user's account usage limit, (2) a service-side safety-check outage that blocked its tool calls, (3) its first write-access request timing out unanswered. Each time it changed nothing and re-checked the source before acting.

After the user allowed write access on 2026-10-26, Cowork filled the 4 TODO sections in 4 separate commands in its local VM (folder mounted rw). Validation: VALID; Hashing and Salting byte-identical; only the 4 TODO lines were replaced (before-after.diff).

The user's clicks: Send (the agent sent "continue" itself on 2026-10-25/26), folder-access Allow (twice; the first timed out), OK reply, edit approval. The agent was not allowed to click the Allow dialog.
