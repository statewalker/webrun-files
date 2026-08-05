import type { RegisteredBuilder } from "@statewalker/webrun-builder";
import { readText, tryReadText, writeText } from "@statewalker/webrun-files";
import { walkFrom } from "@statewalker/webrun-modules";
import { emitBuildForms } from "./emit-forms.js";
import type { WebrunBuildHost } from "./host.js";

/** FNV-1a (32-bit) content hash — a dependency-free digest for the source-hash
 *  sidecar that gates re-emit. Collision risk is negligible for change detection. */
function hashSource(source: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < source.length; i++) {
    h ^= source.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

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
          await host.engine.yieldControl();
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
            const emitted = host.ctx.policy.emittedPath(id);
            const hashPath = `${emitted}.hash`;
            // Content-hash gate: reuse the emitted artifact when the source is
            // byte-identical to what produced it (a content-identical mtime touch
            // re-triggers the scanner but must not re-transform).
            const source = await readText(host.project, `/${u.uri}`);
            const hash = hashSource(source);
            const prev = await tryReadText(host.cache, hashPath);
            if (prev !== hash || !(await host.cache.exists(emitted))) {
              // Walk the entry's transitive closure: the entry + project deps → `.js`,
              // and the `~deps` proxy bodies + resolved npm endpoints as side-effects
              // into `host.cache`. All emitted via the ext-map policy; JSON/CSS deps
              // are then rewritten into their static `serveJsonModule`/`cssModuleWrapper`
              // `.js` forms.
              const ids = await walkFrom(id, host.ctx);
              await emitBuildForms(ids, host.ctx);
              await writeText(host.cache, hashPath, hash);
            }
            yield { signal: SERVED_SIGNAL, uri: emitted, stamp: u.stamp };
            await u.handled();
            await host.engine.yieldControl();
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
          await host.engine.yieldControl();
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
          await host.engine.yieldControl();
        }
        return true;
      },
    },
  ];
}
