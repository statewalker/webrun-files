import BrowserFilesApi from "./BrowserFilesApi.js";

export async function openBrowserFilesApi({
  handlerKey = "root-dir",
  readwrite = true,
  // Methods below could be replaced by persistent implementation
  // using the "idb-keyval" package (methods "get", "set", "del").
  index = {},
  get = async (key) => index[key],
  set = async (key, handler) => index[key] = handler,
  del = async (key) => delete index[key],
} = {}) {
  let rootHandler = await get(handlerKey);
  if (!rootHandler) {
    rootHandler = await window.showDirectoryPicker();
    await set(handlerKey, rootHandler);
  }
  if (!(await verifyPermission(rootHandler, readwrite))) {
    throw new Error("Access was not granted");
  }
  if (!(await isHandlerAccessible(rootHandler))) {
    // await set(handlerKey, null);
    await del(handlerKey);
    throw new Error("Can not access to the folder. Please try again.");
  }
  return new BrowserFilesApi({ rootHandler });
}

export async function isHandlerAccessible(fileHandle) {
  // We need to perform a real read operation with the handler
  // to check if the file/directory still exists.
  let exists = false;
  try {
    if (fileHandle.kind === "file") {
      await fileHandle.getFile();
    } else {
      for await (let item of fileHandle.values()) {
        break;
      }
    }
    exists = true;
  } catch (error) {
    console.log(error, fileHandle);
    exists = false;
  }
  return exists;
}

export async function verifyPermission(fileHandle, readWrite) {
  const options = {};
  if (readWrite) {
    options.mode = "readwrite";
  }
  let granted = false;
  // Check if permission was already granted. If so, return true.
  if ((await fileHandle.queryPermission(options)) === "granted") {
    granted = true;
  }
  // Request permission. If the user grants permission, return true.
  if (
    !granted && (await fileHandle.requestPermission(options)) === "granted"
  ) {
    granted = true;
  }
  // The user didn't grant permission, so return false.
  return granted;
}
