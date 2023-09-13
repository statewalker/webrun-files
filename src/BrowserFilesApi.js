import FilesApi from "./FilesApi.js";
import getMimeType from "./getMimeType.js";

/**
 * Stateless adapter for the "File and Directory Entries API".
 * See https://developer.mozilla.org/en-US/docs/Web/API/File_and_Directory_Entries_API
 *
 * ## File and Directory Entries API
 * The File and Directory Entries API simulates a local file system
 * this web apps can navigate within and access files in. You can
 * develop apps which read, write, and create files and/or directories
 * in a virtual, sandboxed file system.
 */
class AdapterForFilesAndDirectoryEntriesApi {
  static canApply(handle) {
    return ((handle?.isDirectory || handle?.isFile) &&
      (typeof handle?.name === "string"));
  }

  async *listDirectoryChildren(handle) {
    let dirReader = handle.createReader();
    while (true) {
      const list = await new Promise((resolve, reject) =>
        dirReader.readEntries(resolve, reject)
      );
      if (!list.length) break;
      yield* list;
    }
  }

  isDirectoryHandle(handle) {
    return handle?.isDirectory;
  }
  isFileHandle(handle) {
    return handle?.isFile;
  }

  async getSubdirectoryHandle(dirHandle, directoryName, create) {
    return new Promise((resolve, reject) =>
      dirHandle.getDirectory(
        directoryName,
        { create },
        resolve,
        reject,
      )
    );
  }

  async getFileHandle(dirHandle, fileName, create = true) {
    return new Promise((resolve, reject) =>
      dirHandle.getFile(
        fileName,
        { create },
        resolve,
        reject,
      )
    );
  }

  async removeDirectoryEntry(dirHandle, handle) {
    return new Promise((resolve, reject) => handle.remove(resolve, reject));
  }

  async getFile(handle) {
    const file = await new Promise((resolve, reject) =>
      handle.file(resolve, reject)
    );
    return file;
  }

  async getFileWriteStream(handle) {
    throw new Error("Not implemented");
  }
}

/**
 * Stateless adapter for the "File System API" and "File System Access API".
 * See:
 * - https://developer.mozilla.org/en-US/docs/Web/API/File_System_API
 * - https://wicg.github.io/file-system-access/
 */
class AdapterForFileSystemApi {
  static canApply(handle) {
    return (handle?.kind === "file" || handle?.kind === "directory");
  }

  async *listDirectoryChildren(handle) {
    yield* handle.values();
  }

  isDirectoryHandle(handle) {
    return handle?.kind === "directory";
  }
  isFileHandle(handle) {
    return handle?.kind === "file";
  }

  async getSubdirectoryHandle(dirHandle, directoryName, create) {
    return await dirHandle.getDirectoryHandle(directoryName, { create });
  }

  async getFileHandle(dirHandle, fileName, create = true) {
    return await dirHandle.getFileHandle(fileName, { create });
  }

  async removeDirectoryEntry(dirHandle, handle) {
    return await dirHandle.removeEntry(handle.name, { recursive: true });
  }

  async getFile(handle) {
    return await handle.getFile();
  }

  async getFileWriteStream(handle) {
    return await handle.createWritable(); // Write the contents of the file to the stream.
  }
}

export default class BrowserFilesApi extends FilesApi {
  constructor(options) {
    super(options);
    if (!this.rootHandle) {
      throw new Error("Root directory handle is not defined");
    }
    if (!this.adapter) {
      throw new Error(
        "Can not define a browser adapter for the specified root handle",
      );
    }
  }

  get rootHandle() {
    return this.options.rootHandle || this.options.rootHandler;
  }

  get adapter() {
    if (!this._adapter) {
      const handle = this.rootHandle;
      let adapter = AdapterForFilesAndDirectoryEntriesApi.canApply(handle)
        ? new AdapterForFilesAndDirectoryEntriesApi()
        : AdapterForFileSystemApi.canApply(handle)
        ? new AdapterForFileSystemApi()
        : null;
      this._adapter = adapter;
    }
    return this._adapter;
  }

