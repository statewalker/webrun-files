# Publishing

Packages are published to npm from CI with changesets. Nobody runs `changeset version` or
`changeset publish` by hand.

1. CI runs on every push to `main`.
2. After CI passes, a job writes a changeset for every public package whose packed files or
   published manifest (dependency ranges, `exports`) differ from npm's `latest`: a patch, or a minor
   on a 0.x package when one of its dependencies moves to another breaking line. A package with a
   changeset you wrote keeps yours.
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

Pick the packages, the bump (`patch`, `minor`, `major`) and write the summary.

## Configuration

`.changeset/config.json` holds the changesets settings. Each public package sets
`publishConfig.access` to `public`; `@statewalker/webrun-files-tests` is private and never
published.
