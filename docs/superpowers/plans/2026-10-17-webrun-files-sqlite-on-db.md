# webrun-files-sqlite 0.11 on `Db` + `inTransaction` — Implementation Plan (P4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `SqlarFilesApi` and `SqliteFilesApi` take a `Db` from `@statewalker/db-api`, and multi-statement steps run through `inTransaction` from `@statewalker/db-sqlite`. The package's own `SqlDriver` port is deleted, together with its node:sqlite, Durable Object and D1 drivers.

**Architecture:**
- Every single statement becomes `db.query(sql, params)`.
- Every former `sql.transaction(statements)` becomes `#transaction(statements)`, which is `inTransaction(db, (tx) => runStatements(tx, statements))`.
- `runStatements` is a private module. It keeps the old batch contract: per statement, the rows it changed, read with `SELECT changes()` on the transaction's Db.
- The storage format (tables, columns, block layout, SQLAR rows) does not change.
- Tests run the existing FilesApi suites and the atomicity suite over `newNodeSqliteDb()` and over `newDoSqliteDb(newFakeDoStorage())`. They inspect tables through the same `Db`.

**Tech Stack:**
- TypeScript, vitest 5, biome 2, pnpm 10.16.1, changesets.
- `@statewalker/db-api`, `@statewalker/db-sqlite`, `@statewalker/db-sqlite-node` (node:sqlite) and `@statewalker/db-sqlite-do`, all from plan P1.

**Spec:** `~/workspace-statewalker/notes/2026/2026-10/2026-10-17/grill-sqlite-db-indexing.md`, decisions D2, D4, D14, D15 (P4) and D16.

## Global Constraints

- **`db-api` is unchanged.** `Db = { query<T>(sql, params?): Promise<T[]>; exec(sql): Promise<void>; flush?(); close() }`.
- **Transactions come only from `inTransaction<T>(db: Db, cb: (tx: Db) => Promise<T>): Promise<T>`** (`@statewalker/db-sqlite`). It dispatches through `db[Symbol.for("@statewalker/db-sqlite:transaction")]`. A Db without that hook throws, and nested `inTransaction` throws.
- **Callback rules:**
  - The callback does no external I/O.
  - It must be idempotent: a Durable Object may retry it.
  - `runStatements` only runs SQL, so it qualifies.
- **DML goes through `query(sql, params)`.**
  - Change counts come from `SELECT changes()` inside the transaction.
  - Drivers return BLOBs as `Uint8Array`.
- **D1 is dropped.** The way back is a later `db-sqlite-d1` package that implements plain `Db`. Nothing D1-specific stays in this package.
- **Version 0.10.3 → 0.11.0.** Pre-1.0, a minor bump is the breaking bump. Every consumer pinned at `^0.10.x` stays on 0.10.
- **Repository and package rules:** webrun-files keeps its `catalog:` convention for cross-repo dependencies; file names are kebab-case; tests test public seams with real implementations, no mocks of the code under test.
- **Release:** together with statewalker-db and statewalker-search through `SW_REPOS=… node tools/sw.mjs cascade statewalker-db`. It is never published by hand.

## Review Focus

1. **A `Db` that wraps a db-sqlite Db loses the transaction hook**, for example a logging proxy, which is the D2 failure mode.
   - Expected: the first write rejects with db-sqlite's error, and no path shows up. It must never succeed non-atomically.
   - The test is in Task 2, `tests/blocks/atomicity.test.ts`, "a Db without db-sqlite's transaction hook".
2. **Concurrent operations on one `Db`**: `Promise.all` of writes, copies and removes.
   - On Node, transactions are now async behind db-sqlite's mutex where they used to be synchronous. On the Durable Object path they run through `storage.transaction`.
   - Expected: every operation lands, and the contents are exact.
   - The test is in Task 2, `tests/blocks/atomicity.test.ts`, "concurrent operations on one Db".
3. Checked, already covered, no new test:
   - Durable Object BLOBs come back as `ArrayBuffer`. Covered by the FilesApi suites over the DO fake, which read content back.
   - A sweep racing a write. Covered by the existing atomicity cases, now run on both drivers.
   - A 0.10 database read by 0.11. The schema code is unchanged, so a test would only re-run the same `CREATE TABLE IF NOT EXISTS`.

## Before you start: the feature workspace

This plan runs inside the coordinated feature worktree of the thematic umbrella (spec D16, skill `umbrella-dev-flow`). It is created at execution time, before P1, not by any plan task:

