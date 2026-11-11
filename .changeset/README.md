# Changesets

A changeset records a package release: which packages, which bump, and the changelog text.

- `pnpm changeset` writes one; commit it with the change it describes. It decides the bump and the
  changelog text of the next release.
- Without one, the release planner writes a patch changeset for every package whose published
  contents changed since npm's `latest` (a minor, on 0.x, when a dependency moved to another
  breaking line).
- On every push to `main`, CI applies the changesets in a "chore: version packages" pull request
  (versions, `CHANGELOG.md`); merging it publishes the bumped packages after a maintainer approves
  the `publish` job. See [PUBLISHING.md](../PUBLISHING.md).
