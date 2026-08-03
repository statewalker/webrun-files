import { gzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { untarTgz } from "../src/sources/untar.js";

const enc = new TextEncoder();

/** Minimal ustar tar writer for fixtures. */
function makeTar(files: Record<string, string>): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const [name, content] of Object.entries(files)) {
    const data = enc.encode(content);
    const header = new Uint8Array(512);
    header.set(enc.encode(name), 0); // name @0 (100)
    header.set(enc.encode("0000644"), 100); // mode
    header.set(enc.encode(data.length.toString(8).padStart(11, "0")), 124); // size octal @124
    header.set(enc.encode("00000000000"), 136); // mtime
    header[156] = 0x30; // type "0" (regular file)
    header.set(enc.encode("ustar\x0000"), 257); // magic
    // checksum: fill @148 with spaces, sum, then write octal
    for (let i = 148; i < 156; i++) header[i] = 0x20;
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += header[i];
    header.set(enc.encode(`${sum.toString(8).padStart(6, "0")}\x00 `), 148);
    blocks.push(header);
    const padded = new Uint8Array(Math.ceil(data.length / 512) * 512);
    padded.set(data);
    blocks.push(padded);
  }
  blocks.push(new Uint8Array(1024)); // two zero blocks terminate
  const total = blocks.reduce((n, b) => n + b.length, 0);
  const tar = new Uint8Array(total);
  let off = 0;
  for (const b of blocks) {
    tar.set(b, off);
    off += b.length;
  }
  return tar;
}

describe("untarTgz", () => {
  it("extracts files, strips the package/ prefix, decodes content", () => {
    const tgz = gzipSync(
      makeTar({
        "package/package.json": '{"name":"x","version":"1.0.0"}',
        "package/lib/index.js": "module.exports = 42;",
      }),
    );
    const files = untarTgz(tgz);
    const dec = new TextDecoder();
    expect([...files.keys()].sort()).toEqual(["lib/index.js", "package.json"]);
    expect(dec.decode(files.get("package.json"))).toContain('"version":"1.0.0"');
    expect(dec.decode(files.get("lib/index.js"))).toBe("module.exports = 42;");
  });

  it("ignores directory entries and trailing zero blocks", () => {
    const tgz = gzipSync(makeTar({ "package/only.js": "1" }));
    const files = untarTgz(tgz);
    expect(files.size).toBe(1);
    expect(new TextDecoder().decode(files.get("only.js"))).toBe("1");
  });
});
