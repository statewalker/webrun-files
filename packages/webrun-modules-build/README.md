# @statewalker/webrun-modules-build

Batch module builder. Drives the shared `@statewalker/webrun-modules` preprocess
core through `@statewalker/webrun-builder`'s `BuildEngine` with an **ext-map** URL
policy (every emitted module is a static `.js`), emitting a static `.js` tree to a
cache `FilesApi`.

## Pipeline

```
scanner → sources → [Classify] → module/css/json → [Preprocess] → served → [Serve]
                                                        └ [Prune] on sources-removed
```

- **Classify** routes each scanned source to a `module` / `css` / `json` signal.
- **Preprocess** walks the entry's transitive closure via `walkFrom`, emitting the
  entry + project deps as `.js`, plus the `~deps` proxy bodies and resolved npm
  endpoints as side-effects into `cache`, then wraps JSON/CSS ids into their static
  `.js` forms.
- **Prune** removes a deleted source's emitted artifact + sidecars.
- **Serve** collects the emitted entry pointers.

## Incremental gating

`newProjectBuild` installs an opt-in `ctx.skipTransform` hook consulted by `walkFrom`
for **every** closure node (entry, interior, and shared). It reuses the emitted
artifact when the source is byte-identical to a per-id content-hash sidecar and the
artifact still exists — so editing a root re-transforms only the root, and a diamond
transforms its shared node once, not once per path. `project` and `cache` must be
distinct `FilesApi` instances (asserted).

## CSS emission

- **CSS reached from JS emits a `.js` injector.** An `import "./styles.css"` from JS
  becomes one `cssModuleWrapper` `.js` that injects a `<style>`.
- **F2 — `@import`-chained `.css` is emitted as a real file.** An `@import "./other.css"`
  keeps its `.css` specifier; the chained stylesheet is written as a live `.css` at its
  `urlPath` (alongside its `.js` form) so the injected `@import` resolves.
- **F3 — `url()` asset references are copied.** `url("./logo.png")` targets a
  non-code asset id, copied verbatim to its (unchanged) ext-map path.
