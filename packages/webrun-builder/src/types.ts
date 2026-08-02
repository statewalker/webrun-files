import type { Project } from "../types/project.js";

/** A dataflow signal name (e.g. `"sources"`, `"content"`, `"summarized"`). */
export type SignalName = string;

/** An update a builder emits: "URI `uri` changed on `signal` at stamp `stamp`". */
export interface EmittedUpdate {
  signal: SignalName;
  uri: string;
  stamp: number;
}

/**
 * An un-handled update on one of a builder's input signals, read via
 * `ProjectBuilder.readUpdates`. Call `handled()` once the update has been
 * processed so it does not reappear on the next run.
 */
export interface BuilderUpdate {
  readonly signal: SignalName;
  readonly uri: string;
  readonly stamp: number;
  handled(): Promise<void>;
}

/**
 * A builder handler: reads its input deltas (via `project.requireAdapter(ProjectBuilder)`),
 * processes them, yields output updates for downstream builders, and returns `true` when
 * all upstream updates were handled (no re-run needed) or `false` to request a re-run.
 */
export type BuilderHandler = (
  project: Project,
) => AsyncGenerator<EmittedUpdate, boolean | undefined>;

/** A builder registered on a `ProjectBuilder`. */
export interface RegisteredBuilder {
  id: string;
  inputs: readonly SignalName[];
  outputs: readonly SignalName[];
  handler: BuilderHandler;
}

/** An adapter that contributes builders to a project's pipeline (its "nature"). */
export interface BuilderProvider {
  builders(): readonly RegisteredBuilder[];
}

/** Progress event yielded by `ProjectBuilder.run`. */
export type BuildProgress =
  | { type: "begin"; transactionId: number }
  | { type: "call"; transactionId: number; builderId: string; result: boolean }
  | { type: "end"; transactionId: number };

/** Per-builder status snapshot. */
export interface BuilderStatus {
  id: string;
  /** Count of un-handled updates across this builder's input signals. */
  pending: number;
  /** The builder's last successful transaction id (`0` if never run). */
  lastTransaction: number;
}

export interface BuildStatus {
  nextTransactionId: number;
  builders: BuilderStatus[];
}
