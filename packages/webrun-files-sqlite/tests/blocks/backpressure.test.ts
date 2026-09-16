/**
 * The streaming promise, measured: `write` never pulls the source more than a
 * block (plus one source chunk) ahead of what it has stored, and `read` never
 * fetches a block before its consumer has taken everything before it.
 */
import { positionContent } from "@statewalker/webrun-files-tests";
import * as pako from "pako";
import { describe, expect, it } from "vitest";
import {
  pakoDeflateCodec,
  type SqlDriver,
  type StreamCodec,
  webDeflateCodec,
} from "../../src/index.js";
import { newFiles } from "./helpers.js";

const KiB = 1024;
const MiB = 1024 * KiB;
const MAX_BLOCK = 64 * KiB;
const SOURCE_CHUNK = 10 * KiB + 3;
const SIZE = 4 * MiB + 17;

const variants: [string, StreamCodec | null][] = [
  ["uncompressed", null],
  ["web deflate", webDeflateCodec()],
  ["pako deflate", pakoDeflateCodec(pako)],
];

/** A driver that reports every block insert and block fetch. */
function watching(driver: SqlDriver, events: { onInsert?(shift: number): void; onFetch?(): void }) {
  return {
    all(sql: string, ...params: unknown[]) {
      if (/SELECT shift, block FROM fs_blocks/.test(sql)) events.onFetch?.();
      return driver.all(sql, ...params);
    },
    run(sql: string, ...params: unknown[]) {
      if (/INSERT INTO fs_blocks/.test(sql)) events.onInsert?.(params[1] as number);
      return driver.run(sql, ...params);
    },
  } as SqlDriver;
}

for (const [label, compression] of variants) {
  describe(`backpressure — ${label}`, () => {
    it("write pulls at most one block and one source chunk ahead of storage", async () => {
      let pulled = 0;
      let worst = 0;
      const { files } = await newFiles({
        compression,
        minBlockSize: 16 * KiB,
        maxBlockSize: MAX_BLOCK,
        wrap: (d) =>
          watching(d, { onInsert: (shift) => (worst = Math.max(worst, pulled - shift)) }),
      });
      async function* source() {
        for await (const chunk of positionContent(SIZE, [SOURCE_CHUNK])) {
          pulled += chunk.length;
          yield chunk;
        }
      }
      await files.write("/f", source());
      expect(pulled).toBe(SIZE);
      expect(worst).toBeGreaterThan(0);
      expect(worst).toBeLessThanOrEqual(MAX_BLOCK + SOURCE_CHUNK);
    });

    it("read fetches a block only once everything before it was consumed", async () => {
      const writer = await newFiles({
        compression,
        minBlockSize: 16 * KiB,
        maxBlockSize: MAX_BLOCK,
      });
      await writer.files.write("/f", positionContent(SIZE, [MiB]));
      let consumed = 0;
      let fetches = 0;
      const shifts: number[] = [];
      const consumedAtFetch: number[] = [];
      const { files } = await newFiles({
        db: writer.db,
        compression,
        wrap: (d) =>
          watching(
            {
              all: (sql, ...params) => {
                const rows = d.all<{ shift: number }>(sql, ...params) as { shift: number }[];
                if (/FROM fs_blocks/.test(sql) && rows[0]) shifts.push(rows[0].shift);
                return rows as never;
              },
              run: (sql, ...params) => d.run(sql, ...params),
            },
            { onFetch: () => (fetches++, consumedAtFetch.push(consumed)) },
          ),
      });
      for await (const chunk of files.read("/f")) {
        consumed += chunk.length;
        await new Promise((r) => setTimeout(r, 0));
      }
      expect(consumed).toBe(SIZE);
      expect(fetches).toBe(shifts.length);
      for (let i = 0; i < shifts.length; i++) expect(shifts[i]).toBe(consumedAtFetch[i]);
    });

    it("read stops fetching when the consumer stops", async () => {
      let fetches = 0;
      const { files } = await newFiles({
        compression,
        minBlockSize: 16 * KiB,
        maxBlockSize: MAX_BLOCK,
        wrap: (d) => watching(d, { onFetch: () => fetches++ }),
      });
      await files.write("/f", positionContent(SIZE, [MiB]));
      for await (const _ of files.read("/f", { start: 100 * KiB })) break;
      await new Promise((r) => setTimeout(r, 10));
      expect(fetches).toBe(1);
    });
  });
}
