# @statewalker/webrun-files-composite

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
