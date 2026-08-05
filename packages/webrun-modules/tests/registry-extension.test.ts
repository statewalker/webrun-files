import { writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import type { PreprocessContext, RegisteredTransform } from "../src/preprocess/context.js";
import { preprocessModule } from "../src/preprocess/module.js";
import { newDefaultTransformRegistry } from "../src/preprocess/registry.js";

/** The registry's raison d'être: a sibling registers a transform for a new input
 *  type and `preprocessModule` dispatches to it — with NO change to the engine
 *  (`module.ts`), the walk, or the build cells. `tailwind-css` is the one non-default
 *  fine type the sniffer produces, so it is the exact trigger for a "new type". */
describe("transform registry — custom transform for a new type (no engine change)", () => {
  it("preprocessModule invokes a newly-registered tailwind-css transform", async () => {
    const files = new MemFilesApi();
    await writeText(files, "/t.css", "@tailwind base;");

    const transforms = newDefaultTransformRegistry(); // registers only module + css
    let invoked = false;
    const sentinel: RegisteredTransform = {
      inType: "tailwind-css",
      outType: "css",
      async run(_id, source) {
        invoked = true;
        return { code: `/*SENTINEL*/${source}`, emittedId: "/~/t.js" };
      },
    };
    transforms.register(sentinel); // the ONLY engine touch — a public registry call

    // Minimal ctx: preprocessModule only reads `files` (loadRaw) + `transforms` (dispatch)
    // before delegating to the entry; the sentinel ignores the rest.
    const ctx = { files, transforms } as unknown as PreprocessContext;

    const out = await preprocessModule("~/t.css", ctx);

    expect(invoked).toBe(true); // the sniff → registry dispatch reached the custom entry
    expect(out.code).toBe("/*SENTINEL*/@tailwind base;"); // and its output is returned verbatim
  });

  it("without the registration, the same content falls back to the css entry (no throw)", async () => {
    const files = new MemFilesApi();
    await writeText(files, "/t.css", "@tailwind base;");
    const transforms = newDefaultTransformRegistry(); // no tailwind-css entry
    expect(transforms.has("tailwind-css")).toBe(false);
    // coarseBucket("tailwind-css") === "css", which IS registered — so no missing-entry throw.
    expect(transforms.has("css")).toBe(true);
  });
});
