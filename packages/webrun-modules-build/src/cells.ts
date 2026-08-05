import type { RegisteredBuilder } from "@statewalker/webrun-builder";
import { walkFrom } from "@statewalker/webrun-modules";
import { emitBuildForms, isAsset } from "./emit-forms.js";
import type { WebrunBuildHost } from "./host.js";

export const CLASSIFY_CELL = "Classify";
export const PREPROCESS_CELL = "Preprocess";
export const PRUNE_CELL = "Prune";
export const SERVE_CELL = "Serve";

/** Typed content signals the Classify cell fans `sources` out to. */
const MODULE_SIGNAL = "module";
const CSS_SIGNAL = "css";
const JSON_SIGNAL = "json";
const SERVED_SIGNAL = "served";

/** JS/TS module files — the only ones the transform touches. */
const MODULE_EXT = /\.(?:m|c)?[jt]sx?$/;

/** Map a scanned project-relative source uri (`src/main.tsx`) to its core id
 *  (`~/src/main.tsx`) — the `~/` id-space the preprocess core reads project files in. */
function toProjectId(uri: string): string {
  return `~/${uri}`;
}

/**
 * The batch build's cell set, driving the shared `webrun-modules` preprocess core
 * through the generic `BuildEngine`. A linear pipeline:
 *   scanner → sources → [Classify] → module/css/json → [Preprocess] → served → [Serve]
 * with [Prune] on the `sources-removed` tombstone. No cell outputs its own input
 * signal (that would cycle the frontier scheduler); npm + `~deps` artifacts are walk
 * side-effects into `host.cache`, never scanned or re-injected.
 *
 * `served` collects the emitted entry pointers (the Serve sink), read back by the
 * caller once `run()` converges.
 */
export function webrunBuilders(served: string[]): RegisteredBuilder<WebrunBuildHost>[] {
  return [
    {
      id: CLASSIFY_CELL,
      inputs: ["sources"],
      outputs: [MODULE_SIGNAL, CSS_SIGNAL, JSON_SIGNAL],
      async *handler(host) {
        for await (const u of host.engine.readUpdates({ signal: "sources", cell: CLASSIFY_CELL })) {
          const signal = MODULE_EXT.test(u.uri)
            ? MODULE_SIGNAL
            : u.uri.endsWith(".css")
              ? CSS_SIGNAL
              : u.uri.endsWith(".json")
                ? JSON_SIGNAL
                : undefined;
          if (signal) yield { signal, uri: u.uri, stamp: u.stamp };
          await u.handled();
          if (!(await host.engine.yieldControl())) return false;
        }
        return true;
      },
    },
    {
      id: PREPROCESS_CELL,
      inputs: [MODULE_SIGNAL, CSS_SIGNAL, JSON_SIGNAL],
      outputs: [SERVED_SIGNAL],
      async *handler(host) {
        for (const signal of [MODULE_SIGNAL, CSS_SIGNAL, JSON_SIGNAL]) {
          for await (const u of host.engine.readUpdates({ signal, cell: PREPROCESS_CELL })) {
            const id = toProjectId(u.uri);
            // Walk the entry's transitive closure: the entry + project deps → `.js`,
            // and the `~deps` proxy bodies + resolved npm endpoints as side-effects
            // into `host.cache`. The per-id content-hash gate (`ctx.skipTransform`)
            // re-transforms only changed nodes and records which ids it (re)emitted.
            host.emitted.clear();
            const ids = await walkFrom(id, host.ctx);
            // Static emit forms: JSON is idempotent (re-derived from raw source), so
            // always (re)form it; a CSS injector is re-wrapped ONLY for a freshly
            // emitted node — the raw stylesheet `walkFrom` overwrites `emitted` with
            // is only present when the transform actually ran (else it's already the
            // wrapped `.js`, which must not be double-wrapped).
            await emitBuildForms(
              ids.filter((x) => x.endsWith(".json") || isAsset(x) || host.emitted.has(x)),
              host.ctx,
            );
            yield { signal: SERVED_SIGNAL, uri: host.ctx.policy.emittedPath(id), stamp: u.stamp };
            await u.handled();
            if (!(await host.engine.yieldControl())) return false;
          }
        }
        return true;
      },
    },
    {
      id: PRUNE_CELL,
      inputs: ["sources-removed"],
      outputs: [],
      // biome-ignore lint/correctness/useYield: a sink cell emits no updates.
      async *handler(host) {
        for await (const u of host.engine.readUpdates({
          signal: "sources-removed",
          cell: PRUNE_CELL,
        })) {
          const emitted = host.ctx.policy.emittedPath(toProjectId(u.uri));
          // Prune the emitted artifact and its sidecars (source-hash gate + the CSS
          // class-map) so a removed source leaves no orphan behind.
          for (const path of [emitted, `${emitted}.hash`, `${emitted}.exports.json`]) {
            if (await host.cache.exists(path)) await host.cache.remove(path);
          }
          await u.handled();
          if (!(await host.engine.yieldControl())) return false;
        }
        return true;
      },
    },
    {
      id: SERVE_CELL,
      inputs: [SERVED_SIGNAL],
      outputs: [],
      // biome-ignore lint/correctness/useYield: a sink cell emits no updates.
      async *handler(host) {
        for await (const u of host.engine.readUpdates({
          signal: SERVED_SIGNAL,
          cell: SERVE_CELL,
        })) {
          served.push(u.uri);
          await u.handled();
          if (!(await host.engine.yieldControl())) return false;
        }
        return true;
      },
    },
  ];
}
