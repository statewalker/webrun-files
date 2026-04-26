/**
 * Filesystem operations a {@link FileGuard} can intercept.
 *
 * - `read` — reading file content (`FilesApi.read`). Also implicitly checked
 *   on the source side of `move`/`copy`, and on every `exists` call.
 * - `write` — writing file content (`FilesApi.write`). Also implicitly
 *   checked on the target side of `move`/`copy`.
 * - `mkdir` — creating directories (`FilesApi.mkdir`).
 * - `list` — listing directory contents (`FilesApi.list`). Also implicitly
 *   checked on every `stats` call and on each directory entry encountered
 *   while iterating a listing.
 * - `remove` — deleting files or directories (`FilesApi.remove`).
 * - `move` — relocating a file or directory (`FilesApi.move`).
 * - `copy` — copying a file or directory (`FilesApi.copy`).
 *
 * Only the operations listed in a guard's {@link FileGuard.operations} array
 * trigger that guard's predicate.
 */
export type FileOperation = "read" | "write" | "remove" | "move" | "copy" | "list" | "mkdir";

/**
 * Per-operation, per-path access policy applied by `GuardedFilesApi`.
 *
 * Guards are evaluated in the order they are passed to the wrapper, and the
 * first guard whose `check` returns `false` for a matching operation aborts
 * the call by throwing an `Error` carrying its `message`.
 *
 * @example
 * ```ts
 * const guard: FileGuard = {
 *   operations: ["write", "remove", "move"],
 *   check: (path) => !path.startsWith("/.system/"),
 *   message: "system folder is read-only",
 * };
 * ```
 */
export interface FileGuard {
  /**
   * Filesystem operations this guard applies to. The guard's `check` is
   * invoked only for calls whose effective operation set intersects this
   * list (e.g. a guard listing `"read"` also fires on `move`/`copy` source
   * paths and on every `exists` call).
   */
  operations: FileOperation[];

  /**
   * Predicate invoked with the **normalized** path (single leading slash, no
   * trailing slash, collapsed `.` segments and double slashes). Returning
   * `true` allows the operation; returning `false` denies it and the wrapper
   * throws an `Error` with this guard's {@link message}.
   */
  check: (path: string) => boolean;

  /**
   * Optional message used as the prefix of the thrown `Error`. The wrapper
   * appends `: <normalized-path>`. Defaults to `"Access denied"`.
   */
  message?: string;
}
