import type { CssTransform } from "../../types.js";
import { newLightningCssTransform } from "./lightning-css-transform.js";

export { newLightningCssTransform } from "./lightning-css-transform.js";

export function newDefaultCssTransform(): CssTransform {
  return newLightningCssTransform();
}
