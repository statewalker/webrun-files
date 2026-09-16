import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Sha256 } from "../../src/blocks/sha256.js";

const reference = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describe("Sha256", () => {
  it("hashes the empty input", () => {
    expect(new Sha256().digestHex()).toBe(reference(new Uint8Array(0)));
  });

  it("matches node:crypto around every padding boundary", () => {
    for (const size of [1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 1000]) {
      const bytes = Uint8Array.from({ length: size }, (_, i) => (i * 31 + 7) & 0xff);
      expect(new Sha256().update(bytes).digestHex(), `size ${size}`).toBe(reference(bytes));
    }
  });

  it("gives the same digest however the input is split", () => {
    const bytes = crypto.getRandomValues(new Uint8Array(10_000));
    const hash = new Sha256();
    for (let at = 0, step = 1; at < bytes.length; at += step, step = (step * 3 + 1) % 500) {
      hash.update(bytes.subarray(at, at + step));
    }
    expect(hash.digestHex()).toBe(reference(bytes));
  });
});

describe("Sha256 finalisation", () => {
  it("refuses to digest twice, since the first digest consumed the state", () => {
    const hash = new Sha256().update(new Uint8Array([1, 2, 3]));
    hash.digestHex();
    expect(() => hash.digestHex()).toThrow(/already/);
    expect(() => hash.update(new Uint8Array([4]))).toThrow(/already/);
  });
});
