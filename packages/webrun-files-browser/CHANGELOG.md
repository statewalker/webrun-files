# @statewalker/webrun-files-browser

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

## 0.7.0

### Minor Changes

- Refactored FilesApi interface for better cross-platform compatibility

  - Simplified FilesApi interface: removed generic types and made all methods mandatory
  - Added new dedicated packages: @statewalker/webrun-files-mem and @statewalker/webrun-files-node
  - Core package (@statewalker/webrun-files) now focuses on types and utilities only
  - Added streaming multipart upload for S3 (files >= 5MB)
  - Updated test suite with new factory pattern for FilesApi testing
  - Improved documentation across all packages

### Patch Changes

- Updated dependencies
  - @statewalker/webrun-files@0.7.0

## 0.5.0

### Minor Changes

- Add random access read method to file handles

### Patch Changes

- Updated dependencies
  - @statewalker/webrun-files@0.5.0
