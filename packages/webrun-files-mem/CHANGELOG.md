# @statewalker/webrun-files-mem

## 0.7.1

### Patch Changes

- Fix duplicate directory entries in non-recursive list()

  Directories with children were yielded twice in `list()` — once as direct child entries and again via the subdirectory tracking logic for nested entries. Added the direct child entries to the `seen` set to prevent duplicates.

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
