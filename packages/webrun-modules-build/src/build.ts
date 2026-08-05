import { BuildEngine, NULL_LOGGER } from "@statewalker/webrun-builder";
import type { FilesApi } from "@statewalker/webrun-files";
import { tryReadText, writeText } from "@statewalker/webrun-files";
import {
  type CssTransform,
  defaultGlobals,
  type EndpointResolver,
  type ModuleTarget,
  makeDefaultEndpointResolver,
  newDefaultCssTransform,
  newDefaultTransform,
  newHostRegistry,
  npmRegistrySource,
  type PreprocessContext,
  type Source,
  type Transform,
  type UrlPolicy,
} from "@statewalker/webrun-modules";
import { webrunBuilders } from "./cells.js";
import type { WebrunBuildHost } from "./host.js";
import { makeExtMapPolicy } from "./url-policy.js";

/** Options for a batch project build. */
export interface ProjectBuildOptions {
  /** Raw project sources (`~/…`), scanned by the engine and read by the core. */
  project: FilesApi;
  /** Where emitted artifacts + the `/raw` cache + `/lock.json` are written. */
  cache: FilesApi;
  /** Build target (default `"browser"`). */
  target?: ModuleTarget;
  /** Package sources for external specifiers (default the npm registry source). */
  sources?: Source[];
  /** Override the JS/TS transform (default `newDefaultTransform()`); a test seam. */
  transform?: Transform;
  /** Override the CSS transform (default `newDefaultCssTransform()`); a test seam. */
  css?: CssTransform;
}

/** A prepared batch build over a project. */
export interface ProjectBuild {
  /** Run the pipeline to convergence; returns the emitted entry pointers. */
  build(): Promise<{ served: string[] }>;
}

/**
 * Assemble the batch module builder: the shared `PreprocessContext` (ext-map policy,
 * explicit `HostRegistry`, in-flight dedupe, target-derived globals) + a
 * `BuildEngine` over the project (`files = project`, state co-located under
 * `.project`, emitted artifacts → `cache`) + the classify/preprocess/prune/serve
 * cells. The `host.engine` back-ref is wired post-construction so cells can drain
 * their own input.
 */
/** FNV-1a (32-bit) content hash — a dependency-free digest for the per-id source
 *  sidecar that gates re-emit. Collision risk is negligible for change detection. */
function hashSource(source: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < source.length; i++) {
    h ^= source.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

export function newProjectBuild(opts: ProjectBuildOptions): ProjectBuild {
  const { project, cache } = opts;
  // The scanner re-ingests `~`-prefixed emitted ids; if project and cache were the
  // same FilesApi the emitted tree would feed back as sources. Keep them disjoint.
  if (project === cache) {
    throw new Error("newProjectBuild: `project` and `cache` must be distinct FilesApi instances");
  }
  const target = opts.target ?? "browser";

  const ctx: PreprocessContext = {
    files: project,
    cache,
    target,
    basePath: "/",
    depsPath: "",
    tRoot: `/t/${target}`,
    lock: {},
    sources: opts.sources ?? [npmRegistrySource()],
    transform: opts.transform ?? newDefaultTransform(),
    css: opts.css ?? newDefaultCssTransform(),
    registry: newHostRegistry(),
    globals: defaultGlobals(target),
    inflight: new Map(),
    policy: undefined as unknown as UrlPolicy,
    resolveEndpoint: undefined as unknown as EndpointResolver,
  };
  ctx.policy = makeExtMapPolicy(ctx);
  ctx.resolveEndpoint = makeDefaultEndpointResolver(ctx);

  const served: string[] = [];
  const emitted = new Set<string>();
  // The opt-in incremental gate consulted by `walkFrom` for EVERY closure node
  // (entry + interior + shared): reuse the emitted artifact when the source is
  // byte-identical to the hash sidecar recorded beside it and the artifact still
  // exists; otherwise record the fresh hash and let the transform re-run. This is
  // the sole gate now — the per-entry cell gate is folded in here so all nodes are
  // gated uniformly (a diamond's shared node transforms once, not once per path).
  ctx.skipTransform = async (id, source) => {
    const path = ctx.policy.emittedPath(id);
    const hash = hashSource(source);
    const prev = await tryReadText(cache, `${path}.hash`);
    if (prev === hash && (await cache.exists(path))) return true;
    await writeText(cache, `${path}.hash`, hash);
    emitted.add(id);
    return false;
  };
  const host = { project, cache, ctx, emitted } as WebrunBuildHost;
  const engine = new BuildEngine<WebrunBuildHost>({
    files: project,
    rootPath: "/",
    systemFolder: ".project",
    logger: NULL_LOGGER,
    host,
  });
  host.engine = engine;
  for (const builder of webrunBuilders(served)) engine.registerBuilder(builder);

  return {
    async build() {
      for await (const _ of engine.run()) {
        // Drain progress events to convergence.
      }
      return { served: [...served] };
    },
  };
}
