import { BuildEngine, NULL_LOGGER } from "@statewalker/webrun-builder";
import type { FilesApi } from "@statewalker/webrun-files";
import {
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
export function newProjectBuild(opts: ProjectBuildOptions): ProjectBuild {
  const { project, cache } = opts;
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
    transform: newDefaultTransform(),
    css: newDefaultCssTransform(),
    registry: newHostRegistry(),
    globals: defaultGlobals(target),
    inflight: new Map(),
    policy: undefined as unknown as UrlPolicy,
    resolveEndpoint: undefined as unknown as EndpointResolver,
  };
  ctx.policy = makeExtMapPolicy(ctx);
  ctx.resolveEndpoint = makeDefaultEndpointResolver(ctx);

  const served: string[] = [];
  const host = { project, cache, ctx } as WebrunBuildHost;
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
