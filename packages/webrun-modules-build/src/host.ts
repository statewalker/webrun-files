import type { BuildEngine } from "@statewalker/webrun-builder";
import type { FilesApi } from "@statewalker/webrun-files";
import type { PreprocessContext } from "@statewalker/webrun-modules";

/**
 * The build host handed to every BuildEngine cell: the two FilesApis (raw project
 * sources vs. the emitted-artifact cache), the shared `PreprocessContext` the cells
 * drive the module core through, and a back-reference to the engine (wired
 * post-construction) so a cell can drain its own input via `host.engine.readUpdates`.
 */
export interface WebrunBuildHost {
  project: FilesApi;
  cache: FilesApi;
  ctx: PreprocessContext;
  engine: BuildEngine<WebrunBuildHost>;
}
