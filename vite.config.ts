import { defineConfig } from "vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";

export default defineConfig({
  plugins: [
    nodePolyfills({
      globals: { global: true, Buffer: true, process: true },
    }),
  ],
  define: {
    global: "globalThis",
  },
  build: {
    commonjsOptions: {
      transformMixedEsModules: true,
    },
  },
});
