# Glossary

Terms of the webrun-files packages. Ecosystem-wide terms live in statewalker-root's `GLOSSARY.md`.

## Normal path

A virtual path with one leading slash and no empty, `.`, `..` or trailing segments, which never
names anything above the root. `/` is the root. Every guard, filter and mount decision is made on
the normal path, and every backend acts on it, so both always mean the same file.
_Avoid_: "normalized path" for a path that may still hold `..`.
