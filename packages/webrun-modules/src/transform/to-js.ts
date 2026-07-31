import { transform as sucraseTransform } from "sucrase";
import type { SourceFormat } from "../types.js";

/**
 * Strip TS/JSX to plain JS (leave already-ESM/CJS JS untouched). Shared by the
 * ESM transform and the specifier scanner so both see the *same* JS — raw TS/JSX
 * cannot be parsed directly (acorn throws on JSX). JSX uses the automatic
 * runtime, so scanning the output also surfaces the `react/jsx-runtime` import
 * the runtime injects.
 */
export function toJs(source: string, format: SourceFormat, path?: string): string {
  if (format === "ts" || format === "tsx") {
    const transforms: ("typescript" | "jsx")[] =
      format === "tsx" ? ["typescript", "jsx"] : ["typescript"];
    return sucraseTransform(source, { transforms, jsxRuntime: "automatic", filePath: path }).code;
  }
  return source;
}
