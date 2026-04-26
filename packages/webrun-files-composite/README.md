# @statewalker/webrun-files-composite

## What it is

A small toolkit of `FilesApi` decorators that lets you build a layered
virtual filesystem on top of any existing `FilesApi` implementation. It
ships three building blocks:

- **`CompositeFilesApi`** — mounts multiple `FilesApi` backends at different
  composite-namespace prefixes (longest-prefix wins), with optional
  per-mount sub-directory remapping.
- **`GuardedFilesApi`** — runs every call through an ordered list of
  per-operation policies that can deny access by throwing.
- **`FilteredFilesApi`** — hides selected paths so that the wrapped API
  behaves as if they did not exist.

## Why it exists

Real filesystems are rarely flat. Workbench-style apps need to combine
storage backends (local FS for projects, in-memory FS for transient data,
remote FS for shared documents), forbid writes to system folders, and hide
implementation-detail paths from end users. Implementing all of this inside
each storage backend leaks concerns and makes backends hard to swap.

This package keeps each backend pure and pushes composition / access /
visibility into orthogonal decorators that can be stacked in any order. The
three concerns are deliberately split across separate classes:

- **mounting** is structural and never throws — `CompositeFilesApi`.
- **access control** must throw to stay safe by default — `GuardedFilesApi`.
- **visibility** must silently lie to keep the consumer model simple —
  `FilteredFilesApi`.

## How to use

```bash
pnpm add @statewalker/webrun-files-composite
```

The decorators all implement `FilesApi`, so they compose freely. A typical
stack: a composite root that mounts a few backends, wrapped first with a
filter to hide internals, then with guards to forbid writes to system
folders.

```ts
import {
  CompositeFilesApi,
  FilteredFilesApi,
  GuardedFilesApi,
  newPathFilter,
} from "@statewalker/webrun-files-composite";

const composite = new CompositeFilesApi(localFs, "/projects")
  .mount("/docs", s3Fs, "/documentation")
  .mount("/cache", memFs);

const visible = new FilteredFilesApi(composite, newPathFilter("/.git"));

const safe = new GuardedFilesApi(visible, [
  {
    operations: ["write", "remove", "move", "mkdir"],
    check: (p) => !p.startsWith("/.system/"),
    message: "system folder is read-only",
  },
]);
```

## Examples

### Mount multiple backends

```ts
import { CompositeFilesApi } from "@statewalker/webrun-files-composite";

const fs = new CompositeFilesApi(rootFs)
  .mount("/docs", docsFs)
  .mount("/cache", memFs);

await fs.write("/readme.txt", [encoder.encode("Hello")]);  // → rootFs:/readme.txt
await fs.write("/docs/guide.md", [encoder.encode("# Guide")]); // → docsFs:/guide.md
await fs.write("/cache/tmp.dat", [encoder.encode("temp")]); // → memFs:/tmp.dat
```

### Remap to a sub-directory of the backend

```ts
const fs = new CompositeFilesApi(rootFs, "/projects")
  .mount("/docs", s3Fs, "/documentation");

await fs.write("/readme.md", data);     // → rootFs:/projects/readme.md
await fs.write("/docs/api.md", data);   // → s3Fs:/documentation/api.md
```

### Hide paths

```ts
import {
  FilteredFilesApi,
  newGlobPathFilter,
  newPathFilter,
  newRegexpPathFilter,
} from "@statewalker/webrun-files-composite";

// Prefix-based
const visible = new FilteredFilesApi(rawFs, newPathFilter("/.git", "/node_modules"));
await visible.exists("/.git");          // false (even if it exists in rawFs)
await visible.write("/.git/HEAD", x);   // throws "Path is hidden: /.git/HEAD"

// Regexp-based: hide every dotfile and every *.log file
const noLogs = new FilteredFilesApi(rawFs, newRegexpPathFilter(/\/\.[^/]+$/, /\.log$/));

// Glob-based: hide every .log anywhere, plus the entire .git tree
const noJunk = new FilteredFilesApi(
  rawFs,
  newGlobPathFilter("**/*.log", "/.git", "/.git/**"),
);
```

- `newPathFilter(...prefixes)` hides any path equal to one of the given
  prefixes or living under `${prefix}/`. Matching is boundary-aware:
  `"/priv"` does **not** match `"/private"`.
- `newRegexpPathFilter(...regexps)` hides any path matched by at least one
  regexp; the path is normalized before testing (single leading slash, no
  trailing slash).
- `newGlobPathFilter(...globs)` hides any path matched by at least one glob.
  Globs are compiled in `extended` + `globstar` mode: `*` stays inside one
  path segment, `**` spans any number of segments, `?` / `[abc]` / `{a,b}`
  do what bash does. Note that `/foo/**` matches descendants of `/foo` but
  **not** `/foo` itself — list both `"/foo"` and `"/foo/**"` to cover
  both, or just use `newPathFilter("/foo")` for a prefix-only filter.

