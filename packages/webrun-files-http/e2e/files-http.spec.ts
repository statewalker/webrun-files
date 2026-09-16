/**
 * The client stub in real browsers, against a real HTTP server, driven
 * through a page's UI. Every operation is checked in the page and, where it
 * changes state, in the served file system itself.
 */
import { expect, type Page, test } from "@playwright/test";
import { collectGenerator, collectStream, positionBytes } from "./helpers.js";
import { startTestServer, type TestServer } from "./server.js";

let server: TestServer;

test.beforeAll(async () => {
  server = await startTestServer({ minPartSize: 64 * 1024, maxPageSize: 256 });
});

test.afterAll(async () => {
  await server?.close();
});

const text = async (path: string) =>
  new TextDecoder().decode(await collectStream(server.fs.read(path)));

/** Open the page, with optional query options, and wait for the client stub to be ready. */
async function open(page: Page, query = "") {
  await page.goto(`${server.url}/${query}`);
  await expect(page.locator("#status")).toHaveText("ready");
}

/** Fill named fields, press an action button, and return the JSON result it prints. */
async function run(page: Page, action: string, fields: Record<string, string | boolean> = {}) {
  for (const [name, value] of Object.entries(fields)) {
    const field = page.locator(`[name="${name}"]`);
    if (typeof value === "boolean") await field.setChecked(value);
    else await field.fill(value);
  }
  await page.locator("#status").evaluate((el) => {
    el.textContent = "";
  });
  await page.locator(`button[data-action="${action}"]`).click();
  await expect(page.locator("#status")).toHaveText(/^(done|error)$/);
  const output = await page.locator("#output").textContent();
  const result = JSON.parse(output ?? "null") as unknown;
  if ((await page.locator("#status").textContent()) === "error") {
    throw new Error(`action ${action} failed: ${output}`);
  }
  return result;
}

const requestLog = (page: Page) =>
  page.evaluate(() => (window as unknown as { requestLog: string[] }).requestLog);

test("writes, reads and stats a text file", async ({ page, browserName }) => {
  await open(page);
  const path = `/${browserName}/notes/hello.txt`;
  await run(page, "write-text", { path, content: "Hello from the browser" });
  expect(await text(path)).toBe("Hello from the browser");

  expect(await run(page, "read", { path })).toEqual({ text: "Hello from the browser", bytes: 22 });
  expect(await run(page, "stats", { path })).toEqual({
    kind: "file",
    size: 22,
    lastModified: expect.any(Number),
  });
  expect(await run(page, "exists", { path })).toBe(true);
});

test("reads a byte range", async ({ page, browserName }) => {
  await open(page);
  const path = `/${browserName}/range.txt`;
  await server.fs.write(path, [new TextEncoder().encode("0123456789abcdef")]);
  expect(await run(page, "read-range", { path, start: "10", length: "4" })).toEqual({
    text: "abcd",
    bytes: 4,
  });
});

test("creates directories, copies, moves and removes", async ({ page, browserName }) => {
  await open(page);
  const root = `/${browserName}/ops`;
  await run(page, "mkdir", { path: `${root}/empty/deep` });
  expect(await server.fs.stats(`${root}/empty/deep`)).toEqual({ kind: "directory" });

  await run(page, "write-text", { path: `${root}/a.txt`, content: "A" });
  expect(await run(page, "copy", { path: `${root}/a.txt`, target: `${root}/copy/a.txt` })).toBe(
    true,
  );
  expect(await text(`${root}/copy/a.txt`)).toBe("A");

  expect(await run(page, "move", { path: `${root}/copy`, target: `${root}/moved` })).toBe(true);
  expect(await server.fs.exists(`${root}/copy`)).toBe(false);
  expect(await text(`${root}/moved/a.txt`)).toBe("A");

  expect(await run(page, "remove", { path: `${root}/moved` })).toBe(true);
  expect(await server.fs.exists(`${root}/moved/a.txt`)).toBe(false);

  expect(await run(page, "remove", { path: `${root}/moved` })).toBe(false);
  expect(await run(page, "copy", { path: `${root}/nope`, target: `${root}/x` })).toBe(false);
  expect(await run(page, "move", { path: `${root}/nope`, target: `${root}/x` })).toBe(false);
});

