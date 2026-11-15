# Paths never escape the root: `..` is resolved, or refused above the root

Date: 2026-11-15. Issue: [#40](https://github.com/statewalker/webrun-files/issues/40).

## Context

`normalizePath` used to drop empty and `.` segments but keep `..`. Each backend then did its own
thing: `NodeFilesApi` and the RPC server resolved `..`, the HTTP client rejected it, mem and S3 kept
it as a literal key. The decorators (`FilteredFilesApi`, `GuardedFilesApi`, `CompositeFilesApi`)
decide on the normalized string, so over a node backend `/x/../.git/config` passed a `/.git` filter
and read `<root>/.git/config`, and `/m/../y` escaped a mount's `basePath`: access was decided on
one path and performed on another.

## Decision

`normalizePath` resolves each `..` against the segment before it and throws
`Path climbs above the root: <path>` when a `..` has nothing left to remove. Its result, the
**normal path** (`GLOSSARY.md`), never holds a `..`. Every package normalizes through it: the RPC
server's private normalizer and the HTTP client's own `..` check are gone. The HTTP server's
base-path check and `NodeFilesApi`'s containment check stay as defence in depth. Symbolic links
inside a node `rootDir` stay out of scope.

## Alternatives

- **Clamp at the root** (`/../x` is `/x`), as the RPC server did. Rejected: a path that tries to
  escape is a bug or an attack, and silently serving a different file hides both.
- **Reject every `..`**, as the HTTP client did. Rejected: `/a/../b` is a legitimate in-tree path,
  and callers that build paths by joining relative parts would break for no safety gain once
  decisions are made on the resolved path.

## Consequences

- Keys already stored in mem, S3 or SQLite with a literal `..` segment cannot be reached through
  the API any more; rename them with a direct tool before upgrading.
- `joinPath`, `dirname` and `basename` throw on an escaping path too.
- The RPC server now refuses an escaping append instead of clamping it, and the HTTP client sends
  `/a/../b` as `/b` instead of refusing it.
