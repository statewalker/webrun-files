---
"@statewalker/webrun-files-node": minor
---

`NodeFilesApi.write` streams: each chunk goes to a temporary file beside the target as it arrives (small chunks batched to 64 KiB), and the temporary is renamed over the target once the content has ended. Memory stays at about one chunk instead of the whole file, a source that fails leaves the old file in place, and a file can be rewritten from its own `read`. The temporary has a dot-name (`.<name>.<uuid>.tmp`), so listings of git directories do not take it for a ref or object. Also fixed: a `NodeFilesApi` rooted at `/` refused every path.
