import type { SqlDriver } from "./sql.types.js";

/**
 * The table, verbatim from the SQLite Archive specification. Five columns,
 * `name` as the primary key and nothing more: any extra column, index or table
 * and other SQLAR tools may not recognise the archive.
 */
const SCHEMA = `CREATE TABLE IF NOT EXISTS sqlar(
  name TEXT PRIMARY KEY,  -- name of the file
  mode INT,               -- access permissions
  mtime INT,              -- last modification time
  sz INT,                 -- original file size
  data BLOB               -- compressed content
)`;

export interface SqlarFilesApiOptions {}

/** A FilesApi whose whole state is one SQLite Archive table. */
export class SqlarFilesApi {
  readonly #sql: SqlDriver;

  constructor(sql: SqlDriver, _opts: SqlarFilesApiOptions = {}) {
    this.#sql = sql;
  }

  /** Creates the table if it is missing. Await it before any other call. */
  async init(): Promise<void> {
    await this.#sql.run(SCHEMA);
  }
}
