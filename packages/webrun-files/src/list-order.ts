import type { FileInfo, ListOptions } from "./types.js";

/**
 * The order every `FilesApi.list()` yields: paths compared by Unicode code
 * point, which is the same as comparing their UTF-8 bytes — the order of
 * SQLite's `BINARY` collation and of S3 key listings.
 *
 * Not JavaScript's `<`, which compares UTF-16 code units and so puts a
 * character above U+FFFF (a surrogate pair) before U+E000–U+FFFF.
 */
export function comparePaths(a: string, b: string): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const x = a.charCodeAt(i);
    const y = b.charCodeAt(i);
    if (x === y) continue;
    const xSurrogate = x >= 0xd800 && x <= 0xdfff;
    const ySurrogate = y >= 0xd800 && y <= 0xdfff;
    // A surrogate stands for a code point above U+FFFF, so it outranks any
    // other unit; two surrogates compare in code point order as they are.
    if (xSurrogate !== ySurrogate) return xSurrogate ? 1 : -1;
    return x - y;
  }
  return a.length - b.length;
}

/** Whether a listing resuming after `after` can still yield anything under `dir`. */
function subtreeMayFollow(dir: string, after: string | undefined): boolean {
  // Every descendant of `dir` lies between `dir + "/"` and `dir + "0"`.
  return after === undefined || comparePaths(after, `${dir === "/" ? "" : dir}0`) < 0;
}

/**
 * List a tree in path order for backends that read one directory at a time.
 * `children(dir)` returns a directory's direct entries in any order.
 *
 * Pending entries sit in a min-heap keyed by path. A directory's children all
 * sort after it, so pushing them when the directory is taken never yields out
 * of order. Children are read only when the listing reaches their directory,
 * and never for a directory whose whole subtree lies at or before `after`.
 */
export async function* listInPathOrder(
  dir: string,
  children: (dir: string) => Promise<Iterable<FileInfo>> | Iterable<FileInfo>,
  options: ListOptions = {},
): AsyncGenerator<FileInfo> {
  const { recursive = false, after } = options;
  const heap = new PathHeap<FileInfo>((entry) => entry.path);
  if (!subtreeMayFollow(dir, after)) return;
  for (const entry of await children(dir)) heap.push(entry);

  for (let entry = heap.pop(); entry; entry = heap.pop()) {
    if (after === undefined || comparePaths(entry.path, after) > 0) yield entry;
    if (recursive && entry.kind === "directory" && subtreeMayFollow(entry.path, after)) {
      for (const child of await children(entry.path)) heap.push(child);
    }
  }
}

/**
 * Merge streams that are each already in path order into one. When several
 * streams yield the same path, the entry from the earliest stream wins and
 * the others are dropped. At most one entry per stream is pulled ahead, and
 * every stream is closed when the consumer stops.
 */
export async function* mergeInPathOrder(
  streams: AsyncIterable<FileInfo>[],
): AsyncGenerator<FileInfo> {
  const iterators = streams.map((stream) => stream[Symbol.asyncIterator]());
  const heads: (FileInfo | undefined)[] = [];
  const done: boolean[] = [];
  const pull = async (i: number) => {
    const next = await iterators[i].next();
    done[i] = next.done === true;
    heads[i] = next.done ? undefined : next.value;
  };
  try {
    await Promise.all(iterators.map((_, i) => pull(i)));
    for (;;) {
      let min = -1;
      for (let i = 0; i < heads.length; i++) {
        const head = heads[i];
        if (!head) continue;
        const current = min === -1 ? undefined : heads[min];
        if (!current || comparePaths(head.path, current.path) < 0) min = i;
      }
      if (min === -1) return;
      const entry = heads[min] as FileInfo;
      // Drop the same path from later streams before yielding.
      for (let i = min + 1; i < heads.length; i++) {
        while (heads[i] && heads[i]?.path === entry.path) await pull(i);
      }
      heads[min] = undefined;
      yield entry;
      await pull(min);
    }
  } finally {
    await Promise.all(
      iterators.map(async (iterator, i) => {
        if (!done[i]) await iterator.return?.();
      }),
    );
  }
}

/** A binary min-heap ordered by {@link comparePaths}. */
class PathHeap<T> {
  readonly #items: T[] = [];
  readonly #key: (item: T) => string;

  constructor(key: (item: T) => string) {
    this.#key = key;
  }

  push(item: T): void {
    const items = this.#items;
    items.push(item);
    for (let i = items.length - 1; i > 0; ) {
      const parent = (i - 1) >> 1;
      if (this.#less(items[parent], items[i])) break;
      [items[parent], items[i]] = [items[i], items[parent]];
      i = parent;
    }
  }

  pop(): T | undefined {
    const items = this.#items;
    const top = items[0];
    const last = items.pop();
    if (items.length > 0 && last !== undefined) {
      items[0] = last;
      for (let i = 0; ; ) {
        const left = 2 * i + 1;
        const right = left + 1;
        let smallest = i;
        if (left < items.length && this.#less(items[left], items[smallest])) smallest = left;
        if (right < items.length && this.#less(items[right], items[smallest])) smallest = right;
        if (smallest === i) break;
        [items[smallest], items[i]] = [items[i], items[smallest]];
        i = smallest;
      }
    }
    return top;
  }

  #less(a: T, b: T): boolean {
    return comparePaths(this.#key(a), this.#key(b)) < 0;
  }
}
