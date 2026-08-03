import type { FilesApi } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import semver from "semver";
import type { LoadedPackage, ModuleRef, PackageManifest, Source } from "../types.js";
import { ModuleResolveError } from "../types.js";
import { untarTgz } from "./untar.js";

export interface NpmRegistrySourceOptions {
  /** Registry base URL. Defaults to the public npm registry. */
  registryUrl?: string;
  /** Injectable fetch (tests supply a fake; defaults to global `fetch`). */
  fetch?: typeof fetch;
  /** Factory for the in-memory package tree. Defaults to `new MemFilesApi()`. */
  createFiles?: () => FilesApi;
}

/** Registry metadata shape (only the fields we read). */
interface RegistryMeta {
  "dist-tags"?: Record<string, string>;
  versions?: Record<string, PackageManifest & { dist?: { tarball?: string } }>;
}

/**
 * The default acquisition `Source`: resolves a version from npm registry
 * metadata, downloads the tarball, untars it into a fresh `FilesApi`, and returns
 * the package files + manifest. Fully isomorphic (`fetch` + pure-JS untar).
 */
export function npmRegistrySource(opts: NpmRegistrySourceOptions = {}): Source {
  const registry = (opts.registryUrl ?? "https://registry.npmjs.org").replace(/\/+$/, "");
  const doFetch = opts.fetch ?? globalThis.fetch;
  const createFiles = opts.createFiles ?? (() => new MemFilesApi());

  return {
    matches(ref: ModuleRef): boolean {
      return "pkg" in ref;
    },

    async load(ref: ModuleRef): Promise<LoadedPackage> {
      if (!("pkg" in ref)) throw new ModuleResolveError(ref, "not an npm reference");
      const name = ref.pkg;

      const metaRes = await doFetch(`${registry}/${encodeName(name)}`);
      if (!metaRes.ok) throw new ModuleResolveError(ref, `registry ${metaRes.status} for ${name}`);
      const meta = (await metaRes.json()) as RegistryMeta;

      const version = resolveVersion(meta, ref.version, ref);
      const vmeta = meta.versions?.[version];
      const tarball = vmeta?.dist?.tarball;
      if (!tarball) throw new ModuleResolveError(ref, `no tarball for ${name}@${version}`);

      const tgzRes = await doFetch(tarball);
      if (!tgzRes.ok)
        throw new ModuleResolveError(ref, `tarball ${tgzRes.status} for ${name}@${version}`);
      const entries = untarTgz(new Uint8Array(await tgzRes.arrayBuffer()));

      const files = createFiles();
      for (const [path, bytes] of entries) await files.write(`/${path}`, [bytes]);

      return { name, version, files, manifest: { ...vmeta, name, version } };
    },
  };
}

/** Resolve a dist-tag, exact version, or semver range to a concrete version. */
export function resolveVersion(
  meta: RegistryMeta,
  spec: string | undefined,
  ref: ModuleRef,
): string {
  const versions = Object.keys(meta.versions ?? {});
  const tags = meta["dist-tags"] ?? {};
  const s = spec ?? "latest";
  if (tags[s]) return tags[s]; // dist-tag (latest, next, …)
  if (versions.includes(s)) return s; // exact
  const range = semver.validRange(s);
  if (range) {
    const best = semver.maxSatisfying(versions, range);
    if (best) return best;
  }
  throw new ModuleResolveError(ref, `no version satisfies "${s}"`);
}

/** Encode a package name for a registry URL (scoped names need the `/` escaped). */
function encodeName(name: string): string {
  return name.startsWith("@") ? name.replace("/", "%2F") : name;
}