  async *list(file, { recursive = false } = {}) {
    const segments = this._getPathSegments(file);
    const handle = await this._getHandle(segments);
    if (!handle) return;
    const that = this;
    if (this.adapter.isDirectoryHandle(handle)) {
      // yield await this._getFileInfo(segments, handle);
      yield* listChildren(segments, handle, recursive);
    }

    async function* listChildren(segments, dirHandle, recursive) {
      for await (const handle of that._listDirectoryContent(dirHandle)) {
        yield await that._getFileInfo([...segments, handle.name], handle);
        if (recursive && that.adapter.isDirectoryHandle(handle)) {
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
    const handle = await this._getHandle(segments);
    return handle ? await this._getFileInfo(segments, handle) : null;
  }

  async remove(file) {
    const doRemove = async (dirHandle, handle) => {
      let result = true;
      if (this.adapter.isDirectoryHandle(handle)) {
        const children = [];
        for await (let child of this.adapter.listDirectoryChildren(handle)) {
          children.push(child);
        }
        for (let child of children) {
          result = result && await doRemove(handle, child);
        }
      }
      if (dirHandle) {
        result &= await this.adapter.removeDirectoryEntry(dirHandle, handle);
      }
      return result;
    };

    const segments = this._getPathSegments(file);
    const handle = await this._getHandle(segments);
    segments.pop();
    const dirHandle = await this._getHandle(segments);
    return doRemove(dirHandle !== handle ? dirHandle : null, handle);
  }

  async write(file, content) {
    const segments = this._getPathSegments(file);
    const fileName = segments.pop();
    const dirHandle = await this._getDirectoryHandle(segments, true);
    const fileHandle = await this.adapter.getFileHandle(
      dirHandle,
      fileName,
      true,
    );
    const writable = await this.adapter.getFileWriteStream(fileHandle);
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

    const fileName = segments.pop();
    const dirHandle = await this._getDirectoryHandle(segments, false);
    const fileHandle = await this.adapter.getFileHandle(
      dirHandle,
      fileName,
      false,
    );
    if (!fileHandle) return;
    const fileData = await this.adapter.getFile(fileHandle);
    const stream = fileData.stream();
    const reader = stream.getReader();
    try {
      let chunk;
      while (chunk = await reader.read()) {
        if (chunk.done) break;
        yield await chunk.value;
      }
    } finally {
      await reader.cancel && reader.cancel();
      // stream.cancel && stream.cancel();
    }
  }

  // TODO:
  // async copy(fromPath, toPath, options = {}) { ... }

  // TODO:
  // async move(fromPath, toPath, options = {}) { ... }

  // ---------------------------------------------------------
  // Private methods

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
    if (this.adapter.isDirectoryHandle(handle)) {
      info.kind = "directory";
    } else {
      info.kind = "file";

      const file = await this.adapter.getFile(handle);
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

  async _getHandle(segments) {
    const parentDirSegments = [...segments];
    const name = parentDirSegments.pop();
    const create = false;
    try {
      const dirHandle = await this._getDirectoryHandle(
        parentDirSegments,
        create,
      );
      try {
        if (!name) return dirHandle;
        return await this.adapter.getSubdirectoryHandle(
          dirHandle,
          name,
          create,
        );
      } catch (error) {
        return await this.adapter.getFileHandle(dirHandle, name, create);
      }
    } catch (error) {
      return undefined;
    }
  }

  async _getDirectoryHandle(segments, create = true) {
    segments = [...segments];
    let dirHandle = this.rootHandle;
    for (let directoryName of segments) {
      dirHandle = await this.adapter.getSubdirectoryHandle(
        dirHandle,
        directoryName,
        create,
      );
      if (!dirHandle) break;
    }
    return dirHandle;
  }

  async *_listDirectoryContent(handle) {
    let entries = [];
    for await (const entry of this.adapter.listDirectoryChildren(handle)) {
      entries.push(entry);
    }
    entries = entries.sort((a, b) => b.name > a.name ? 1 : -1);
    yield* entries;
  }
}
