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
 * Opens one diff stream per upstream signal (via
 * `readUpdatedEntries`), merges them, and yields the combined result
 * sorted by URI (lexicographic ascending). When the same URI appears
 * in multiple upstream signals, the entries are emitted adjacently in
 * the order the upstream signals were declared in
 * `graph.getCellInputs(cellId)` — so consumers can collapse
 * per-URI in one pass.
 *
 * A URI updated by N upstream signals appears N times (once per
 * upstream entry). Use `aggregateByUri` if the consumer wants
 * one record per URI.
 *
 * Throws if the cell has inputs but no outputs (no watermark to compare
 * against). Cells with no inputs (probers) yield nothing.
 *
 * Implementation note: URI-sorted output requires buffering all
 * matching entries before yielding, since the per-signal streams are
 * stamp-ordered, not URI-ordered. Memory = O(matching URIs × upstream
 * signals).
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

  // Drain every upstream's per-URI diff into one buffer so we can sort
  // the combined stream by URI. (Within a single signal `readUpdatedEntries`
  // yields by stamp; merging by URI across signals isn't possible without
  // buffering.)
  const signalOrder = new Map<string, number>();
  for (let i = 0; i < inputs.length; i++) {
    signalOrder.set(inputs[i] as string, i);
  }
  const buffered: UpdateEntry[] = [];
  for (const upstream of inputs) {
    for await (const entry of store.readUpdatedEntries({
      upstreamSignal: upstream,
      currentSignal: watermark,
      uriPrefix,
    })) {
      buffered.push(entry);
    }
  }

  buffered.sort((a, b) => {
    if (a.uri !== b.uri) return a.uri < b.uri ? -1 : 1;
    const sa = signalOrder.get(a.signal) ?? 0;
    const sb = signalOrder.get(b.signal) ?? 0;
    return sa - sb;
  });

  for (const entry of buffered) yield entry;
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
