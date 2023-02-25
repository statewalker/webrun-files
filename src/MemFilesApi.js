import FilesApi from "./FilesApi.js";
import getMimeType from "./getMimeType.js";

export default class MemFilesApi extends FilesApi {
  constructor(options) {
    super(options);
    this.index = {
      "/" : {
        "kind": "directory",
        "path": "/",
        "name": ""
      }
    };
  }

  async *list(file, { recursive = false } = {}) {
    await this._init();
    const filePath = this.normalizePath(file);
    const paths = this._getPaths();
    for (const path of paths) {
      if (path.indexOf(filePath) !== 0 || path === filePath) continue;
      const suffix = path.substring(filePath.length + 1);
      const segments = suffix.split("/");
      if (recursive || segments.length === 1) {
        yield this._getFileInfo(path);
      }
    }
  }

  async stats(file) {
    await this._init();
    const filePath = this.normalizePath(file);
    return this._getFileInfo(filePath);
  }

  async remove(file) {
    await this._init();
    const fileInfo = await this.stats(file);
    if (!fileInfo) return false;
    for await (const { path } of this.list(fileInfo, { recursive: true })) {
      if (path !== "/") delete this.index[path];
    }
    delete this.index[fileInfo.path];
  }

  async write(file, content) {
    await this._init();
    await this._doWrite(file, content);
  }

  async *read(file /* { start = 0, bufferSize = 1024 * 8 } = {} */) {
    await this._init();
    const filePath = this.normalizePath(file);
    const fileInfo = this.index[filePath];
    if (!fileInfo || fileInfo.kind !== "file") return ; // throw new Error("Not a file");
    const content = fileInfo.content;
    yield* content;
  }

  // TODO:
  // async copy(fromPath, toPath, options = {}) { ... }

  // TODO:
  // async move(fromPath, toPath, options = {}) { ... }

  async _init() {
    return this._initPromise = this._initPromise ||
      Promise.resolve().then(() => this._addEntries(this.options.files));
  }

  async _doWrite(file, content) {
    const filePath = this.normalizePath(file);
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
      chunk = new Uint8Array(chunk);
      info.content.push(chunk);
      info.size += chunk.length;
    }
  }

  async _addEntries(index = {}) {
    for (let [path, content] of Object.entries(index)) {
      if (typeof content === "string") {
        content = [new TextEncoder().encode(content)];
      } else if (content instanceof Uint8Array) {
        content = [content];
      }
      await this._doWrite(path, content);
    }
  }

  _getPaths() {
    return this._getIndexPaths(this.index);
  }

  _getIndexPaths(index) {
    return Object.keys(index).sort(compare);
    function compare(a, b) {
      return a > b ? 1 : a < b ? -1 : 0;
    }
  }

  _getFileInfo(path) {
    const fileInfo = this.index[path];
    if (!fileInfo) return null;
    const info = { ...fileInfo };
    delete info.content;
    return info;
  }

}