- The umbrella is `umbrella-sqlite-indexing`, with `workspaces/statewalker-db`, `workspaces/webrun-files` and `workspaces/statewalker-search` as submodules; the feature worktree is `umbrella-sqlite-indexing__sqlite-db`, all on branch `feat/sqlite-db`.
- `node scripts/cli.mjs link` (skill Phase 2) writes the root `pnpm-workspace.yaml` (every submodule's packages + the aggregated catalogs) and the root `package.json` `pnpm.overrides` mapping every local `@statewalker/*` name to `workspace:*`, so the `catalog:` dependencies added below resolve to the local, unreleased statewalker-db packages.
- **Leave `webrun-sites` out of this umbrella:** its `workspace:*` override would force 0.11 onto webrun-cells (see "Consumers" at the end).

Check it before Task 1 (from the feature worktree root):

```bash
git -C workspaces/webrun-files branch --show-current   # expected: feat/sqlite-db
grep -n '"@statewalker/db-sqlite"' package.json         # expected: "workspace:*" under pnpm.overrides
pnpm install
pnpm --filter "@statewalker/db-*" build                 # the linked packages resolve through their dist/
```

**If the umbrella or the overrides are missing, stop** and set it up with the `umbrella-dev-flow` skill first.

P1 exports this plan uses: `newDoSqliteDb(storage): Db` (synchronous) from `@statewalker/db-sqlite-do`, and `newFakeDoStorage()` from its Node-only subpath `@statewalker/db-sqlite-do/fake` — a zero-argument fake over in-memory node:sqlite that enforces the probed DO limits (rejects `BEGIN`/`PRAGMA`, ≤ 100 bound parameters, BLOB ≤ 2 MB, BLOBs back as `ArrayBuffer`).

All paths below are relative to `workspaces/webrun-files/` in the feature worktree unless they start with `~`.

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `packages/webrun-files-sqlite/package.json` | modify | Adds `@statewalker/db-api` and `@statewalker/db-sqlite` as dependencies, `@statewalker/db-sqlite-node` and `@statewalker/db-sqlite-do` as devDependencies. |
| `pnpm-workspace.yaml` | modify | Catalog entries for the four db packages. |
| `packages/webrun-files-sqlite/src/run-statements.ts` | create | `SqlStatement` + `runStatements(tx, statements)`: the batch contract over a transaction's `Db`. |
| `packages/webrun-files-sqlite/src/sqlar-files-api.ts` | modify | `SqlDriver` → `Db`. |
| `packages/webrun-files-sqlite/src/blocks/sqlite-files-api.ts` | modify | `SqlDriver` → `Db`; transactions through `inTransaction` + `runStatements`. |
| `packages/webrun-files-sqlite/src/bytes.ts` | modify | Drops the ArrayBuffer and number[] branches, which no driver produces any more. |
| `packages/webrun-files-sqlite/src/index.ts` | modify | Drops the driver and `SqlDriver`/`SqlStatement` exports. |
| `packages/webrun-files-sqlite/src/sql.types.ts`, `src/drivers.ts` | delete | The old port and its drivers. |
| `packages/webrun-files-sqlite/tests/open-db.ts` | create | `openDb("node" \| "do")`: the two test drivers. |
| `packages/webrun-files-sqlite/tests/helpers.ts` | modify | `newArchive` over a `Db`; `rawRow` and `rawNames` become async. |
| `packages/webrun-files-sqlite/tests/blocks/helpers.ts` | modify | `newFiles` over a `Db`; async inspectors; `spyDb` replaces `passthrough`. |
| `packages/webrun-files-sqlite/tests/drivers.test.ts` | modify | Sqlar suites over the DO fake (the D1 case goes). |
| `packages/webrun-files-sqlite/tests/blocks/drivers.test.ts` | modify | SqliteFilesApi suites over the DO fake (the D1 case goes). |
| `packages/webrun-files-sqlite/tests/fakes.ts`, `tests/transaction.test.ts` | delete | Their subjects (the old drivers and the `transaction` port) are gone. P1's `runSqliteTransactionConformance` covers the transaction behaviour. |
| `packages/webrun-files-sqlite/tests/*.test.ts`, `tests/blocks/*.test.ts` | modify | Raw `DatabaseSync` calls become awaited `db.query`. |
| `packages/webrun-files-sqlite/README.md` | modify | Constructors, examples, the transaction section, D1 removed. |
| `packages/webrun-files/src/index.ts` | modify | Doc comment: `(SQLite: node:sqlite, Durable Objects, D1)` → `(SQLite over @statewalker/db-api: node:sqlite, browser, Durable Objects)`. |
| `.changeset/webrun-files-sqlite-on-db.md` | create | 0.11.0, breaking. |

**Two tasks.** `SqlarFilesApi` has no transactions and moves first. Its fixtures, the shared `openDb` and the dependency wiring land with it. Task 2 moves `SqliteFilesApi`, deletes the port, and ships the README, the changeset and the doc comment, because those describe the finished public API.

## Shared conversion rules (both tasks)

Every raw node:sqlite call in a test becomes an awaited call on the test's `Db`. Apply these rules mechanically, then fix any line the compiler or the run flags:

| Before (`db: DatabaseSync`) | After (`db: Db`) |
|---|---|
| `db.prepare(SQL).all(a, b)` | `await db.query(SQL, [a, b])` |
| `db.prepare(SQL).get(a)` | `(await db.query(SQL, [a]))[0]` |
| `db.prepare(SQL).run(a, b)` | `await db.query(SQL, [a, b])` |
| `count(db, t)`, `snapshot(db)`, `blocksOf(db, …)`, `pathRow(db, …)`, `fileRow(db, …)`, `rawRow(db, …)`, `rawNames(db)` | the same call with `await`; wrap it in parentheses before `?.` or `.x`, e.g. `(await rawRow(db, "a"))?.mode` |
| `expect(() => db.prepare(SQL).run()).toThrow(/X/)` | `await expect(db.query(SQL)).rejects.toThrow(/X/)` |
| `import("node:sqlite").DatabaseSync` / `Parameters<typeof count>[0]` used as a type | `Db` (`import type { Db } from "@statewalker/db-api"`) |

`PRAGMA table_info(...)` and `sqlite_master` queries keep working: they only run in node-driver tests.

---

### Task 1: `SqlarFilesApi` takes a `Db`

**Files:**
- Modify: `pnpm-workspace.yaml` (catalog)
- Modify: `packages/webrun-files-sqlite/package.json`
- Create: `packages/webrun-files-sqlite/tests/open-db.ts`
- Modify: `packages/webrun-files-sqlite/tests/helpers.ts`
- Modify: `packages/webrun-files-sqlite/tests/drivers.test.ts`, `tests/format.test.ts`, `tests/symlinks.test.ts`, `tests/codec.test.ts` (conversion rules)
- Modify: `packages/webrun-files-sqlite/src/sqlar-files-api.ts`
- Modify: `packages/webrun-files-sqlite/README.md` (the `SqlarFilesApi` examples only)

**Interfaces:**
- Consumes from P1:
  - `newNodeSqliteDb(options?: { path?: string }): Promise<Db>` from `@statewalker/db-sqlite-node`;
  - `newDoSqliteDb(storage): Db` (synchronous) from `@statewalker/db-sqlite-do` and `newFakeDoStorage()` from `@statewalker/db-sqlite-do/fake`.
- Produces:
  - `new SqlarFilesApi(db: Db, opts?: SqlarFilesApiOptions)`;
  - test helpers `openDb(driver: Driver): Promise<Db>`, `type Driver = "node" | "do"`, `DRIVERS: Driver[]`, `newArchive({ codec?, db?, driver? }) → { db: Db, files }`, and the async `rawRow(db, name)` and `rawNames(db)`.

- [ ] **Step 1: Wire the dependencies**

Add to the `catalog:` block of `pnpm-workspace.yaml`, after `"@hono/node-server"`:

```yaml
  "@statewalker/db-api": ^0.1.3
  "@statewalker/db-sqlite": ^0.1.0
  "@statewalker/db-sqlite-do": ^0.1.0
  "@statewalker/db-sqlite-node": ^0.3.0
```

The versions are the ones P1's changesets produce:
- `db-sqlite` and `db-sqlite-do` are new at 0.1.0;
- `db-sqlite-node` goes 0.2.1 → 0.3.0, its breaking move to node:sqlite (a 0.x minor).

During development the umbrella overrides resolve all four to the local workspace anyway.

In `packages/webrun-files-sqlite/package.json`:

```json
  "dependencies": {
    "@statewalker/db-api": "catalog:",
    "@statewalker/db-sqlite": "catalog:",
    "@statewalker/webrun-files": "workspace:^"
  },
  "devDependencies": {
    "@statewalker/db-sqlite-do": "catalog:",
    "@statewalker/db-sqlite-node": "catalog:",
    "@statewalker/webrun-files-tests": "workspace:^",
    "@types/node": "catalog:",
    "pako": "catalog:",
    "rimraf": "catalog:",
    "rolldown": "catalog:",
    "typescript": "catalog:",
    "vitest": "catalog:"
  },
```

`db-api` is a dependency, not a devDependency, because the public constructors name `Db` in their emitted `.d.ts`. `db-sqlite` is a runtime import, used by Task 2.

Run: `pnpm install` (from the feature worktree root)
Expected: it completes, and `ls webrun-files/packages/webrun-files-sqlite/node_modules/@statewalker/` lists `db-api db-sqlite db-sqlite-do db-sqlite-node` as links into `workspaces/statewalker-db/packages/…`.

- [ ] **Step 2: Write the test drivers**

Create `packages/webrun-files-sqlite/tests/open-db.ts`:

```ts
import type { Db } from "@statewalker/db-api";
import { newDoSqliteDb } from "@statewalker/db-sqlite-do";
import { newFakeDoStorage } from "@statewalker/db-sqlite-do/fake";
import { newNodeSqliteDb } from "@statewalker/db-sqlite-node";

/** node:sqlite in memory, or a Durable Object's storage faked over node:sqlite. */
export type Driver = "node" | "do";

export const DRIVERS: Driver[] = ["node", "do"];

export async function openDb(driver: Driver = "node"): Promise<Db> {
  return driver === "node" ? newNodeSqliteDb() : newDoSqliteDb(newFakeDoStorage());
}
```

- [ ] **Step 3: Move the Sqlar fixtures onto `Db`**

Replace `packages/webrun-files-sqlite/tests/helpers.ts` with:

```ts
import type { Db } from "@statewalker/db-api";
import { type Codec, SqlarFilesApi } from "../src/index.js";
import { type Driver, openDb } from "./open-db.js";

/** A fresh in-memory archive, with its Db for inspecting the table directly. */
export async function newArchive(opts: { codec?: Codec; db?: Db; driver?: Driver } = {}) {
  const db = opts.db ?? (await openDb(opts.driver));
  const files = new SqlarFilesApi(db, { codec: opts.codec });
  await files.init();
  return { db, files };
}

export interface RawRow {
  name: string;
  mode: number;
  mtime: number;
  sz: number;
  dtype: string;
  len: number | null;
  data: unknown;
}

/** The stored row for `name`, read with plain SQL — independent of the adapter. */
export async function rawRow(db: Db, name: string): Promise<RawRow | undefined> {
  const rows = await db.query<RawRow>(
    "SELECT name, mode, mtime, sz, typeof(data) AS dtype, length(data) AS len, data FROM sqlar WHERE name = ?",
    [name],
  );
  return rows[0];
}

export async function rawNames(db: Db): Promise<string[]> {
  const rows = await db.query<{ name: string }>("SELECT name FROM sqlar ORDER BY name");
  return rows.map((r) => r.name);
}
```

Replace `packages/webrun-files-sqlite/tests/drivers.test.ts` with the same file restricted to the Durable Object fake. The D1 case is deleted. This is still the `ctx.storage` BLOB-shape proof:

```ts
/**
 * SqlarFilesApi over a Durable Object's storage, faked over node:sqlite by
 * @statewalker/db-sqlite-do — including its BLOB shape, which the driver
 * normalises. Proves the adapter on that path, not the runtime.
 */
import { createFilesApiTests } from "@statewalker/webrun-files-tests";
import * as pako from "pako";
import { describe, expect, it } from "vitest";
import { pakoCodec } from "../src/index.js";
import { newArchive } from "./helpers.js";

createFilesApiTests("SqlarFilesApi (Durable Object)", async () => {
  const { db, files } = await newArchive({ driver: "do" });
  return { api: files, cleanup: async () => db.close() };
});

describe("Durable Object", () => {
  it("reads compressed rows and link targets back through the runtime's value shapes", async () => {
    const { db, files } = await newArchive({ driver: "do", codec: pakoCodec(pako) });
    const big = new TextEncoder().encode("line\n".repeat(1000));
    await files.write("/big.txt", [big]);
    await files.symlink("/link", "big.txt");
    await files.copy("/big.txt", "/copy.txt");
    await files.copy("/link", "/link-copy");

    const read = async (p: string) => {
      const chunks: Uint8Array[] = [];
      for await (const c of files.read(p)) chunks.push(c);
      return chunks[0];
    };
    expect(await read("/link")).toEqual(big);
    expect(await read("/copy.txt")).toEqual(big);
    expect(await files.readlink("/link-copy")).toBe("big.txt");
    const [stored] = await db.query<{ t: string; n: number }>(
      "SELECT typeof(data) AS t, length(data) AS n FROM sqlar WHERE name = 'copy.txt'",
    );
    expect(stored.t).toBe("blob");
    expect(stored.n).toBeLessThan(big.byteLength);
  });
});
```

Apply the conversion rules to `tests/format.test.ts`, `tests/symlinks.test.ts` and `tests/codec.test.ts`. Three lines are not covered by a rule:

- `format.test.ts`, "is idempotent and keeps existing rows":
  ```ts
  await db.query("INSERT INTO sqlar VALUES ('a.txt', 33188, 1, 1, x'41')");
  await files.init();
  expect(await db.query("SELECT count(*) AS n FROM sqlar")).toEqual([{ n: 1 }]);
  ```
- `codec.test.ts`, the line that inserts `'z.js'`: `db.prepare("INSERT INTO sqlar VALUES ('z.js', 33188, 1, ?, ?)").run(X, Y)` becomes `await db.query("INSERT INTO sqlar VALUES ('z.js', 33188, 1, ?, ?)", [X, Y])`. `X` and `Y` are the same expressions as before.
- `codec.test.ts`, the line `expect(rawRow(db, "b.js")?.data).toEqual(rawRow(db, "a.js")?.data)` becomes `expect((await rawRow(db, "b.js"))?.data).toEqual((await rawRow(db, "a.js"))?.data)`.

- [ ] **Step 4: Run the Sqlar tests and watch them fail**

Run: `pnpm --filter @statewalker/webrun-files-sqlite exec vitest run tests/format.test.ts tests/symlinks.test.ts tests/codec.test.ts tests/conformance.test.ts tests/sqlar-files-api.test.ts tests/sqlar-big-files.test.ts tests/drivers.test.ts`
Expected: FAIL. `SqlarFilesApi` still calls `this.#sql.run` and `this.#sql.all`, which a `Db` doesn't have, so it throws `TypeError: this.#sql.run is not a function` from `init()`.

- [ ] **Step 5: Move `SqlarFilesApi` onto `Db`**

In `packages/webrun-files-sqlite/src/sqlar-files-api.ts`:

- Imports: replace `import type { SqlDriver } from "./sql.types.js";` with `import type { Db } from "@statewalker/db-api";`.
- The field and the constructor:
  ```ts
  readonly #db: Db;

  constructor(db: Db, opts: SqlarFilesApiOptions = {}) {
    this.#db = db;
  ```
  Keep the rest of the constructor body.
- Every call site:
  - `this.#sql.run(SCHEMA)` → `this.#db.query(SCHEMA)`;
  - `this.#sql.all<T>(sql, a, b)` → `this.#db.query<T>(sql, [a, b])`;
  - `this.#sql.all<T>(sql, ...range.params)` → `this.#db.query<T>(sql, range.params)`;
  - `this.#sql.run(sql, ...range.params)` → `this.#db.query(sql, range.params)`;
  - the `#put` statement `this.#sql.run(SQL, name, mode, mtime, sz, data)` → `this.#db.query(SQL, [name, mode, Math.floor(Date.now() / 1000), sz, data])`, keeping the existing argument expressions and the `// SQLAR mtime is in seconds` comment.

There are 9 call sites (lines 57, 66, 153, 186, 191, 203, 271, 280, 288 today). `grep -n "#sql" src/sqlar-files-api.ts` must print nothing afterwards.

- [ ] **Step 6: Run the Sqlar tests and watch them pass**

Run: the command from Step 4.
Expected: PASS. The node and DO conformance suites, format, symlinks, codecs and big files are all green.

Then run the whole package: `pnpm --filter @statewalker/webrun-files-sqlite test`
Expected: PASS. `SqliteFilesApi` and its tests are untouched in this task and still use `NodeSqlDriver` and `tests/fakes.ts`.

- [ ] **Step 7: Update the `SqlarFilesApi` examples in the README**

In `packages/webrun-files-sqlite/README.md`, section "A portable archive with `SqlarFilesApi`", replace the code block's opening lines with:

```ts
import { newNodeSqliteDb } from '@statewalker/db-sqlite-node';
import * as pako from 'pako';
import { pakoCodec, SqlarFilesApi } from '@statewalker/webrun-files-sqlite';

const files = new SqlarFilesApi(await newNodeSqliteDb({ path: 'site.sqlar' }), {
```

Keep the rest of that block. Task 2 rewrites the rest of the README.

- [ ] **Step 8: Typecheck, lint, commit**

```bash
cd workspaces/webrun-files  # from the feature worktree root
pnpm --filter @statewalker/webrun-files-sqlite exec tsc --noEmit -p tsconfig.json
pnpm biome check --write --unsafe packages/webrun-files-sqlite pnpm-workspace.yaml
git add pnpm-workspace.yaml packages/webrun-files-sqlite pnpm-lock.yaml
git commit -m "feat(webrun-files-sqlite): SqlarFilesApi takes a Db from @statewalker/db-api"
```

The typecheck and biome must both exit 0. The commit message ends with the session's attribution lines. If the root `pnpm install` in the feature folder doesn't touch the repo's `pnpm-lock.yaml`, run `pnpm install --lockfile-only` inside `webrun-files/` first. Without it, CI's frozen install fails on the new catalog entries.

---

### Task 2: `SqliteFilesApi` on `Db` + `inTransaction`; the `SqlDriver` port is deleted

**Files:**
- Create: `packages/webrun-files-sqlite/src/run-statements.ts`
- Modify: `packages/webrun-files-sqlite/src/blocks/sqlite-files-api.ts`
- Modify: `packages/webrun-files-sqlite/src/bytes.ts`, `src/index.ts`
- Delete: `packages/webrun-files-sqlite/src/sql.types.ts`, `src/drivers.ts`, `tests/fakes.ts`, `tests/transaction.test.ts`
- Modify: `packages/webrun-files-sqlite/tests/blocks/helpers.ts`, `tests/blocks/drivers.test.ts`, `tests/blocks/atomicity.test.ts`, `tests/blocks/backpressure.test.ts`, `tests/blocks/content.test.ts`, `tests/blocks/layout.test.ts`, `tests/blocks/schema.test.ts`. The conformance and big-files tests need no edit: they use `newFiles` and `db.close()`.
- Modify: `packages/webrun-files-sqlite/README.md`, `packages/webrun-files/src/index.ts`
- Create: `.changeset/webrun-files-sqlite-on-db.md`

**Interfaces:**
- Consumes:
  - `inTransaction` from `@statewalker/db-sqlite`;
  - the hook `SQLITE_TRANSACTION` (= `Symbol.for("@statewalker/db-sqlite:transaction")`) of type `SqliteTransactionHook = <T>(cb: (tx: Db) => Promise<T>) => Promise<T>`, both exported by P1's `@statewalker/db-sqlite`. The tests' `spyDb` calls it with that shape.
  - `openDb`, `DRIVERS` and `Driver` from Task 1.
- Produces:
  - `new SqliteFilesApi(db: Db, opts?: SqliteFilesApiOptions)`;
  - the package's public exports: `SqliteFilesApi`, `SqliteFilesApiOptions`, `SqlarFilesApi`, `SqlarFilesApiOptions`, and the codec exports, unchanged. **No driver and no `SqlDriver`/`SqlStatement` exports.**

- [ ] **Step 1: Move the blocks fixtures onto `Db`, with a spy that keeps the transaction hook**

Replace `packages/webrun-files-sqlite/tests/blocks/helpers.ts` with:

```ts
import type { Db } from "@statewalker/db-api";
import { SQLITE_TRANSACTION, type SqliteTransactionHook } from "@statewalker/db-sqlite";
import { SqliteFilesApi, type SqliteFilesApiOptions } from "../../src/index.js";
import { type Driver, openDb } from "../open-db.js";

/** A fresh in-memory SqliteFilesApi, with its Db for inspecting the tables directly. */
export async function newFiles(
  opts: SqliteFilesApiOptions & { db?: Db; driver?: Driver; spy?: Spy } = {},
) {
  const { db: given, driver, spy, ...options } = opts;
  const db = given ?? (await openDb(driver));
  const files = new SqliteFilesApi(spy ? spyDb(db, spy) : db, options);
  await files.init();
  return { db, files };
}


export interface Spy {
  /** Sees every query, inside a transaction or not; `next` runs it. */
  query?(
    sql: string,
    params: unknown[],
    next: () => Promise<unknown[]>,
    inTransaction: boolean,
  ): Promise<unknown[]>;
  /** Runs before each transaction starts. */
  before?(): void | Promise<void>;
  /** Runs inside each transaction after its statements; a throw rolls the transaction back. */
  after?(tx: Db): void | Promise<void>;
}

/**
 * A Db that reports to `spy`. A plain wrapper would lose db-sqlite's
 * transaction hook, so this one re-exposes it and spies on the transaction's Db too.
 */
export function spyDb(db: Db, spy: Spy): Db {
  const wrap = (inner: Db, inTransaction: boolean): Db => ({
    query: <T>(sql: string, params: unknown[] = []) =>
      (spy.query
        ? spy.query(sql, params, () => inner.query(sql, params), inTransaction)
        : inner.query(sql, params)) as Promise<T[]>,
    exec: (sql) => inner.exec(sql),
    close: () => inner.close(),
  });
  const hook = (db as unknown as Record<symbol, SqliteTransactionHook>)[SQLITE_TRANSACTION];
  const transaction: SqliteTransactionHook = async (cb) => {
    await spy.before?.();
    return hook.call(db, async (tx) => {
      const result = await cb(wrap(tx, true));
      await spy.after?.(tx);
      return result;
    });
  };
  return Object.assign(wrap(db, false), { [SQLITE_TRANSACTION]: transaction });
}

export interface BlockRow {
  fid: number;
  shift: number;
  len: number;
  block: Uint8Array;
}

export function blocksOf(db: Db, fid: number, prefix = "fs_"): Promise<BlockRow[]> {
  return db.query<BlockRow>(
    `SELECT fid, shift, length(block) AS len, block FROM ${prefix}blocks WHERE fid = ? ORDER BY shift`,
    [fid],
  );
}

export interface PathRow {
  pid: number;
  path: string;
  fid: number | null;
  mtime: number;
}

export async function pathRow(db: Db, path: string, prefix = "fs_"): Promise<PathRow | undefined> {
  return (await db.query<PathRow>(`SELECT * FROM ${prefix}paths WHERE path = ?`, [path]))[0];
}

export interface FileRow {
  fid: number;
  size: number | null;
  compression: string;
  block_size: number;
  hash: string | null;
  updated: number;
}

export async function fileRow(db: Db, fid: number, prefix = "fs_"): Promise<FileRow | undefined> {
  return (await db.query<FileRow>(`SELECT * FROM ${prefix}files WHERE fid = ?`, [fid]))[0];
}

export async function count(db: Db, table: string): Promise<number> {
  return (await db.query<{ n: number }>(`SELECT count(*) AS n FROM ${table}`))[0].n;
}

/** Every row of the three tables, blocks summarised, for before/after comparisons. */
export async function snapshot(db: Db, prefix = "fs_") {
  return {
    paths: await db.query(`SELECT path, fid FROM ${prefix}paths ORDER BY path`),
    files: await db.query(
      `SELECT fid, size, compression, block_size, hash FROM ${prefix}files ORDER BY fid`,
    ),
    blocks: await db.query(
      `SELECT fid, shift, length(block) AS len FROM ${prefix}blocks ORDER BY fid, shift`,
    ),
  };
}
```

Replace `packages/webrun-files-sqlite/tests/blocks/drivers.test.ts` with:

```ts
import { createFilesApiTests } from "@statewalker/webrun-files-tests";
import { newFiles } from "./helpers.js";

createFilesApiTests("SqliteFilesApi (Durable Object)", async () => {
  const { db, files } = await newFiles({ driver: "do", blockSize: 4096 });
  return { api: files, cleanup: async () => db.close() };
});
```

- [ ] **Step 2: Rewrite the tests that wrapped the driver**

**`tests/blocks/atomicity.test.ts`.**

The head of the file, up to and including `failingWhere`, becomes:

```ts
/**
 * What an interruption can leave. Failures are injected inside the very
 * transaction under test (a statement violating NOT NULL runs after its last
 * statement, so the database itself rolls back), and a crash is a Db that stops answering.
 */
import type { Db } from "@statewalker/db-api";
import { collectGenerator, collectStream, positionContent } from "@statewalker/webrun-files-tests";
import { describe, expect, it } from "vitest";
import { SqliteFilesApi } from "../../src/index.js";
import { DRIVERS, openDb } from "../open-db.js";
import { count, newFiles, snapshot } from "./helpers.js";

const enc = new TextEncoder();
const dec = new TextDecoder();
for (const driver of DRIVERS) {
  const small = { compression: null, blockSize: 64, driver } as const;

  describe(`[${driver}]`, () => {
    const FAIL = "INSERT INTO fs_paths(path, fid, mtime) VALUES (NULL, NULL, NULL)";

    /** An API whose transactions containing `marker` fail after their last statement. */
    async function failingWhere(marker: string) {
      let failures = 0;
      let hit = false;
      const { db, files } = await newFiles({
        ...small,
        spy: {
          before: () => {
            hit = false;
          },
          query: (sql, _params, next, inTransaction) => {
            if (inTransaction && sql.includes(marker)) hit = true;
            return next();
          },
          after: async (tx) => {
            if (!hit) return;
            failures++;
            await tx.query(FAIL);
          },
        },
      });
      const healthy = await newFiles({ ...small, db });
      return { db, files, healthy: healthy.files, failures: () => failures };
    }
```

The "atomic steps roll back completely" cases are unchanged except that `snapshot(db)` becomes `await snapshot(db)`.

The `wrap:` in "a crash mid-stream" becomes:

```ts
        const { db, files } = await newFiles({
          ...small,
          spy: {
            before: () => {
              if (dead) throw new Error("process died");
            },
            query: async (_sql, _params, next) => {
              if (dead) throw new Error("process died");
              return next();
            },
          },
        });
```

Delete the `alive` helper. Then `db.prepare("UPDATE fs_files SET updated = 0 WHERE size IS NULL").run();` becomes `await db.query("UPDATE fs_files SET updated = 0 WHERE size IS NULL");`, and every `count(db, …)` gets `await`.

"A sweep racing a write that then crashes" becomes:

```ts
        const { db, files } = await newFiles({
          ...small,
          spy: {
            query: async (sql, _params, next, inTransaction) => {
              if (inTransaction && sql.startsWith("DELETE") && sql.includes("size IS NULL")) {
                throw new Error("process died before cleanup");
              }
              return next();
            },
          },
        });
        async function* source() {
          yield* positionContent(64 * 2, [64]);
          await db.query("UPDATE fs_files SET updated = 0 WHERE size IS NULL");
          await files.sweep({ olderThan: 60_000 });
          yield* positionContent(64 * 2, [64]);
        }
```

In `describe("sweep")`, `withContents`, `fids` and `blockFids` become:

```ts
      async function withContents() {
        const { db, files } = await newFiles(small);
        await files.write("/referenced-old.txt", [enc.encode("r")]);
        const add = async (size: number | null, updated: number) => {
          const [{ fid }] = await db.query<{ fid: number }>(
            "INSERT INTO fs_files(size, compression, block_size, hash, updated) VALUES (?, 'none', 64, ?, ?) RETURNING fid",
            [size, size === null ? null : "h", updated],
          );
          await db.query("INSERT INTO fs_blocks(fid, shift, block) VALUES (?, 0, x'00')", [fid]);
          return fid;
        };
        await db.query("UPDATE fs_files SET updated = 0");
        const now = Date.now();
        const ids = {
          pendingOld: await add(null, now - 120_000),
          pendingYoung: await add(null, now - 1_000),
          unreferencedOld: await add(1, now - 120_000),
          unreferencedYoung: await add(1, now - 1_000),
        };
        return { db, files, ids };
      }
      const fids = async (db: Db) =>
        (await db.query<{ fid: number }>("SELECT fid FROM fs_files ORDER BY fid")).map((r) => r.fid);
      const blockFids = async (db: Db) =>
        (await db.query<{ fid: number }>("SELECT DISTINCT fid FROM fs_blocks ORDER BY fid")).map(
          (r) => r.fid,
        );
```

Their uses become `expect(await fids(db))` and `expect(await blockFids(db))`.

In "writes and sweeps racing":
- `agePending` becomes `const agePending = (db: Db) => db.query("UPDATE fs_files SET updated = 0 WHERE size IS NULL");`.
- Every `agePending(db)` gets `await`, and so does every `count(…)`.

"A source that vanishes before copy or move" becomes:

```ts
          const { db, files } = await newFiles({
            ...small,
            spy: {
              before: async () => {
                if (!armed) return;
                armed = false;
                await db.query("DELETE FROM fs_paths WHERE path = '/src' OR path LIKE '/src/%'");
              },
            },
          });
```

Its `snapshot(db).paths` reads become `(await snapshot(db)).paths`.

Append these two Review Focus cases at the end of the `describe(`[${driver}]`)` body:

```ts
    describe("a Db without db-sqlite's transaction hook", () => {
      it("fails the first write and shows no partial file", async () => {
        const db = await openDb(driver);
        const plain: Db = {
          query: (sql, params) => db.query(sql, params),
          exec: (sql) => db.exec(sql),
          close: () => db.close(),
        };
        const files = new SqliteFilesApi(plain, { compression: null, blockSize: 64 });
        await files.init();
        await expect(files.write("/f", [enc.encode("x")])).rejects.toThrow(/no SQLite transaction hook/);
        expect(await files.exists("/f")).toBe(false);
      });
    });

    describe("concurrent operations on one Db", () => {
      it("all land, with exact contents", async () => {
        const { files } = await newFiles(small);
        await Promise.all([
          files.write("/a.bin", positionContent(500, [64])),
          files.write("/b.bin", positionContent(300, [50], 7)),
          files.write("/c/d.txt", [enc.encode("d")]),
        ]);
        await Promise.all([files.copy("/a.bin", "/a2.bin"), files.remove("/c")]);
        expect(await collectStream(files.read("/a2.bin"))).toEqual(
          await collectStream(positionContent(500, [64])),
        );
        expect(await collectStream(files.read("/b.bin"))).toEqual(
          await collectStream(positionContent(300, [50], 7)),
        );
        expect(await files.exists("/c")).toBe(false);
      });
    });
```

**`tests/blocks/backpressure.test.ts`.**

- Imports: drop `type SqlDriver` and `passthrough`, and import `newFiles, type Spy` from `./helpers.js`.
- `watching` becomes:
  ```ts
  /** A spy that reports every block insert and block fetch. */
  function watching(events: { onInsert?(shift: number): void; onFetch?(): void }): Spy {
    return {
      query(sql, params, next) {
        if (/SELECT shift, block FROM fs_blocks/.test(sql)) events.onFetch?.();
        if (/INSERT INTO fs_blocks/.test(sql)) events.onInsert?.(params[1] as number);
        return next();
      },
    };
  }
  ```
- The three `wrap:` options:
  - first test: `spy: watching({ onInsert: (shift) => (worst = Math.max(worst, pulled - shift)) })`;
  - third test: `spy: watching({ onFetch: () => fetches++ })`;
  - second test:
    ```ts
        spy: {
          async query(sql, _params, next) {
            if (/SELECT shift, block FROM fs_blocks/.test(sql)) {
              fetches++;
              consumedAtFetch.push(consumed);
            }
            const rows = (await next()) as { shift: number }[];
            if (/FROM fs_blocks/.test(sql) && rows[0]) shifts.push(rows[0].shift);
            return rows;
          },
        },
    ```

**`tests/blocks/content.test.ts`, "closes the source when storing a block fails".** Its `wrap:` becomes:

```ts
      spy: {
        query: async (sql, params, next) => {
          if (sql.includes("INSERT INTO fs_blocks") && params[1] === 64) {
            throw new Error("disk full");
          }
          return next();
        },
      },
```

Drop `passthrough` from that file's import.

**`tests/blocks/layout.test.ts`, "fetch exactly the blocks the range touches".** Its `wrap:` becomes:

```ts
      spy: {
        query: (sql, params, next) => {
          if (sql.includes("FROM fs_blocks")) shifts.push(params[1] as number);
          return next();
        },
      },
```

Drop `passthrough` and `type SqlDriver` from that file's import.

**`tests/blocks/schema.test.ts`.**
- `objects` becomes:
  ```ts
  const objects = async (db: Db) =>
    (
      await db.query<{ type: string; name: string }>(
        "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
      )
    ).map((o) => `${o.type}:${o.name}`);
  ```
- Add `import type { Db } from "@statewalker/db-api";`.
- The unique-path case becomes:
  ```ts
    await db.query("INSERT INTO fs_paths(path, fid, mtime) VALUES ('/a', NULL, 1)");
    await expect(
      db.query("INSERT INTO fs_paths(path, fid, mtime) VALUES ('/a', NULL, 2)"),
    ).rejects.toThrow(/UNIQUE/);
  ```

Apply the shared conversion rules to every remaining raw call and inspector call in `tests/blocks/*.test.ts`. Then delete `tests/fakes.ts` and `tests/transaction.test.ts`.

Verify: `grep -rn "DatabaseSync\|passthrough\|SqlDriver\|fakes.js\|wrap:" packages/webrun-files-sqlite/tests` prints nothing.

- [ ] **Step 3: Run the blocks tests and watch them fail**

Run: `pnpm --filter @statewalker/webrun-files-sqlite exec vitest run tests/blocks`
Expected: FAIL. `SqliteFilesApi.init()` calls `this.#sql.run`, so it throws `TypeError: this.#sql.run is not a function`.

- [ ] **Step 4: Write `runStatements`**

Create `packages/webrun-files-sqlite/src/run-statements.ts`:

```ts
import type { Db } from "@statewalker/db-api";

/** One statement of a transaction. */
export interface SqlStatement {
  sql: string;
  params?: unknown[];
}

/**
 * Runs the statements in order on a transaction's Db and returns, per
 * statement, the rows it changed — zero exactly when it changed nothing. The
 * count is SQLite's `changes()` on the same connection, so index writes are
 * not counted. Call it only inside `inTransaction`; it does nothing but SQL,
 * so a retried transaction callback is safe.
 */
export async function runStatements(tx: Db, statements: SqlStatement[]): Promise<number[]> {
  const counts: number[] = [];
  for (const { sql, params = [] } of statements) {
    await tx.query(sql, params);
    const [row] = await tx.query<{ n: number }>("SELECT changes() AS n");
    counts.push(Number(row.n));
  }
  return counts;
}
```

- [ ] **Step 5: Move `SqliteFilesApi` onto `Db`**

In `packages/webrun-files-sqlite/src/blocks/sqlite-files-api.ts`:

- Imports: replace `import type { SqlDriver, SqlStatement } from "../sql.types.js";` with:
  ```ts
  import type { Db } from "@statewalker/db-api";
  import { inTransaction } from "@statewalker/db-sqlite";
  import { runStatements, type SqlStatement } from "../run-statements.js";
  ```
- The field and the constructor: `readonly #sql: SqlDriver;` → `readonly #db: Db;`, `constructor(sql: SqlDriver, …)` → `constructor(db: Db, …)`, and `this.#sql = sql;` → `this.#db = db;`.
- Add this private method next to `#entry`:
  ```ts
  /** The statements as one transaction; per statement, the rows it changed. */
  #transaction(statements: SqlStatement[]): Promise<number[]> {
    return inTransaction(this.#db, (tx) => runStatements(tx, statements));
  }
  ```
- Call sites:
  - every `this.#sql.transaction(X)` → `this.#transaction(X)` (lines 212, 228, 239, 349, 430, 456 today);
  - every `this.#sql.all<T>(sql, a, b, …)` → `this.#db.query<T>(sql, [a, b, …])` (lines 182, 329, 469, 491);
  - every `this.#sql.run(sql, a, b)` → `this.#db.query(sql, [a, b])` (lines 116, 295).
- The write's cleanup comment, `// including a synchronous throw from a synchronous driver.`, becomes `// including a Db without db-sqlite's transaction hook.`
- The `MAX_BLOCK_SIZE_LIMIT` comment becomes `/** Rows on Durable Objects are capped at 2 MB; leave room for deflate's worst case. */`.
- In the class doc, `no row outgrows the 2 MB limit of Durable Objects and D1` becomes `no row outgrows the 2 MB row limit of Durable Objects`.

`grep -n "#sql\|D1" src/blocks/sqlite-files-api.ts` must print nothing.

In `packages/webrun-files-sqlite/src/bytes.ts`, every driver now returns `Uint8Array`. Replace the file with:

```ts
/** BLOBs arrive as Uint8Array from every @statewalker/db-sqlite driver; SQLAR may hold TEXT. */
export function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (typeof value === "string") return new TextEncoder().encode(value);
  return new Uint8Array(0);
}
```

In `packages/webrun-files-sqlite/src/index.ts`, delete the `drivers.js` export block and the `sql.types.js` export line. Then delete `src/sql.types.ts` and `src/drivers.ts`.

- [ ] **Step 6: Run the whole package and watch it pass**

Run: `pnpm --filter @statewalker/webrun-files-sqlite test`
Expected: PASS. The suites run on both drivers:
- atomicity (including the two new cases);
- conformance;
- big files (node);
- layout, content, schema, backpressure and stream codec;
- all the Sqlar suites from Task 1.

Then from `webrun-files/`: `grep -rn "SqlDriver\|NodeSqlDriver\|DoSqlDriver\|D1SqlDriver\|D1Database" packages/` must print nothing.

- [ ] **Step 7: Rewrite the README for the new API**

In `packages/webrun-files-sqlite/README.md`:

- **What it is** (line 6). The text becomes "…database, through `@statewalker/db-api`'s `Db`: any `@statewalker/db-sqlite-*` driver — `node:sqlite`, the browser (sqlite-wasm), or a Durable Object's storage:". Remove D1 from the list.
- **Why it exists** (lines 17–19, 28). "Durable Objects and D1" becomes "Durable Objects". In the table row, `| Durable Objects / D1 |` becomes `| Durable Objects |`.
- **How to use.** The code block at line 47 becomes:
  ```ts
  import { newNodeSqliteDb } from '@statewalker/db-sqlite-node';
  import { newDoSqliteDb } from '@statewalker/db-sqlite-do';
  import { SqliteFilesApi } from '@statewalker/webrun-files-sqlite';

  await newNodeSqliteDb({ path: 'files.db' }); // node:sqlite
  newDoSqliteDb(this.ctx.storage);             // in a Durable Object: ctx.storage, not ctx.storage.sql
  ```
- **"Stream a large file through `SqliteFilesApi`"** becomes `const files = new SqliteFilesApi(await newNodeSqliteDb({ path: 'files.db' }));`, with the matching import.
- **"Inside a Durable Object"** becomes `const files = new SqliteFilesApi(newDoSqliteDb(this.ctx.storage));`, with `import { newDoSqliteDb } from '@statewalker/db-sqlite-do';`.
- **Delete the "Your own SQLite binding" section**: the `SqlDriver` interface no longer exists.
- **Replace "The drivers and their transactions" (line 151)** with a section titled `### Why every step runs through \`inTransaction\`, and what breaks it`:

  > Each step that changes what a path shows runs as one SQLite transaction through `inTransaction` from `@statewalker/db-sqlite`. It runs as `BEGIN IMMEDIATE … COMMIT` behind a mutex on Node and in the browser, and through `ctx.storage.transaction()` in a Durable Object, where `sql.exec` rejects `BEGIN`. The rows a statement changed come from `SELECT changes()` inside that transaction. Steps never depend on reading another statement's result: conditions live in SQL (`WHERE EXISTS …`).
  >
  > `inTransaction` finds the driver's transaction support through a hook on the `Db` it was given. **A `Db` wrapped in your own proxy (logging, metrics) loses the hook.** The first `write`, `remove`, `copy`, `move` or `sweep` then rejects with: `inTransaction: this Db has no SQLite transaction hook. It is not a @statewalker/db-sqlite* Db, or it wraps one (a wrapper object loses the hook - pass the driver's Db itself), or it is the handle of a running transaction (nesting is not supported).` Pass the driver's `Db` itself, or forward `db[SQLITE_TRANSACTION]` (exported by `@statewalker/db-sqlite`) in your wrapper.
- **"Why the block size is capped at 1.5 MiB"** (lines 181–182) becomes "under the 2 MB row limit of Durable Objects. Larger blocks mean fewer rows; smaller blocks make small range reads cheaper." This drops the D1 clause.
- **`SqlarFilesApi` limits** (line 239): "On Durable Objects and D1" becomes "On Durable Objects".
- **Dependencies** (line 244): list `@statewalker/db-api` (the `Db` contract), `@statewalker/db-sqlite` (`inTransaction`) and `@statewalker/webrun-files`. Say that the drivers are the caller's choice and are not dependencies.

Check: `grep -n "D1\|SqlDriver\|NodeSqlDriver\|DoSqlDriver\|DatabaseSync" packages/webrun-files-sqlite/README.md` prints nothing.

Type-check every README snippet you changed by pasting it into a scratch `.ts` file in the package and running `tsc --noEmit` on it.

- [ ] **Step 8: The doc comment in `webrun-files` and the changeset**

In `packages/webrun-files/src/index.ts`, line 14 becomes:

```ts
 * - @statewalker/webrun-files-sqlite (SQLite over @statewalker/db-api: node:sqlite, browser, Durable Objects)
