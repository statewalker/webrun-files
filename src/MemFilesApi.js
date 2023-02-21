import FilesApi from "./FilesApi.js";
import getMimeType from "./getMimeType.js";

export default class MemFilesApi extends FilesApi {
  constructor(options) {
    super(options);
    this.index = {
      "/": {
        "kind": "directory",
        "path": "/",
        "name": "",
      },
    };
  }

  async *list(file, { recursive = false } = {}) {
    const filePath = this._normalizePath(file);
    const paths = this._getPaths();
    for (const path of paths) {
      if (path.indexOf(filePath) !== 0) continue;
      const suffix = path.substring(filePath.length);
      if (suffix.length > 0 && (recursive || suffix.indexOf("/") < 0)) {
        yield this._getFileInfo(path);
      }
    }
  }

  async stats(file) {
    const filePath = this._normalizePath(file);
    return this._getFileInfo(filePath);
  }

  async remove(file) {
    const filePath = this._normalizePath(file);
    for await (const { path } of this.list(filePath, { recursive: true })) {
      if (path !== '/') delete this.index[path];
    }
    delete this.index[filePath];
  }

  async write(file, content) {
    const filePath = this._normalizePath(file);
    const segments = filePath.split("/").filter((s) => !!s);
    const pathSegments = [""];
    let info;
    for (let i = 0; i < segments.length; i++) {
      const name = segments[i];
      pathSegments.push(name);
      const path = pathSegments.join("/");
      info = this.index[path] = this.index[path] || {
        path,
        name,
        kind: "directory",
      };
    }
    info.kind = "file";
    info.content = [];
    info.type = getMimeType(info.path);
    info.size = 0;
    info.lastModified = Date.now();
    if (typeof content === "function") content = content();
    for await (let chunk of content) {
      // chunk = new Uint8Array(chunk);
      info.content.push(chunk);
      info.size += chunk.length;
    }
  }

  async *read(file /* { start = 0, bufferSize = 1024 * 8 } = {} */) {
    const filePath = this._normalizePath(file);
    const info = this.index[filePath];
    if (!info || info.kind !== "file") return;
    const content = info.content;
    yield* content;
  }

  // TODO:
  // async copy(fromPath, toPath, options = {}) { ... }

  // TODO:
  // async move(fromPath, toPath, options = {}) { ... }

  _getPaths() {
    return Object.keys(this.index).sort(compare);
    function compare(a, b) {
      return a > b ? 1 : a < b ? -1 : 0;
    }
  }

  _getFileInfo(path) {
    const fileInfo = this.index[path];
    if (!fileInfo) return;
    const info = { ...fileInfo };
    delete info.content;
    return info;
  }

  _normalizePath(file) {
    let filePath = typeof file === "object" ? file.path : file + "";
    const segments = filePath.split("/").filter((s) => !!s && s !== '.');
    if (segments.length === 0) segments.push("");
    segments.unshift("");
    return segments.join("/");
  }
}

// function pathJoin(...paths) {
//   let segments = paths
//     .map((path) => path.split("/"))
//     .reduce((result, segments) => (result.push(...segments), result), []);
//   const firstSegment = segments.shift();
//   segments = segments.filter((s) => !!s && s !== ".");
//   segments.unshift(firstSegment);
//   return segments.join("/");
// }
