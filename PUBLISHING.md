# Publishing Guide

This monorepo uses [Changesets](https://github.com/changesets/changesets) for version management and publishing.

## Quick Reference

```bash
pnpm changeset          # Create a changeset
pnpm version-packages   # Bump versions from changesets
pnpm release-packages   # Publish to npm
```

## Step-by-Step Publishing Flow

### 1. Create a Changeset

After making code changes, create a changeset to describe what changed:

```bash
pnpm changeset
```

This will prompt you to:
- Select which packages have changed
- Choose the semver bump type (`patch`, `minor`, or `major`)
- Write a summary of the changes

A new markdown file will be created in `.changeset/` directory.

### 2. Version the Packages

When ready to release, consume all pending changesets and update package versions:

```bash
pnpm version-packages
```

This command:
- Reads all changeset files in `.changeset/`
- Updates `package.json` versions for affected packages
- Generates/updates `CHANGELOG.md` files
- Deletes the consumed changeset files

### 3. Commit Version Changes

```bash
git add .
git commit -m "chore: version packages"
```

### 4. Publish to npm

```bash
pnpm release-packages
```

This publishes all packages with updated versions to npm.

### 5. Push to Git

```bash
git push --follow-tags
```

## Alternative: Manual Publish

For more control, you can use the `publish-all` script which builds and publishes with public access:

```bash
pnpm publish-all
```

## Configuration

Changeset configuration is in `.changeset/config.json`:

| Option | Value | Description |
|--------|-------|-------------|
| `access` | `restricted` | npm access level (use `publish-all` for public) |
| `baseBranch` | `main` | Branch to compare against |
| `commit` | `false` | Don't auto-commit version changes |

## Semver Guidelines

- **patch**: Bug fixes, documentation updates
- **minor**: New features, non-breaking changes
- **major**: Breaking changes to the API
