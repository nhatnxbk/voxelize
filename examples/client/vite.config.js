import path from "path";

import glsl from "vite-plugin-glsl";
import { replaceCodePlugin } from "vite-plugin-replace";

/** @type {import('vite').UserConfig} */
export default {
  optimizeDeps: {
    force: true,
  },
  plugins: [
    glsl(),
    replaceCodePlugin({
      replacements: [
        {
          from: "__VOXELIZE_VERSION__",
          to: "(dev)",
        },
      ],
    }),
  ],
  resolve: {
    alias: {
      // hacky way to point to styles.css
      "@voxelize/core/styles.css": path.resolve(
        __dirname,
        "../../packages/core/src/styles.css"
      ),
      "@voxelize/core": path.resolve(
        __dirname,
        "../../packages/core/src/index.ts"
      ),
      "@voxelize/physics-engine": path.resolve(
        __dirname,
        "../../packages/physics-engine/src/index.ts"
      ),
      "@voxelize/aabb": path.resolve(
        __dirname,
        "../../packages/aabb/src/index.ts"
      ),
      "@voxelize/raycast": path.resolve(
        __dirname,
        "../../packages/raycast/src/index.ts"
      ),
      "@voxelize/protocol": path.resolve(
        __dirname,
        "../../packages/protocol/src/index.ts"
      ),
    },
  },
};