test("lists recursively in path order, one small page at a time", async ({ page, browserName }) => {
  const root = `/${browserName}/tree`;
  for (const name of ["b.txt", "a/x.txt", "a-x", "a.txt", "a/y/z.txt", "B"]) {
    await server.fs.write(`${root}/${name}`, [new TextEncoder().encode(name)]);
  }
  await open(page, "?pageSize=2");
  const expected = (await collectGenerator(server.fs.list(root, { recursive: true }))).map(
    (e) => e.path,
  );
  const listed = (await run(page, "list", { path: root, recursive: true, after: "" })) as {
    path: string;
  }[];
  expect(listed.map((e) => e.path)).toEqual(expected);
  expect(expected[0]).toBe(`${root}/B`);

  const lists = (await requestLog(page)).filter((r) => r.includes("?list"));
  expect(lists.length).toBeGreaterThanOrEqual(Math.ceil(expected.length / 2));

  const after = expected[2];
  const rest = (await run(page, "list", { path: root, recursive: true, after })) as {
    path: string;
  }[];
  expect(rest.map((e) => e.path)).toEqual(expected.slice(3));

  const direct = (await run(page, "list", { path: root, recursive: false, after: "" })) as {
    name: string;
    kind: string;
  }[];
  expect(direct.map((e) => `${e.kind}:${e.name}`)).toEqual([
    "file:B",
    "directory:a",
    "file:a-x",
    "file:a.txt",
    "file:b.txt",
  ]);
});

test("uploads a generated file in chunked parts, stored byte-exact, then verifies it streaming back", async ({
  page,
  browserName,
}) => {
  await open(page, "?partSize=65536");
  const path = `/${browserName}/big/generated.bin`;
  const size = 200 * 1024 + 123;

  expect(await run(page, "write-generated", { path, size: String(size) })).toEqual({ bytes: size });

  const log = await requestLog(page);
  // A fresh page: its only upload requests are this write's, and no streamed PUT among them.
  const upload = log.filter((r) => r.includes("upload") || r === "PUT ");
  expect(upload.map((r) => r.replace(/upload=[^&]+/, "upload=ID"))).toEqual([
    "POST ?uploads",
    "PUT ?upload=ID&part=1",
    "PUT ?upload=ID&part=2",
    "PUT ?upload=ID&part=3",
    "PUT ?upload=ID&part=4",
    "POST ?upload=ID&complete=4",
  ]);

  expect(
    Buffer.from(await collectStream(server.fs.read(path))).equals(Buffer.from(positionBytes(size))),
  ).toBe(true);
  const staged = await collectGenerator(server.staging.list("/", { recursive: true }));
  expect(staged.filter((e) => e.kind === "file")).toEqual([]);

  expect(await run(page, "verify-generated", { path, size: String(size) })).toEqual({
    bytes: size,
    ok: true,
  });
});

test("round-trips names with spaces, #, ?, % and non-ASCII", async ({ page, browserName }) => {
  await open(page);
  const path = `/${browserName}/odd/a b #1? 100% é😀.txt`;
  await run(page, "write-text", { path, content: "odd" });
  expect(await text(path)).toBe("odd");
  expect(await run(page, "read", { path })).toEqual({ text: "odd", bytes: 3 });
  const listed = (await run(page, "list", {
    path: `/${browserName}/odd`,
    recursive: false,
    after: "",
  })) as {
    path: string;
  }[];
  expect(listed.map((e) => e.path)).toEqual([path]);
});

test("reports absent files as absent", async ({ page, browserName }) => {
  await open(page);
  const path = `/${browserName}/does/not/exist.txt`;
  expect(await run(page, "read", { path })).toEqual({ text: "", bytes: 0 });
  expect(await run(page, "stats", { path })).toBe(null);
  expect(await run(page, "exists", { path })).toBe(false);
  expect(await run(page, "list", { path, recursive: false, after: "" })).toEqual([]);
});

test("a forced streamed upload fails loudly rather than storing corrupt content", async ({
  page,
  browserName,
}) => {
  // Firefox cannot send a stream body and silently sends "[object ReadableStream]" instead;
  // Chromium refuses stream bodies over HTTP/1.1. Neither may leave a file behind.
  await open(page, "?upload=stream");
  const path = `/${browserName}/forced-stream.txt`;
  await expect(run(page, "write-text", { path, content: "must not be corrupted" })).rejects.toThrow(
    /failed/,
  );
  expect(await server.fs.exists(path)).toBe(false);
});
