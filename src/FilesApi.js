import normalizePath from "./normalizePath.js";
import notImplemented from "./notImplemented.js";

/*
 * FileInfo
 * - `kind` - (`file`|`directory`) kind of the returned entity
 * - `name` - the local name of this file entry (the last segment of the path)
 * - `path` - path to the file from the root of the "file system"
 * - `type` - an optional mime type of the file content; it is not defined for directories
 * - `size` - size of the file (only for files)
 * - `lastModified` - modification time as a long integer
 */

/**
 * This is a common interface providing access to methods dealing with files.
 */
export default class FilesApi {
  constructor(options) {
    this.options = options || {};
  }

  /**
   * Returns an async generator providing information about files (FileInfo[]).
   * Paths corresponding to directories has the "/" trailing symbol.
   * @param {Object|String} file path to the folder or an object returned by the `list` or `info` methods
   * @param {Object} options optional parameters
   * @param {Boolean} options.recursive this flag defines if the returned generator
   * should give access to all child directories and files or just direct children
   * @return {AsyncGenerator<FileInfo>} generator returning information about
   * individual file entries
   */
  async *list(file, options = {}) {
    yield notImplemented(file, options);
  }

  /**
   * Returns information about an individual file.
   * @param {Object|String} file path to the file or an object returned by
   * the `list` or `info` methods
   * @return {FileInfo} information about the file corresponding to the specified
   * path or null if there is no such a file
   */
  async stats(file) {
    return notImplemented(file);
  }

  /**
   * Removes file or folder corresponding to the specified path.
   * All children of this entry will be removed as well.
   * @param {Object|String} file path to the file to remove or an object
   * returned by the `list` or `info` methods
   * @return {Boolean} return true if the file was removed
   */
  async remove(file) {
    return notImplemented(file);
  }

  /**
   * Creates and returns a write stream for the file with the specified path.
   * @param {Object|String} file path to the file or an object returned by
   * the `list` or `info` methods
   * @param {AsyncGenerator|AsyncIterator} content async generator function providing the binary
   * file content to store
   * @return {any} result of the action execution
   */
  async write(file, content) {
    return notImplemented(file, content);
  }

  /**
   * Creates an returns an AsyncIterator returning byte blocks with the file content.
   * @param {Object|String} file path to the file or an object returned by
   * the `list` or `info` methods
   * @param {object} options read parameters
   * @param {number} options.start starting read position; default value is 0
   * @param {number} options.bufferSize the optional size of returned chunks buffers
   */
  async *read(file, options) {
    yield notImplemented(file, options);
  }

  /**
   * Copies a file from one path to another.
   * @param {String} fromPath path to the source file
   * @param {String} toPath path to the target file
   * @param {Object} options additional options
   * @param {Store} options.recursive if this flag is true then subfolders are also copied
   * @param {Store} options.target optional target store where data should be copied
   * @return {Boolean} if the file was successfully copied
   */
  async copy(source, target, options = {}) {
    const doCopy = async (sourcePath, targetPath, sourceFile) => {
      const suffix = sourceFile.path.substring(sourcePath.length);
      targetPath = `${targetPath}${suffix}`;
      const content = this.read(sourceFile);
      return await this.write(targetPath, content);
    };
    const recursive = options.recursive === undefined || !!options.recursive;
    const sourceFile = await this.stats(source);
    if (sourceFile.kind === "directory") {
      for await (const file of this.list(source, { ...options, recursive })) {
        if (file.kind === "directory") continue;
        await doCopy(source, target, file);
      }
    } else {
      await doCopy(source, target, sourceFile);
    }
    return true;
  }

  /**
   * Moves files from the initial position to the target path.
   * The default implementation creates a new file copy in the new location
   * and removes the old file.
   *
   * @param {String} fromPath path to the source file
   * @param {String} toPath path to the target file
   * @param {Object} options additional options
   * @param {Store} options.target optional target store where data should be moved
   * @return {Boolean} if the file was successfully moved
   */
  async move(fromPath, toPath, options = {}) {
    if (!await this.copy(fromPath, toPath, options)) return false;
    await this.remove(fromPath);
    return true;
  }

  normalizePath(file) {
    let filePath = typeof file === "object" ? file.path : file + "";
    return normalizePath(filePath);
  }
}