```

Create `.changeset/webrun-files-sqlite-on-db.md`:

```md
---
"@statewalker/webrun-files-sqlite": minor
---

Breaking (0.x minor): `SqliteFilesApi` and `SqlarFilesApi` now take a `Db` from `@statewalker/db-api`
(any `@statewalker/db-sqlite-*` driver) instead of a `SqlDriver`. `SqlDriver`, `SqlStatement`,
`NodeSqlDriver`, `DoSqlDriver` and `D1SqlDriver` are removed; D1 is no longer supported. Multi-statement
steps run through `inTransaction` from `@statewalker/db-sqlite`. The storage format is unchanged:
databases written by 0.10 open as they are. Consumers that stay on the old driver API keep `^0.10.3`.
```

The doc-comment edit in `packages/webrun-files/src/index.ts` gets no changeset: a comment is not worth a release of `@statewalker/webrun-files`; it ships with that package's next real change.

- [ ] **Step 9: Full checks and commit**

```bash
cd workspaces/webrun-files  # from the feature worktree root
pnpm --filter @statewalker/webrun-files-sqlite test
pnpm --filter @statewalker/webrun-files-sqlite exec tsc --noEmit -p tsconfig.json
pnpm --filter @statewalker/webrun-files-sqlite build
pnpm biome check --write --unsafe packages/webrun-files-sqlite packages/webrun-files/src/index.ts .changeset
git add -A packages/webrun-files-sqlite packages/webrun-files/src/index.ts .changeset
git commit -m "feat(webrun-files-sqlite)!: SqliteFilesApi on Db + inTransaction; drop SqlDriver and D1"
```

All four commands must exit 0. The build proves that the emitted `.d.ts` resolves `Db`. The commit message ends with the session's attribution lines.

---

### Task 3: Release order — webrun-files now sits above statewalker-db

`webrun-files-sqlite` now depends on `@statewalker/db-api` and `@statewalker/db-sqlite`. The cascade itself needs no edit: `umbrella/tools/sw.mjs` computes the order from what each repository publishes and what its catalogs reference, so after Task 1's catalog entries `sw.mjs cascade statewalker-db` includes webrun-files after statewalker-db. Only the hand-kept bottom-up list in `umbrella/tools/workspace.mjs` (the cross-repo `workspace/` builder) still puts `webrun-files` below `statewalker-db`.

**Files:**
- Modify: `~/workspace-statewalker/worktree-main/umbrella/tools/workspace.mjs` (the `LIBRARIES` array; the umbrella is its own repository, outside this feature's three repos)

- [ ] **Step 1: Move `webrun-files` after `statewalker-db`**

```diff
 const LIBRARIES = [
   "statewalker-shared",
-  "webrun-files",
   "statewalker-fsm",
   "statewalker-db",
+  "webrun-files",
   "webrun-wire",
```

- [ ] **Step 2: Verify the cascade order** (after Task 1 is pushed to the feature branch, against the feature checkouts)

Run: `SW_REPOS=<feature worktree>/workspaces node ~/workspace-statewalker/worktree-main/umbrella/tools/sw.mjs deps statewalker-db`
Expected: `webrun-files` is listed, after `statewalker-db` and before `statewalker-search`. If it is missing, the catalog entries of Task 1 are not where `sw.mjs` reads them; fix that, not `sw.mjs`.

- [ ] **Step 3: Commit (in the umbrella repository)**

```bash
git -C ~/workspace-statewalker/worktree-main/umbrella add tools/workspace.mjs
git -C ~/workspace-statewalker/worktree-main/umbrella commit -m "chore(workspace): webrun-files above statewalker-db (webrun-files-sqlite depends on db-sqlite)"
```

---

## Consumers that must stay on 0.10.x (no change in this plan)

`grep` across every `~/workspace-statewalker/worktree-*` finds these importers of `@statewalker/webrun-files-sqlite` drivers:

| Where | Imports | Pin today |
|---|---|---|
| `worktree-main/webrun-sites/packages/webrun-cells` | `NodeSqlDriver`/`SqlDriver` (engine, schema, types, tests) | `catalog:` → `^0.10.3` in `webrun-sites/pnpm-workspace.yaml` |
| `worktree-feat-webrun-cells-demo/webrun-sites/packages/webrun-cells` and `apps/webrun-cells-demo` (including `wasm-sql-driver.ts`) | the same | `^0.10.3` |
| `worktree-feat-webrun-cells-store/webrun-sites/packages/webrun-cells-sqlite` (`SqlCellStore`) | `SqlDriver` | `^0.10.3` |

A caret on a 0.x version excludes 0.11, so **all three already stay on 0.10.x without an edit.**
- **Do not bump** those catalog entries until the deferred webrun-cells migration (spec D4) moves them onto `Db` + `inTransaction`.
- **Watch out for the umbrella harness.** If `webrun-sites` is ever added to the `umbrella-sqlite-indexing` umbrella, the `workspace:*` override would force the 0.11 source onto webrun-cells. Leave webrun-sites out of this feature's harness.

No other repository imports the package.

## Self-review

1. **Spec coverage:**
   - D4: `Db` + `inTransaction` (Task 2, Step 5); the local `runStatements` (Step 4); `SqlDriver` and all three drivers deleted (Steps 5–6); D1 dropped (Steps 5, 7, 8); webrun-cells pinned (the table above, no edit needed).
   - D14: the existing FilesApi suites over node and the DO fake (Task 1, Step 3; Task 2, Step 1). The atomicity suite now covers both drivers where it used to cover three.
   - D2: the wrapper failure mode is documented with its error text (Step 7) and tested (Step 2).
   - D16: the feature harness is checked, not created, in "Before you start"; the release order is Task 3.
2. **Placeholders:** none. The README quotes P1's `NO_HOOK` message verbatim; if P1's wording changes during implementation, the test's `/no SQLite transaction hook/` match fails first and the README is updated with it.
3. **Type consistency:**
   - `openDb(driver?: Driver)`, `DRIVERS` and `Driver` are defined in Task 1 and used in Task 2.
   - `Spy.query(sql, params, next, inTransaction)` matches every use; `newFiles({ spy })` replaces every `wrap:`/`driver:` (a function) use, and `driver` is now a `Driver` string.
   - `runStatements(tx, statements): Promise<number[]>` and `#transaction` return what the call sites index (`[alive]`, `[finished]`, `counts[counts.length - 1]`, `[, contents]`).
4. **Review Focus:** two lines, each with its test in Task 2, Step 2. The checked-and-covered cases are listed under item 3.
