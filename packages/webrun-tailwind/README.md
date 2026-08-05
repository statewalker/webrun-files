# @statewalker/webrun-tailwind

A **build-only** Tailwind CSS (v4) transform for the `@statewalker/webrun-modules`
transform registry. Registered on the batch build's context (never the request-time
server), it turns a `tailwind-css` input into a processed `.css` artifact.

## What it does

`newTailwindTransform()` returns a `RegisteredTransform` (`inType: "tailwind-css"`,
`outType: "css"`). On the build context it is registered under the `tailwind-css`
input type; a project `.css` whose content the core's `detectInputType` sniffs as
Tailwind (see below) is routed to it instead of the plain CSS transform.

Generation is **generic, all-classes, and DOM-free**:

1. `__unstable__loadDesignSystem("@import \"tailwindcss\";", …)` loads the design
   system, resolving Tailwind's own bundled CSS (`index/theme/preflight/utilities.css`).
2. `getClassList()` enumerates **every** utility class name (~23k in 4.3.3).
3. `compile(entry).build(classNames)` emits the full utility stylesheet.
4. The result is run through the shared CSS transform (Lightning) for parity.

No JSX/HTML/DOM content scanning happens — the build emits the whole utility set and
the running markup selects what it uses.

## Build-only, by design

The transform is registered from `@statewalker/webrun-modules-build`'s `build.ts`,
**not** from the request-time server. The server's default registry has no
`tailwind-css` entry, so a served Tailwind `.css` falls back (via `coarseBucket`) to
the plain `css` transform — request-time output stays byte-identical (the
`webrun-modules` no-drift gate). This package therefore depends on `webrun-files`
(for its emit writes) and `webrun-modules` (the `RegisteredTransform` contract), and
pins `tailwindcss` to an exact version.

> **Version pin.** `tailwindcss` is pinned directly (`"4.3.3"`) in this package's
> `package.json`, not via the workspace catalog: the pure-JS
> `__unstable__loadDesignSystem` surface is version-sensitive, and an exact pin
> resolves consistently both standalone and inside the aggregating umbrella (whose
> last-wins catalog merge could otherwise resolve a different Tailwind version).

## Incremental caching

`tailwindCacheKey(source)` returns the pinned Tailwind version. The build's
`skipTransform` closure folds it into the per-id content hash for `tailwind-css`
ids (`hash(version + "\n" + source)`), so an unchanged entry reuses the cached
(multi-MB) artifact, while a Tailwind version change re-generates even when the
entry bytes are unchanged. (`TW_CACHE_VER` overrides the version — a test seam.)

## Sniff (how a `.css` becomes `tailwind-css`)

The core's `detectInputType` classifies a `.css` as `tailwind-css` when its content
matches `/^\s*@tailwind\b/m` or `/^\s*@import\s+["']tailwindcss["']/m`. Known edges:

- **Generic-only (customizations not honored).** Generation ignores the project
  source and always compiles `@import "tailwindcss"`, so a project's own `@theme`,
  `@utility`, `@layer`, or sibling `@import "./x.css"` are **not** reflected in the
  generated utilities (they use Tailwind's default theme). Consumers needing custom
  tokens should treat this as a generic baseline. *(Tracked for follow-up.)*
- **Comment/subpath edges.** A line-leading `@tailwind`/`@import "tailwindcss"` inside
  a block comment still matches (build-time only; the server is unaffected via the
  fallback), and a subpath-only entry (`@import "tailwindcss/utilities"`) is not
  detected as Tailwind. Keep the Tailwind directive as an effective top-level rule.

## Note

`preprocessModule` requires `ctx.transforms` to be set (both in-repo drivers set it).
External drivers constructing a `PreprocessContext` directly must attach a registry
(`newDefaultTransformRegistry()`), then `register(newTailwindTransform())` if Tailwind
is wanted.
