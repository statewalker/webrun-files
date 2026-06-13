import {
  type HandledEntry,
  InMemoryUpdatesStore,
  type ReadOrderBy,
  type SerializedUpdatesStore,
  type UpdateEntry,
  type UpdatesStore,
} from "@statewalker/shared-dataflow";
import type { FilesApi } from "@statewalker/webrun-files";
import { tryReadJson, writeJsonAtomic } from "./json-io.js";

/**
 * Generic file-backed `UpdatesStore`. Wraps `InMemoryUpdatesStore` and persists
 * the full relation (signal updates + per-cell handled state) to one JSON file.
 * `flush()` snapshots and rewrites atomically.
 */
export class FileBackedUpdatesStore implements UpdatesStore {
  private dirty = false;

  private constructor(
    private readonly files: FilesApi,
    private readonly path: string,
    private readonly inner: InMemoryUpdatesStore,
  ) {}

  static async open(files: FilesApi, path: string): Promise<FileBackedUpdatesStore> {
    const found = await tryReadJson<SerializedUpdatesStore>(files, path);
    return new FileBackedUpdatesStore(files, path, new InMemoryUpdatesStore(found ?? undefined));
  }

  readEntries(opts: {
    signal: string;
    since: number;
    uriPrefix?: string;
    orderBy?: ReadOrderBy;
  }): AsyncIterable<UpdateEntry> {
    return this.inner.readEntries(opts);
  }

  readUpdates(opts: {
    signal: string;
    cell: string;
    uriPrefix?: string;
    orderBy?: ReadOrderBy;
  }): AsyncIterable<UpdateEntry> {
    return this.inner.readUpdates(opts);
  }

  async setUpdate(entry: UpdateEntry): Promise<void> {
    await this.inner.setUpdate(entry);
    this.dirty = true;
  }

  async setUpdates(entries: ReadonlyArray<UpdateEntry>): Promise<void> {
    await this.inner.setUpdates(entries);
    if (entries.length > 0) this.dirty = true;
  }

  async handleUpdate(entry: HandledEntry): Promise<void> {
    await this.inner.handleUpdate(entry);
    this.dirty = true;
  }

  async handleUpdates(entries: ReadonlyArray<HandledEntry>): Promise<void> {
    await this.inner.handleUpdates(entries);
    if (entries.length > 0) this.dirty = true;
  }

  async clearHandled(key: { signal: string; cell: string }): Promise<number> {
    const removed = await this.inner.clearHandled(key);
    if (removed > 0) this.dirty = true;
    return removed;
  }

  async removeUpdate(key: { signal: string; uri: string }): Promise<void> {
    await this.inner.removeUpdate(key);
    this.dirty = true;
  }

  async removeUpdates(keys: ReadonlyArray<{ signal: string; uri: string }>): Promise<void> {
    await this.inner.removeUpdates(keys);
    if (keys.length > 0) this.dirty = true;
  }

  async flush(): Promise<void> {
    if (!this.dirty) return;
    await writeJsonAtomic(this.files, this.path, this.inner.snapshot());
    this.dirty = false;
  }

  /** Snapshot for testing / debugging. */
  snapshot(): SerializedUpdatesStore {
    return this.inner.snapshot();
  }
}
