import FilesApi from "./FilesApi.js";
import getMimeType from "./getMimeType.js";

export default class BrowserFilesApi extends FilesApi {
  constructor(options) {
    super(options);
    if (!this.rootHandler) {
      throw new Error("Root directory handler is not defined");
    }
  }

  get rootHandler() {
    return this.options.rootHandler;
  }

  async *list(file, { recursive = false } = {}) {
    const segments = this._getPathSegments(file);
    const handle = await this._getHandler(segments, false);
    const that = this;
    if (handle.kind === "directory") {
      yield* listChildren(segments, handle, recursive);
    }

    async function* listChildren(segments, dirHandle, recursive) {
      for await (const handle of dirHandle.values()) {
        yield await that._getFileInfo([...segments, handle.name], handle);
        if (recursive && handle.kind == "directory") {
          yield* listChildren(
            [...segments, handle.name],
            handle,
            recursive,
          );
        }
      }
    }
  }

  async stats(file) {
    const segments = this._getPathSegments(file);
    const handle = await this._getHandler(segments, false);
    return handle ? await this._getFileInfo(segments, handle) : null;
  }

  async remove(file) {
    let segments = this._getPathSegments(file);
    const name = segments.pop();
    const parentHandle = await this._getHandler(segments, false);
    const toRemove = [];
    if (name) {
      toRemove.push(name);
    } else {
      for await (const childHandle of parentHandle.values()) {
        toRemove.push(childHandle.name);
      }
    }
    for (const name of toRemove) {
      await parentHandle.removeEntry(name, { recursive: true });
    }
    return true;
  }

  async write(file, content) {
    const segments = this._getPathSegments(file);
    const fileHandle = await this._getFileHandler(segments);
    const writable = await fileHandle.createWritable(); // Write the contents of the file to the stream.
    try {
      if (typeof content === "function") content = content();
      for await (let block of content) {
        await writable.write(block.buffer ? block.buffer : block); // Close the file and write the contents to disk.
      }
    } finally {
      await writable.close();
    }
  }

  async *read(file /* { start = 0, bufferSize = 1024 * 8 } = {} */) {
    const segments = this._getPathSegments(file);
    const fileHandle = await this._getFileHandler(segments, false);
    if (!fileHandle) return;
    const fileData = await fileHandle.getFile();
    const stream = fileData.stream();
    const reader = stream.getReader();
    try {
      let chunk;
      while ((chunk = await reader.read()) && !chunk.done) {
        yield chunk.value;
      }
    } finally {
      reader.cancel && reader.cancel();
      // stream.cancel && stream.cancel();
    }
  }

  // TODO:
  // async copy(fromPath, toPath, options = {}) { ... }

  // TODO:
  // async move(fromPath, toPath, options = {}) { ... }

  async _getHandler(segments, create = false) {
    let handle;
    try {
      handle = await this._getFileHandler(segments, create);
    } catch (e) {
      try {
        handle = await this._getDirectoryHandler(segments, create);
      } catch (e) {
        // Just ignore it
      }
    }
    return handle;
  }

  async _getDirectoryHandler(segments, create = true) {
    segments = [...segments];
    let dirHandle = this.rootHandler;
    for (let directoryName of segments) {
      dirHandle = await dirHandle.getDirectoryHandle(directoryName, { create });
    }
    return dirHandle;
  }

  async _getFileHandler(segments, create = true) {
    segments = [...segments];
    const filename = segments.pop();
    let dirHandle = this.rootHandler;
    for (let directoryName of segments) {
      dirHandle = await dirHandle.getDirectoryHandle(directoryName, {
        create: true,
      });
    }
    const fileHandler = await dirHandle.getFileHandle(filename, { create });
    return fileHandler;
  }

  async _getFileInfo(segments, handle) {
    segments = [...segments];
    const name = segments[segments.length - 1];
    segments.unshift("");
    const path = segments.join("/");
    const info = {
      kind: "",
      path,
      name,
    };
    if (handle.kind === "directory") {
      info.kind = "directory";
    } else {
      info.kind = "file";
      const file = await handle.getFile();
      info.size = file.size;
      info.type = getMimeType(path);
      info.lastModified = file.lastModified;
    }
    return info;
  }

  _getPathSegments(file) {
    let filePath = typeof file === "object" ? file.path : file + "";
    // filePath = this.normalizePath(filePath);
    const segments = filePath.split("/").filter((s) => !!s);
    return segments;
  }
}
