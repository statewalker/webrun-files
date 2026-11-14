import type { FilesApi } from "./types.js";

/**
 * Thrown by a `move` done as copy-then-delete when the copy succeeded but the source
 * could not be removed, even on a second attempt. The move is half done: the target
 * already holds the moved content (an existing target was replaced), and the source
 * still exists. A `false` would wrongly say that nothing happened, so this is thrown
 * instead.
 *
 * @example
 * try {
 *   await files.move("/repo/index.lock", "/repo/index");
 * } catch (error) {
 *   if (error instanceof MoveIncompleteError) await files.remove(error.source);
 *   else throw error;
 * }
 */
export class MoveIncompleteError extends Error {
  override readonly name = "MoveIncompleteError";

  constructor(
    /** The path that still exists and could not be removed. */
    readonly source: string,
    /** The path that now holds the moved content. */
    readonly target: string,
    options?: { cause?: unknown },
  ) {
    super(
      `move ${source} -> ${target}: the target was replaced, but the source could not be removed`,
      options,
    );
  }
}

/**
 * The second half of a copy-then-delete `move`: remove `source` after it has been copied
 * to `target`. A failed removal (an error, or `false` while the source still exists) is
 * retried once; should that fail too, {@link MoveIncompleteError} is thrown, carrying the
 * last error as its cause. A source that is already gone counts as removed.
 */
export async function removeMovedSource(
  files: Pick<FilesApi, "remove" | "exists">,
  source: string,
  target: string,
): Promise<void> {
  let cause: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if ((await files.remove(source)) || !(await files.exists(source))) return;
    } catch (error) {
      cause = error;
    }
  }
  throw new MoveIncompleteError(source, target, { cause });
}
