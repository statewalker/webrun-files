import type { DataflowGraph } from "./dataflow-graph.js";
import type { CellId } from "./types.js";
import type { UpdateEntry, UpdatesStore } from "./updates-store.js";

/**
 * Yield all upstream-signal changes that the given cell hasn't caught
 * up to yet. Discovers the cell's upstream signals via
 * `graph.getCellInputs(cellId)`; the cell's watermark is its FIRST
 * declared output (convention: cells whose primary output also serves
 * as their per-URI watermark).
 *
 * Opens one URI-ordered diff stream per upstream signal (via
 * `readUpdatedEntries({orderBy: "uri"})`) and merges them with a
 * streaming k-way URI merge. Memory is O(M) where M is the number of
 * upstream signals — independent of the number of matching URIs.
 *
 * Output order is URI-ascending. When the same URI appears in multiple
 * upstream signals, the entries are emitted adjacently in the order
 * the upstream signals were declared in `graph.getCellInputs(cellId)`,
 * so consumers can collapse per-URI in one forward pass without
 * buffering.
 *
 * A URI updated by N upstream signals appears N times (once per
 * upstream entry). Use `aggregateByUri` if the consumer wants one
 * record per URI.
 *
 * Throws if the cell has inputs but no outputs (no watermark to compare
 * against). Cells with no inputs (probers) yield nothing.
 */
export async function* readUpstreamChanges(
  store: UpdatesStore,
  graph: DataflowGraph,
  cellId: CellId,
  opts?: { uriPrefix?: string },
): AsyncIterable<UpdateEntry> {
  const inputs = graph.getCellInputs(cellId);
  if (inputs.length === 0) return;
  const outputs = graph.getCellOutputs(cellId);
  const watermark = outputs[0];
  if (watermark === undefined) {
    throw new Error(
      `readUpstreamChanges: cell "${cellId}" has inputs but no outputs — cannot derive a watermark signal. Use readUpdatedEntries with an explicit currentSignal.`,
    );
  }
  const uriPrefix = opts?.uriPrefix;

  // One URI-ordered iterator per upstream signal.
  const iters: Array<AsyncIterator<UpdateEntry>> = inputs.map((upstream) => {
    const iterable = store.readUpdatedEntries({
      upstreamSignal: upstream,
      currentSignal: watermark,
      uriPrefix,
      orderBy: "uri",
    });
    return iterable[Symbol.asyncIterator]();
  });

  try {
    // Prime the head of each stream.
    const heads: Array<UpdateEntry | null> = await Promise.all(
      iters.map(async (it) => {
        const r = await it.next();
        return r.done ? null : r.value;
      }),
    );

    // Streaming k-way merge by URI. For URI ties, keep
    // signal-declaration order by preferring the smaller index.
    while (true) {
      let minIdx = -1;
      for (let i = 0; i < heads.length; i++) {
        const h = heads[i];
        if (h === null || h === undefined) continue;
        if (minIdx === -1) {
          minIdx = i;
          continue;
        }
        // biome-ignore lint/style/noNonNullAssertion: minIdx ≥ 0 implies heads[minIdx] is not null
        const cur = heads[minIdx]!;
        if (h.uri < cur.uri) minIdx = i;
      }
      if (minIdx === -1) return;
      // biome-ignore lint/style/noNonNullAssertion: minIdx selected from a non-null head
      const entry = heads[minIdx]!;
      yield entry;
      // biome-ignore lint/style/noNonNullAssertion: iters[minIdx] paired with heads[minIdx]
      const next = await iters[minIdx]!.next();
      heads[minIdx] = next.done ? null : next.value;
    }
  } finally {
    // Best-effort close of any non-exhausted iterators on early break.
    await Promise.all(
      iters.map(async (it) => {
        if (it.return) {
          try {
            await it.return(undefined);
          } catch {
            // Swallow: a throwing iterator close must not mask the
            // primary outcome of the merge.
          }
        }
      }),
    );
  }
}

/**
 * Drain an upstream-changes stream into a Map keyed by URI, where each
 * value is the list of upstream entries that contributed (potentially
 * one per upstream signal). Useful when the cell's per-URI work depends
 * on which upstream signal(s) are fresh, or simply to dedupe URIs when
 * the cell only cares that "something" changed.
 *
 * Insertion order of the returned Map preserves encounter order in the
 * source stream (so within each upstream signal, URIs are
 * stamp-ascending; across upstream signals, the order follows
 * `graph.getCellInputs`).
 */
export async function aggregateByUri(
  source: AsyncIterable<UpdateEntry>,
): Promise<Map<string, UpdateEntry[]>> {
  const out = new Map<string, UpdateEntry[]>();
  for await (const entry of source) {
    const bucket = out.get(entry.uri);
    if (bucket) {
      bucket.push(entry);
    } else {
      out.set(entry.uri, [entry]);
    }
  }
  return out;
}
