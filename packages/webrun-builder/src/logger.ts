/**
 * Minimal structural logger the build engine writes to. Host-agnostic: any object
 * with these four methods satisfies it (a host's own structured logger, `console`,
 * etc.), so `webrun-builder` needs no logging dependency. `debug` is required — the
 * engine calls it unconditionally while advancing/scanning stages.
 */
export interface Logger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  debug(...args: unknown[]): void;
}

/** A no-op `Logger`, the default when none is injected. */
export const NULL_LOGGER: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};
