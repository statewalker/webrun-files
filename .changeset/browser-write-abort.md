---
"@statewalker/webrun-files-browser": patch
---

`BrowserFilesApi.write` and `copy` no longer commit a cut-off file when the content fails part way: the writable stream is aborted (its swap file dropped), so the old file stays as it was, and a file the write created is removed again. Before, `close()` ran in `finally` and saved whatever had been written.
