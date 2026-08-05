import { transform as sucraseTransform } from "sucrase";
import type { SourceFormat } from "../types.js";

/**
 * Strip TS/JSX to plain JS (leave already-ESM/CJS JS untouched). Shared by the
 * ESM transform and the specifier scanner so both see the *same* JS — raw TS/JSX
 * cannot be parsed directly (acorn throws on JSX). JSX uses the automatic
 * runtime, so scanning the output also surfaces the `react/jsx-runtime` import
 * the runtime injects.
 */
export function toJs(
  source: string,
  format: SourceFormat,
  path?: string,
  production = false,
): string {
  if (format === "ts" || format === "tsx") {
    const transforms: ("typescript" | "jsx")[] =
      format === "tsx" ? ["typescript", "jsx"] : ["typescript"];
    // `production` selects the JSX runtime: prod → `jsx()` from `react/jsx-runtime`,
    // dev → `jsxDEV()` from `react/jsx-dev-runtime`. It MUST match the NODE_ENV the
    // globals shim injects (browser defaults to "production"; see `defaultGlobals`),
    // or React crashes at render on a dev-JSX / prod-react-dom mismatch.
    return sucraseTransform(source, {
      transforms,
      jsxRuntime: "automatic",
      production,
      filePath: path,
    }).code;
  }
  return source;
}
