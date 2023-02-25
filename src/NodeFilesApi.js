import FilesApi from "./FilesApi.js";
import getMimeType from "./getMimeType.js";

export default class NodeFilesApi extends FilesApi {
  constructor(options) {
    super(options);
    if (!this.fs) throw new Error("File System is not defined.");
    if (!this.rootDir) throw new Error("Root directory is not defined.");
  }

  get rootDirSegments() {
    if (!this._rootDirSegments) {
      this._rootDirSegments = this._toPathSegments(
        this.options.rootDir || "./",
      );
    }
    return this._rootDirSegments;
  }

  get rootDir() {
    if (!this._rootDir) {
      this._rootDir = this.rootDirSegments.join("/");
    }
    return this._rootDir;
  }

  get fs() {
    return this.options.fs;
  }

  async _init() {
    return this._initialized = this._initialized ||
      (async () => {
        const dirPath = this.rootDir;
        return await mkdir(this.fs, dirPath);
      })();
  }

  async *list(file, { recursive = false } = {}) {
    await this._init();
    const filePath = this._expandPath(file);
    const fileInfo = await this._stats(filePath);
    if (!fileInfo || fileInfo.kind !== "directory") return;
    for await (let f of list(this.fs, filePath, recursive)) {
      yield this._getFileInfo(f.path, f.stat);
    }
  }

  async stats(file) {
    await this._init();
    const filePath = this._expandPath(file);
    return this._stats(filePath);
  }

  async remove(file) {
    await this._init();
    const filePath = this._expandPath(file);
    return await remove(this.fs, filePath);
  }

  async write(file, content) {
    await this._init();
    const filePath = this._expandPath(file);
    const dir = pathDirname(filePath);
    await this.fs.mkdir(dir, { recursive: true });
    let handle;
    try {
      handle = await this.fs.open(filePath, "w");
      if (typeof content === "function") content = content();
      await handle.writeFile(content);
    } finally {
      handle && await handle.close();
    }
  }

  async *read(file, { start = 0, bufferSize = 1024 * 8 } = {}) {
    await this._init();
    const filePath = this._expandPath(file);
    let handle;
    try {
      handle = await this.fs.open(filePath, "r");
      const offset = 0;
      for (let position = start, bytesRead = 0; true; position += bytesRead) {
        const buffer = new Uint8ClampedArray(bufferSize);
        const result = await handle.read(
          buffer,
          offset,
          bufferSize,
          position,
        );
        bytesRead = result.bytesRead;
        if (bytesRead === 0) break;
        yield bytesRead < bufferSize
          ? result.buffer.slice(0, bytesRead)
          : result.buffer;
      }
    } finally {
      handle && await handle.close();
    }
  }

  // TODO:
  // async copy(fromPath, toPath, options = {}) { ... }

  // TODO:
  // async move(fromPath, toPath, options = {}) { ... }

  async _stats(filePath) {
    try {
      const stat = await this.fs.stat(filePath);
      return this._getFileInfo(filePath, stat);
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      return null;
    }
  }

  _getFileInfo(path, stat) {
    const segments = this._toPathSegments(path).slice(
      this.rootDirSegments.length,
    );
    segments.unshift("");
    const name = segments[segments.length - 1];
    path = segments.join("/");
    // const name = path.split("/").filter((s) => !!s).pop() || "";
    let info = {
      path,
      name,
      kind: "",
    };
    if (!stat.isFile()) {
      info.kind = "directory";
    } else {
      info.size = stat.size || 0;
      info.type = getMimeType(path);
      info.kind = "file";
      info.lastModified = new Date(stat.mtime).getTime();
    }
    return info;
  }

  _toPathSegments(filePath) {
    filePath = this.normalizePath(filePath);
    const segments = filePath.split("/"); // .filter((s) => !!s);
    // if (segments.length === 0) segments.push("");
    // segments.unshift("");
    return segments;
  }

  _expandPath(file) {
    const filePath = typeof file === "object" ? file.path : file + "";
    const segments = this._toPathSegments(filePath).filter((s) => !!s);
    // segments.shift(); // The first segment is always empty
    segments.unshift(...this.rootDirSegments);
    return segments.join("/");
  }
}

export function pathDirname(path) {
  const segments = path.split("/");
  segments.pop();
  return segments.join("/");
}

export function pathJoin(...paths) {
  let segments = paths
    .map((path) => path.split("/"))
    .reduce((result, segments) => (result.push(...segments), result), []);
  const firstSegment = segments.shift();
  segments = segments.filter((s) => !!s && s !== ".");
  segments.unshift(firstSegment);
  return segments.join("/");
}

export async function mkdir(fs, dir) {
  try {
    const stat = await fs.stat(dir);
    if (stat && stat.isDirectory()) return true;
  } catch (error) {
    // Just ignore
  }
  const parent = pathDirname(dir);
  if (dir === parent) return false;
  await mkdir(fs, parent);
  await fs.mkdir(dir, { recursive: true });
  return true;
}

export async function remove(fs, path) {
  try {
    let stat = await fs.stat(path);
    if (stat.isDirectory()) {
      for await (let file of list(fs, path, false)) {
        await remove(fs, file.path);
      }
      await fs.rmdir(path);
    } else {
      await fs.unlink(path);
    }
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
}

export async function* list(fs, filePath, recursive) {
  try {
    const stat = await fs.stat(filePath);
    if (stat.isDirectory()) {
      const array = await fs.readdir(filePath);
      for (const name of array.sort()) {
        const f = pathJoin(filePath, name);
        let stat = await fs.stat(f);
        yield { path: f, stat };
        if (recursive && stat.isDirectory()) {
          yield* list(fs, f, true);
        }
      }
    }
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
}
