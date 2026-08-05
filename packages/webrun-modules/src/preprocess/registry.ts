import type { InputType, RegisteredTransform, TransformRegistry } from "./context.js";
import { cssTransform, jsTransform } from "./module.js";

/** A Map-backed `TransformRegistry`. `get` throws on a missing key; `register`
 *  is last-wins (a later registration for the same `inType` replaces the prior). */
export function newTransformRegistry(): TransformRegistry {
  const map = new Map<InputType, RegisteredTransform>();
  return {
    has: (t) => map.has(t),
    get(t) {
      const entry = map.get(t);
      if (!entry) throw new Error(`no transform registered for input type: ${t}`);
      return entry;
    },
    register(t) {
      map.set(t.inType, t);
    },
  };
}

/** The default registry: `module` → the JS/ESM transform, `css` → the Lightning
 *  CSS transform. `tailwind-css` is intentionally NOT registered, so it falls
 *  back through `coarseBucket` to the `css` entry (behaviour-preserving). */
export function newDefaultTransformRegistry(): TransformRegistry {
  const registry = newTransformRegistry();
  registry.register({ inType: "module", outType: "js", run: jsTransform });
  registry.register({ inType: "css", outType: "css", run: cssTransform });
  return registry;
}
