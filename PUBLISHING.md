# Publishing

Packages are published to npm with changesets, by a maintainer from a local checkout (the
umbrella's release tool). CI checks every change but publishes nothing.

1. Pull requests carry changesets (`pnpm changeset`), or none.
2. For a release, the planner writes a patch changeset for every public package whose packed
   contents differ from npm's `latest` and that has no changeset yet (a minor bump on a 0.x
   package when one of its dependencies moved to another breaking line).
3. The changesets are applied: versions and `CHANGELOG.md` entries.
4. The bumped packages are published to npm, and the version commit ("chore: version packages")
   is pushed to `main`.

A package that has never been published goes out with its first release, at the version its
changeset gives it.

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
