import { describe, expect, it } from "vitest";
import { newDefaultTransform } from "../src/transform/index.js";
import { toJs } from "../src/transform/to-js.js";

const JSX = `export const A = () => <div className="x" />;`;

/**
 * The automatic JSX runtime must match the `process.env.NODE_ENV` the globals shim
 * injects. For the browser target that shim defaults to "production", so the JSX
 * must compile to the PRODUCTION runtime (`react/jsx-runtime`, `jsx()`), not the
 * development one (`react/jsx-dev-runtime`, `jsxDEV()`). A dev-JSX + prod-react-dom
 * mix crashes React at render (`Cannot read properties of undefined (reading 'S')`).
 */
describe("JSX runtime mode (dev/prod consistency)", () => {
  it("toJs emits the PRODUCTION jsx runtime when production=true", () => {
    const out = toJs(JSX, "tsx", "/a.tsx", true);
    expect(out).toContain('"react/jsx-runtime"');
    expect(out).not.toContain("jsx-dev-runtime");
  });

  it("toJs emits the DEV jsx runtime when production is unset (default)", () => {
    const out = toJs(JSX, "tsx", "/a.tsx");
    expect(out).toContain('"react/jsx-dev-runtime"');
  });

  it("newDefaultTransform(true) threads production to the JSX transform", async () => {
    const { code } = await newDefaultTransform(true).transform(
      { path: "/a.tsx", source: JSX, format: "tsx" },
      (s) => s,
    );
    expect(code).toContain("react/jsx-runtime");
    expect(code).not.toContain("jsx-dev-runtime");
  });
});
