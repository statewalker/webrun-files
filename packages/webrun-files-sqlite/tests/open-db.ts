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
