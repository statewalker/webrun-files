# Publishing

Packages are published to npm from CI with changesets. Nobody runs `changeset version` or
`changeset publish` by hand.

1. CI runs on every push to `main`.
2. After CI passes, a job compares each public package's packed contents with the version on npm.
   For every package that differs it writes a changeset: a patch bump, or a minor bump on a 0.x
   package when one of its dependencies crosses a breaking line.
3. The job opens (or updates) a "chore: version packages" pull request with the version bumps and
   `CHANGELOG.md` entries.
4. Merging that pull request publishes the bumped packages to npm with provenance.

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
