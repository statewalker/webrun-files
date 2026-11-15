/**
 * Wrap `target` so that its `createExclusive` exists only while `isAvailable()` says so,
 * checked on every access: both `"createExclusive" in api` and
 * `typeof api.createExclusive` then follow the backend(s) the object delegates to, even
 * as those change (a `mount()` of a backend without the method, say), and a subclass
 * that overrides the method is hidden or shown the same way.
 *
 * Constructors return the result, so the object every caller holds is the proxy; `this`
 * inside methods is the proxy too, and every other property passes straight through.
 */
export function followCreateExclusive<T extends object>(target: T, isAvailable: () => boolean): T {
  return new Proxy(target, {
    has(object, key) {
      if (key === "createExclusive" && !isAvailable()) return false;
      return Reflect.has(object, key);
    },
    get(object, key, receiver) {
      if (key === "createExclusive" && !isAvailable()) return undefined;
      return Reflect.get(object, key, receiver);
    },
  });
}
