export type FileOperation = "read" | "write" | "remove" | "move" | "copy" | "list" | "mkdir";

export interface FileGuard {
  /** Which filesystem operations this guard intercepts. */
  operations: FileOperation[];
  /** Returns true to allow, false to deny. */
  check: (path: string) => boolean;
  /** Error message when access is denied. */
  message?: string;
}
