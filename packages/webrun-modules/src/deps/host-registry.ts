import type { HostRegistry } from "../types.js";

/** The well-known globalThis key the served host-proxies read from. */
export const HOST_REGISTRY_KEY = "__webrunHostRegistry";

class MapHostRegistry implements HostRegistry {
  #m: Map<string, unknown>;
  constructor(init?: Record<string, unknown>) {
    this.#m = new Map(init ? Object.entries(init) : []);
  }
  set(name: string, instance: unknown): void {
    this.#m.set(name, instance);
  }
  get(name: string): unknown {
    return this.#m.get(name);
  }
  has(name: string): boolean {
    return this.#m.has(name);
  }
}

export function newHostRegistry(init?: Record<string, unknown>): HostRegistry {
  return new MapHostRegistry(init);
}

/** The single realm-global registry. Served host-proxies read `globalThis[KEY]`,
 *  so this must be the same object the page/Node process populates. */
export function globalHostRegistry(): HostRegistry {
  const g = globalThis as Record<string, unknown>;
  if (!g[HOST_REGISTRY_KEY]) {
    g[HOST_REGISTRY_KEY] = newHostRegistry();
  }
  return g[HOST_REGISTRY_KEY] as HostRegistry;
}
