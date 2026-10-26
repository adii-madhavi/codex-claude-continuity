# Multi-file Cowork continuation, 2026-10-25/26: PASSED

Project: D:\dc-demo-multifile (task and tests written beforehand; 4 TODO stubs).
Source: ChatGPT desktop 26.1016, Work mode, thread 01a171ef (ran in the project folder). The agent (Claude Code, via scripts/demo/desktop.ps1) opened the codex:// link, clicked Work and Send, and pressed Stop during a deliberate Start-Sleep 300: a SIMULATED interruption. Codex had implemented slugify and titleCase; 2/4 tests passed.

Destination: Claude Desktop 3.6556.2.0 Cowork, opened from the takeover link (prompt prefilled, folder attached). The user pressed Send (the agent was denied: link-filled prompts carry a caution banner) and allowed folder access. The agent verified the source had stopped and the files matched the snapshot, then typed the OK. Cowork called get_checkpoint and get_source_status only, then wrote truncate.js and wordCount.js in its VM.

Validation (validation.txt) was run by the developer agent with node --test on the PC, not by Cowork: slugify.js and titleCase.js unchanged; tests, TASK.md and package.json unchanged; 4/4 tests pass. Whether Cowork ran npm test itself was not established.

First Cowork call came 237 s after the takeover launch. explorer.exe failed to hand the link to Claude Desktop 3.6556.2.0 (it opened File Explorer); Start-Process (ShellExecute) worked.
