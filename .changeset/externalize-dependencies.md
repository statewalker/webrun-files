---
"@statewalker/webrun-files-composite": patch
"@statewalker/webrun-files-http": patch
"@statewalker/webrun-files-mem": patch
"@statewalker/webrun-files-node": patch
"@statewalker/webrun-files-rpc": patch
"@statewalker/webrun-files-sqlite": patch
---

Dependencies are no longer bundled into `dist`: `@statewalker/webrun-files`, `@statewalker/webrun-files-mem` and `@statewalker/db-sqlite` are imported, as declared, instead of copied into the build. Consumers no longer get a second copy of the core (whose classes failed `instanceof` checks against the real one), and a compatible update of a dependency no longer republishes these packages.
