/**
 * Values kept by key, and waiters for keys that have no value yet: what both ends of a stream
 * use to keep chunks by chunkId and wait for the ones still on their way.
 */
export class Keyed<T> {
  #values = new Map<number, T>();
  #waiters = new Map<number, { resolve: (v: T) => void; reject: (e: unknown) => void }[]>();
  #failure: { error: unknown } | undefined;

  get size(): number {
    return this.#values.size;
  }
  has(key: number): boolean {
    return this.#values.has(key);
  }
  get(key: number): T | undefined {
    return this.#values.get(key);
  }
  keys(): IterableIterator<number> {
    return this.#values.keys();
  }
  /** Keeps `value` under `key` and wakes whoever waits for it. */
  put(key: number, value: T): void {
    this.#values.set(key, value);
    const waiting = this.#waiters.get(key);
    if (!waiting) return;
    this.#waiters.delete(key);
    for (const w of waiting) w.resolve(value);
  }
  delete(key: number): void {
    this.#values.delete(key);
  }
  /** The value of `key`: now if kept, else when it is put (or the whole set fails). */
  wait(key: number): Promise<T> {
    if (this.#values.has(key)) return Promise.resolve(this.#values.get(key) as T);
    if (this.#failure) return Promise.reject(this.#failure.error);
    return new Promise<T>((resolve, reject) => {
      const list = this.#waiters.get(key);
      if (list) list.push({ resolve, reject });
      else this.#waiters.set(key, [{ resolve, reject }]);
    });
  }
  /** Answers every waiter for a key at or above `from` with `value` (the end of a stream). */
  settleFrom(from: number, value: (key: number) => T): void {
    for (const [key, waiting] of [...this.#waiters]) {
      if (key < from) continue;
      this.#waiters.delete(key);
      for (const w of waiting) w.resolve(value(key));
    }
  }
  /** Fails every waiter, now and later. */
  fail(error: unknown): void {
    this.#failure ??= { error };
    for (const waiting of this.#waiters.values()) for (const w of waiting) w.reject(error);
    this.#waiters.clear();
  }
}
