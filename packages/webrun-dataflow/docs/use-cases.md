# Use cases

`shared-dataflow` was born from content pipelines, but the shape is general. Anything that can be drawn as "boxes consume/produce named channels, and change on the left should ripple to the right" maps onto it.

The common signature: **stages where each one cares only about "what's new since I last looked," and where correctness depends on the cascade settling into a consistent state**. If you can draw that diagram on a whiteboard, `shared-dataflow` is the runtime under it.

## Example domains

- **Content ingestion / RAG.** Scan files → extract text → chunk → embed → write to vector index. Re-embed only what changed; delete only what disappeared. The canonical example in the [README](../README.md).
- **ETL / data warehouse builds.** Raw tables → staging models → marts → exposures. Like a minimal in-process [dbt](https://www.getdbt.com/), but driven by per-row stamps instead of full table rebuilds. A small change in `orders` only refreshes the downstream models that depend on it, in the right order.
- **CI / build pipelines.** Source change → compile → unit test → integration test → bundle → deploy. The dependency graph between build artifacts is exactly a dataflow graph; the per-cell `updateId` is the cache key. Resumability lets a flaky integration test re-run without re-compiling.
- **Devops / configuration cascades.** Config repo change → render manifests → push to cluster → restart dependent services → run smoke tests. Each step a cell, each artifact a signal. Tombstones handle "service removed from config."
- **Cache / materialized view invalidation.** Source row updated → recompute derived cache → bust HTTP cache → notify subscribers. The "what changed since I last checked?" query is exactly `readEntries({ signal, since })`.
- **Reactive computation engines.** Spreadsheet-style "cell A changed, recompute everything downstream" — but distributed, asynchronous, and persistent. Useful for notebooks, dashboards, or live derivations where a full re-eval is too expensive.
- **IoT / telemetry pipelines.** Sensor reading arrives → aggregate to a window → check thresholds → publish alert. Each device is a URI; the scanner is the ingest gateway; downstream cells maintain rollups and alarm state.
- **ML feature pipelines.** Raw events → feature tables → training set → trained model → evaluation. Retrain only when the upstream features actually moved; never silently skip a stage.
- **Static site generators.** Markdown change → re-render page → rebuild index → invalidate CDN. The same pattern dressed up as a website.
- **Backup / replication / sync.** Source store → checksum → diff → push to mirror. The mirror's last-success tx tells you exactly the slice to ship.
- **Search-index maintenance.** Document changes → tokenize → update inverted index → update facets. Adding a new derived index is one more cell, not a re-architecture.
- **Compliance / audit pipelines.** Event log → classify → redact → archive → notify. Each row processed exactly once, replayable from any point, with the bookmark proving how far you got.