For ad-hoc logic, pass any `(path) => boolean | Promise<boolean>` predicate
directly (returning `true` for visible, `false` for hidden).

### Guard operations

```ts
import { GuardedFilesApi } from "@statewalker/webrun-files-composite";

const guarded = new GuardedFilesApi(fs, [
  {
    operations: ["write", "remove", "move", "mkdir"],
    check: (p) => !p.startsWith("/.settings/"),
    message: "settings folder is read-only",
  },
  {
    operations: ["write"],
    check: (p) => !p.includes(".."),
    message: "no path traversal",
  },
]);
```

Guards are evaluated in the order they were passed. The first denying
guard throws `Error("<message>: <normalized-path>")`. A guard that lists
`"read"` also fires on the source side of `move`/`copy` and on every
`exists` call; one that lists `"write"` fires on the target side of
`move`/`copy`; one that lists `"list"` also fires on `stats`.

### Cross-mount move/copy

`CompositeFilesApi` resolves `move` and `copy` across mounts by performing
a recursive copy and (for `move`) deleting the source. Use guards/filters
to gate these flows by composite path:

```ts
await fs.move("/cache/draft.md", "/docs/draft.md"); // memFs → s3Fs
```

## Internals

### Architecture

```
+---------------------+
|  GuardedFilesApi    |  policy: throw on denied operations
+---------------------+
|  FilteredFilesApi   |  visibility: pretend hidden paths don't exist
+---------------------+
|  CompositeFilesApi  |  routing: longest-prefix mount, sub-dir remap
+---------------------+
|   backend FilesApi  |  storage: mem / node / s3 / browser …
+---------------------+
```

The decorators implement `FilesApi`, so any of them can wrap any other in
any order. The diagram above is the typical stack but not the only valid
one (e.g. you can put a `FilteredFilesApi` *behind* a mount to scope its
filter to that mount only).

### CompositeFilesApi — path resolution

1. Input paths are normalized (forward slashes, leading `/`, no trailing `/`).
2. The mount with the **longest matching prefix** wins. The implicit `/`
   mount set by the constructor is always last.
3. The matched prefix is stripped and the mount's `fsPath` is prepended.
4. Mount points themselves appear as synthetic directories in `list()` and
   `stats()`, and `remove()` on a mount point throws.

### GuardedFilesApi — effective operation matrix

| API method   | Operations checked                                  |
| ------------ | --------------------------------------------------- |
| `read`       | `read`                                              |
| `write`      | `write`                                             |
| `mkdir`      | `mkdir`                                             |
| `remove`     | `remove`                                            |
| `list`       | `list` on the path AND on each directory entry      |
| `stats`      | `list`                                              |
| `exists`     | `read`                                              |
| `move(s, t)` | `move`+`read` on `s`; `move`+`write` on `t`         |
| `copy(s, t)` | `copy`+`read` on `s`; `copy`+`write` on `t`         |

This expansion makes `read`/`write`-scoped guards apply naturally to
`move`/`copy` as well, so callers don't need to repeat the same prefix in
multiple operation lists.

### FilteredFilesApi — silent vs loud failures

| Hidden path on call | Behaviour                |
| ------------------- | ------------------------ |
| `read` / `list`     | empty iterable           |
| `stats`             | `undefined`              |
| `exists`            | `false`                  |
| `remove`            | `false`                  |
| `move` / `copy`     | `false` (no side effect) |
| `write` / `mkdir`   | throws `"Path is hidden"` (silent drop would lose data) |

### Constraints

- The root mount (`/`) is fixed at construction; you cannot remount it.
- Mount points are immutable — `remove()` on a mount point throws.
- Cross-mount `move` is copy + delete; not atomic.
- `newPathFilter()` (no args) hides nothing; entries that normalize to
  `"/"` (empty string, `"/"`) are dropped because they would otherwise hide
  the whole tree.
- `newRegexpPathFilter()` (no args) hides nothing. Avoid stateful flags
  (`/g`, `/y`) — `RegExp.prototype.test` mutates `lastIndex` between calls
  and will give surprising results.
- `newGlobPathFilter()` (no args) hides nothing. Globs are anchored
  (compiled without the RegExp `g` flag) and run in `globstar` mode, so
  `*` does not cross `/`; use `**` to span segments. `/foo/**` matches
  descendants of `/foo` but not `/foo` itself.

### Dependencies

- `@statewalker/webrun-files` — core `FilesApi` interface and path utilities.

### Credits

- `globToRegExp` (in [`src/glob-to-regexp.ts`](src/glob-to-regexp.ts)) is a
  TypeScript port of [`glob-to-regexp`](https://github.com/fitzgen/glob-to-regexp)
  by Nick Fitzgerald (BSD 2-Clause). The port preserves the original
  semantics; only the surface API has been re-typed for TypeScript. See the
  upstream repository for the full license text.

## License

MIT
