export type CellId = string;
export type Signal = string;

export interface CellDefinition {
  id: CellId;
  inputs: Signal[];
  outputs: Signal[];
}
