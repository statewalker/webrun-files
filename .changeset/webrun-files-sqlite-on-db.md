---
"@statewalker/webrun-files-sqlite": minor
---

Breaking (0.x minor): `SqliteFilesApi` and `SqlarFilesApi` now take a `Db` from `@statewalker/db-api`
(any `@statewalker/db-sqlite-*` driver) instead of a `SqlDriver`. `SqlDriver`, `SqlStatement`,
`NodeSqlDriver`, `DoSqlDriver` and `D1SqlDriver` are removed; D1 is no longer supported. Multi-statement
steps run through `inTransaction` from `@statewalker/db-sqlite`. The storage format is unchanged:
databases written by 0.10 open as they are. Consumers that stay on the old driver API keep `^0.10.3`.
Migrate `new SqliteFilesApi(new NodeSqlDriver(...))` to `new SqliteFilesApi(await newNodeSqliteDb({ path }))`,
and the Durable Object driver to `newDoSqliteDb(this.ctx.storage)`.
