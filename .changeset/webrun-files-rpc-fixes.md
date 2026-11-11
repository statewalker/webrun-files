---
"@statewalker/webrun-files-rpc": patch
---

Fixes: a metadata call still running after `idleTimeout` keeps its `requestId` (a retry delivered meanwhile no longer runs it a second time); a read takes its listener off its `signal` when it ends (a long-lived signal no longer gathers one per read); `errorCode(e)` returns only protocol codes, not another error's own `code` (such as `ENOENT`).
