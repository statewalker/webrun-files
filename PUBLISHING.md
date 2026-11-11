# Publishing

Packages are published to npm from CI with changesets. Nobody runs `changeset version` or
`changeset publish` by hand.

1. CI runs on every push to `main`.
2. After CI passes, a job writes a changeset for every public package whose packed files or
   published manifest (dependency ranges, `exports`) differ from npm's `latest`: a patch, or a minor
   on a 0.x package when one of its dependencies moves to another breaking line. Dependents of a
   package that crosses a breaking line get the same minor. A package with a changeset you wrote
   keeps yours.
3. The job opens (or updates) a "chore: version packages" pull request with the version bumps and
   `CHANGELOG.md` entries.
4. Merging that pull request packs every public package whose version is not on npm yet. Nothing is
   published until a maintainer approves the `publish` job on the `npm` GitHub environment; it then
   publishes the tarballs with provenance and creates a GitHub release per package.

The checks do not run on the version pull request itself (GitHub Actions opened it); they run
again on `main` after the merge, before anything is packed.

## No npm token: trusted publishing

GitHub holds no npm token. The `publish` job authenticates with npm trusted publishing (OIDC). Each
package's trusted publisher names `statewalker/webrun-files`, `ci.yml` and the `npm` environment,
so a run that skips the approval cannot publish. Only `publish` may request an identity token, and
it never checks out, installs the workspace's dependencies or builds; the only thing it installs is
a pinned npm (trusted publishing needs 11.5.1 or later).

A trusted publisher can only be added to a package that already exists, so a **new package's first
version is published by hand** with the maintainer's 2FA, logged in with `npm login` (npm 11 or
later):

1. Build it: `pnpm --filter @statewalker/<name>... run build`.
2. `pnpm pack` in the package, then `npm publish <tarball> --access public`. `pnpm pack` turns
   `workspace:` and `catalog:` ranges into versions; publishing the folder directly would not.
3. Add the trusted publisher:

```bash
npm trust github @statewalker/<name> --repo statewalker/webrun-files --file ci.yml --env npm --allow-publish
```

If the package does not exist on npm yet, or has no trusted publisher, `publish` fails with
`npm error 404 Not Found - PUT https://registry.npmjs.org/@statewalker%2f<name> - Not found`: npm
reports a missing package or trusted publisher as "not found", not as a permission error. Publish the
first version and add the publisher, then re-run the failed `publish` job (it needs the approval
again); it reuses the packed tarballs and skips versions already on npm.

## Choosing the bump or the changelog text yourself

Add a changeset in your pull request:

```bash
pnpm changeset
```

Pick the packages, the bump and write the summary.

## On a 0.x line, a breaking change is a minor bump

Every package here is below 1.0. npm's caret range treats `0.x` specially: `^0.10.3` allows
`0.10.4` but not `0.11.0`. On a `0.x` line the minor position is what carries a break, and it is the
position consumers' ranges protect them against. A `major` bump would declare 1.0, a stability
commitment none of these packages makes yet. So:

- **`0.x` breaking change: `minor`** (`0.10.3` -> `0.11.0`), with the break stated in the changeset
  summary and the commit marked `!` (for example `feat(webrun-files)!:`).
- `major` applies once a package reaches `1.0.0`.

## Why a break in `webrun-files` bumps every backend by minor

Every backend depends on `@statewalker/webrun-files` through `workspace:^`.
`.changeset/config.json` keeps `updateInternalDependencies` at the changesets default `patch`: when
a package is released, changesets moves its dependents' ranges to the new version and gives each of
them a patch release. On its own, that would let a breaking `webrun-files` release reach every
backend as a patch, which a consumer on `^0.x.y` installs automatically, carrying an incompatible
`FilesApi`.

The changeset job prevents this. When a package crosses a breaking line (a `minor` on 0.x, whether
the job wrote that changeset or you did), every package that depends on it through `workspace:`, as
a runtime or peer dependency, gets the same breaking bump. The break stays outside its consumers'
ranges, so they have to opt in. If you write the changeset for a break yourself, you do not need to
bump the dependents: the job adds their `minor` changesets (`.changeset/auto-*.md`) to the version
pull request.

## Configuration

`.changeset/config.json` holds the changesets settings. Each public package sets
`publishConfig.access` to `public`; `@statewalker/webrun-files-tests` is private and never
published.
