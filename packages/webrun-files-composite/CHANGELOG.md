# @statewalker/webrun-files-composite

## 0.10.0

### Minor Changes

- 2ea6787: Ordered listings and `ListOptions.after`. Every `list()` now yields entries in strictly increasing
  path order, compared by Unicode code point (UTF-8 byte order), recursively or not, and
  `{ after: path }` resumes after any path, existing or not. The core package adds `comparePaths`,
  `listInPathOrder` and `mergeInPathOrder`.

  Behaviour changes: listings that previously came out in backend order (Node `readdir`, browser
  handles, memory insertion order, S3 prefixes before keys, composite mounts last) are now sorted; a
  `CompositeFilesApi` mount point replaces a same-path entry of the parent backend in listings; an S3
  key `a` and keys under `a/` list `/a` once, as the file.

### Patch Changes

- Updated dependencies [2ea6787]
  - @statewalker/webrun-files@0.10.0

## 0.9.0

### Minor Changes

- `FileStats` is a discriminated union on `kind`.

  ```ts
  type FileStats =
    | { kind: "file"; size: number; lastModified: number }
    | { kind: "directory" };
  ```

  `size` and `lastModified` were optional on a single shape, which read as
  "this backend might not be able to report them". That was never what the
  optionality meant: it expressed a property of the entry KIND. A file always
  has both; a directory has neither. `FileInfo` is the same union plus `name`
  and `path`, so a `list()` consumer narrows per entry exactly as a `stats()`
  consumer does.

  A directory now reports nothing but its kind. Memory and Node both know a
  directory's modification time and an object store cannot, so no caller may
  rely on one, and the backends that know it drop it rather than offer a value
  that is present on one storage and missing on the next.

  S3 commits explicitly to the two questions `undefined` used to fudge: a common
  prefix IS the directory variant, and a zero-byte key ending in `/` is the
  marker `mkdir()` writes rather than a file with `size: 0`.

  `@statewalker/webrun-files-tests` gains a conformance case that enforces this
  at runtime, running from inside `createFilesApiTests` so every backend and
  every composite wrapper is checked without opting in.

  **Breaking:** reading `stats.size` or `stats.lastModified` without first
  narrowing on `stats.kind` is now a compile error. Each one points at a site
  that would have read `undefined` on a directory.

  ```ts
  // before
  const size = stats.size ?? 0;

  // after
  const size = stats.kind === "file" ? stats.size : 0;
  ```

  Note that a zero-byte file is the file variant with `size: 0`, so check the
  `kind` rather than the truthiness of `size`.

### Patch Changes

- Updated dependencies
  - @statewalker/webrun-files@0.9.0

## 0.8.1

### Patch Changes

- Republish with a resolved dependency range. 0.8.0 shipped to npm carrying
  `"@statewalker/webrun-files": "workspace:*"` in its published manifest, which no consumer
  outside this repo can resolve — the package was installable by nobody. `pnpm publish`
  rewrites `workspace:` specifiers to the real version; publishing with plain `npm publish`
  does not, which is how it escaped.

## 0.8.0

### Minor Changes

- Split `CompositeFilesApi` into three orthogonal `FilesApi` decorators and
  add glob-based path filtering.

  - **New** `FilteredFilesApi(source, pathFilter)` — visibility decorator that
    hides paths the predicate rejects. Hidden paths behave as if they don't
    exist (silent for `read`/`list`/`stats`/`exists`/`remove`/`move`/`copy`,
    throws for `write`/`mkdir` to avoid silent data loss).
  - **New** `GuardedFilesApi(source, guards)` — access-control decorator
    carrying an ordered list of `FileGuard` policies. Replaces the inline
    `CompositeFilesApi.guard()` builder. `move`/`copy` automatically check
    `read` on source and `write` on target; `stats` checks `list`; `exists`
    checks `read`. Guard `check` predicates run on the **normalized** path.
  - **New** `PathFilter` factories with a uniform varargs signature:
    - `newPathFilter(...prefixes)` — boundary-aware path-prefix matching.
    - `newRegexpPathFilter(...regexps)` — match against arbitrary RegExps.
    - `newGlobPathFilter(...globs)` — match against bash-style globs
      (`extended` + `globstar` mode).
  - **New** `globToRegExp(glob, opts?)` and `GlobToRegExpOptions` — TypeScript
    port of [`fitzgen/glob-to-regexp`](https://github.com/fitzgen/glob-to-regexp)
    (BSD 2-Clause). Credits in source header and README.
  - **Breaking** `CompositeFilesApi.guard(...)` and the inline guards array
    are removed. Build a `FileGuard[]` and wrap with `GuardedFilesApi`
    instead. `CompositeFilesApi` now does mounting/routing only.

  The decorators implement `FilesApi`, so they compose freely; the typical
  stack is `Guarded ∘ Filtered ∘ Composite`.
