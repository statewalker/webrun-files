// The client stub in a browser: every button runs one FilesApi call and prints its result as JSON.
import { newClientStub } from "/lib/webrun-files-http.js";

const params = new URLSearchParams(location.search);
const statusEl = document.getElementById("status");
const outputEl = document.getElementById("output");
const requestsEl = document.getElementById("requests");

/** Every request the client stub sends, as "METHOD ?query" — tests read it through window.requestLog. */
const requestLog = [];
window.requestLog = requestLog;
const loggingFetch = (req) => {
  const url = new URL(req.url);
  requestLog.push(`${req.method} ${decodeURIComponent(url.search)}`);
  requestsEl.textContent = requestLog.slice(-40).join("\n");
  return fetch(req);
};

const options = { baseUrl: `${location.origin}/api/files`, fetch: loggingFetch, upload: "auto" };
if (params.has("partSize")) options.partSize = Number(params.get("partSize"));
if (params.has("pageSize")) options.pageSize = Number(params.get("pageSize"));
if (params.has("upload")) options.upload = params.get("upload");
const files = await newClientStub(options);
window.files = files;

const field = (name) => document.querySelector(`[name="${name}"]`);
const value = (name) => field(name).value;

/** The same content as positionByte in @statewalker/webrun-files-tests: a hash of the offset. */
function positionByte(position) {
  let h = position >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return (h ^ (h >>> 16)) & 0xff;
}

/** A lazily generated source: chunks of uneven size, created only when pulled. */
async function* generated(size) {
  const sizes = [65537, 4093, 30000];
  for (let at = 0, i = 0; at < size; i++) {
    const chunk = new Uint8Array(Math.min(sizes[i % sizes.length], size - at));
    for (let j = 0; j < chunk.length; j++) chunk[j] = positionByte(at + j);
    at += chunk.length;
    yield chunk;
  }
}

async function readAll(iterable) {
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  for await (const chunk of iterable) {
    bytes += chunk.length;
    text += decoder.decode(chunk, { stream: true });
  }
  return { text: text + decoder.decode(), bytes };
}

const actions = {
  "write-text": async () => {
    await files.write(value("path"), [new TextEncoder().encode(value("content"))]);
    return { written: value("path") };
  },
  read: () => readAll(files.read(value("path"))),
  "read-range": () =>
    readAll(
      files.read(value("path"), { start: Number(value("start")), length: Number(value("length")) }),
    ),
  "write-generated": async () => {
    const size = Number(value("size"));
    await files.write(value("path"), generated(size));
    return { bytes: size };
  },
  "verify-generated": async () => {
    let bytes = 0;
    let ok = true;
    for await (const chunk of files.read(value("path"))) {
      for (let i = 0; i < chunk.length; i++) if (chunk[i] !== positionByte(bytes + i)) ok = false;
      bytes += chunk.length;
    }
    return { bytes, ok: ok && bytes === Number(value("size")) };
  },
  stats: async () => (await files.stats(value("path"))) ?? null,
  exists: () => files.exists(value("path")),
  mkdir: async () => {
    await files.mkdir(value("path"));
    return { created: value("path") };
  },
  copy: () => files.copy(value("path"), value("target")),
  move: () => files.move(value("path"), value("target")),
  remove: () => files.remove(value("path")),
  list: async () => {
    const after = value("after") || undefined;
    const entries = [];
    for await (const entry of files.list(value("path"), {
      recursive: field("recursive").checked,
      after,
    })) {
      entries.push(entry);
    }
    return entries;
  },
};

for (const button of document.querySelectorAll("button[data-action]")) {
  button.addEventListener("click", async () => {
    statusEl.textContent = "running";
    try {
      const result = await actions[button.dataset.action]();
      outputEl.textContent = JSON.stringify(result, null, 2);
      statusEl.textContent = "done";
    } catch (error) {
      outputEl.textContent = JSON.stringify({ error: String(error?.message ?? error) });
      statusEl.textContent = "error";
    }
  });
}

statusEl.textContent = "ready";
