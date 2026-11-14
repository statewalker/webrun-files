---
"@statewalker/webrun-files": minor
"@statewalker/webrun-files-mem": minor
"@statewalker/webrun-files-browser": minor
"@statewalker/webrun-files-sqlite": minor
"@statewalker/webrun-files-composite": minor
"@statewalker/webrun-files-s3": minor
"@statewalker/webrun-files-node": patch
"@statewalker/webrun-files-http": patch
"@statewalker/webrun-files-rpc": patch
---

`FilesApi.move` is atomic where the backend allows it, so code that writes `index.lock` and moves it over `index` (as git does) never shows readers a missing or partial target. The `move` contract now says that it replaces an existing file, how each backend treats an existing directory, where it is atomic, and what a partial failure looks like.

- `@statewalker/webrun-files`: new `MoveIncompleteError` and `removeMovedSource(files, source, target)`. A copy-then-delete move whose source cannot be removed after the copy retries the removal once, then throws `MoveIncompleteError` (`move /a -> /b: the target was replaced, but the source could not be removed`) instead of returning `false`, which callers read as "nothing happened".
- `MemFilesApi`: `move` is one synchronous re-keying of the entry, or of every entry under a directory, instead of a copy and a remove with `await`s between them. An existing target is treated as `rename(2)` treats it, like `NodeFilesApi`: a file replaces a file, a directory replaces an empty directory, and anything else (a file onto a directory, a directory onto a file or a non-empty directory, a directory into its own subtree, a target below a file) returns `false` and changes nothing. Before, these cases merged or corrupted the tree, and a move into its own subtree never returned.
- `BrowserFilesApi`: checks an existing target the same way before moving; the native `FileSystemHandle.move()` stays the atomic path (current Chromium replaces an existing file), and the copy-then-delete fallback, used when it is missing or throws, still replaces a file's content in one step through a writable stream. A fallback whose source cannot be deleted now throws `MoveIncompleteError` instead of returning `false`.
- `SqlarFilesApi`: `move` is one transaction (through `inTransaction`, like `SqliteFilesApi`) that deletes the target's subtree, creates its parents and renames the source rows by prefix, keeping their data instead of copying it. It replaces the target's subtree, and throws when one path contains the other (before, a move into its own subtree deleted the data and returned `true`).
- `SqliteFilesApi`: `copy` and `move` rewrite name prefixes by characters, as SQLite's `substr()` counts them, so a source name with characters above U+FFFF no longer loses its children.
- `CompositeFilesApi` (across mounts) and `S3FilesApi`: still copy then delete, documented as not atomic; a source that cannot be removed now throws `MoveIncompleteError` instead of being ignored (composite) or returned as `false` (s3).
- `NodeFilesApi` (`fs.rename`, atomic), `webrun-files-http` and `webrun-files-rpc` (as atomic as the server's backend): documentation only.
