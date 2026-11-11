import type { FilesRpcErrorCode } from "./types.js";

/**
 * An error of the protocol itself. The code also leads the message (`UNKNOWN_STREAM: …`), since
 * a structured clone keeps an error's name and message but not its other properties:
 * `errorCode(e)` reads it back on the other side of a transport.
 */
export class FilesRpcError extends Error {
  readonly code: FilesRpcErrorCode;
  constructor(code: FilesRpcErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "FilesRpcError";
    this.code = code;
  }
}

/** The FilesRpcError code of an error, also after it crossed a transport; undefined otherwise. */
export function errorCode(e: unknown): FilesRpcErrorCode | undefined {
  const code = (e as { code?: unknown })?.code;
  if (typeof code === "string") return code as FilesRpcErrorCode;
  const m = /^(UNKNOWN_STREAM|CHUNK_RELEASED|TOO_MANY_STREAMS|ABORTED|INVALID):/.exec(
    String((e as Error)?.message ?? ""),
  );
  return m?.[1] as FilesRpcErrorCode | undefined;
}
