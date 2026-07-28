import type { FilesApi } from "@statewalker/webrun-files";
import { GuardedFilesApi } from "./guarded-files-api.js";

/**
 * Wraps a `FilesApi` in a read-only view: every mutating operation
 * (`write`, `mkdir`, `remove`, `move`, `copy`) throws, while reads
 * (`read`, `list`, `stats`, `exists`) pass straight through to `api`.
 *
 * Implemented as a {@link GuardedFilesApi} with a single deny-all guard on
 * the mutating operations, so `move`/`copy` are blocked on either endpoint.
 *
 * @param api The underlying `FilesApi` to expose read-only.
 * @returns A `FilesApi` that never mutates `api`.
 *
 * @example
 * ```ts
 * const ro = readOnly(sourceFiles);
 * await ro.read("/a.txt");          // ok
 * await ro.write("/a.txt", data);   // throws "read-only: /a.txt"
 * ```
 */
export function readOnly(api: FilesApi): FilesApi {
  return new GuardedFilesApi(api, [
    {
      operations: ["write", "mkdir", "remove", "move", "copy"],
      check: () => false,
      message: "read-only",
    },
  ]);
}
