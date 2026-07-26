# VCP Pi Core fork

This directory is a deliberately small, source-controlled fork of the MIT-licensed
Pi Agent loop from `earendil-works/pi`, based on upstream commit `b4f29368`
(Pi 0.82.1, inspected 2026-07-26).

Retained behaviour: stateful transcript, streamed assistant events, sequential tool
loop, cancellation, steering and follow-up queues, and pre/post tool hooks.

Removed on purpose: Pi coding-agent/CLI/TUI, provider catalog and credentials,
extensions, skills, session JSONL persistence, image support, and all built-in
file/edit/bash tools. VCPChat supplies only VCP bridge tools and owns persistence,
approval, workspace policy and tool execution in Electron Main.

The fork is not API-compatible with the complete upstream package. To update it,
review upstream `packages/agent/src/agent.ts` and `agent-loop.ts`, port only a
needed loop behaviour, add a regression test, and update this file with the source
commit. Keep `LICENSE` with every redistribution.
