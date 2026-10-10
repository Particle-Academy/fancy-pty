import { defineConfig } from "tsup";

export default defineConfig({
    entry: { index: "src/index.ts" },
    // Dual, with `exports.import` first. Measured by `claude · tynn`: genie2's
    // built ESM main bundle leaves packages external, and Node refuses a named
    // import from a CJS package with getter-defined exports -- it hit exactly
    // that on electron-updater. ESM is the shape that works there; CJS is
    // carried for everyone else and costs nothing.
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    clean: true,
    platform: "node",
    // Node builtins stay external. There is nothing else to externalise --
    // this package has no runtime dependencies at all, which is the point.
    external: [/^node:/],
    treeshake: true,
});
