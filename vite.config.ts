import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import vinext from "vinext";
import { cloudflare } from "@cloudflare/vite-plugin";
import { workersCacheCdnAdapter } from "@vinext/cloudflare/cache/workers-cache-cdn-adapter";

// Prisma's generated client lists the `node` export condition before `workerd`, so the Worker
// build would pick the Node build (which reads the query-compiler wasm with fs). Point it at the
// workerd build, which imports the wasm as a module.
const prismaClient = (file: string) =>
  fileURLToPath(new URL(`./node_modules/.prisma/client/${file}`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^\.prisma\/client\/default$/, replacement: prismaClient("wasm.js") },
      { find: /^#main-entry-point$/, replacement: prismaClient("wasm.js") },
      { find: /^#wasm-compiler-loader$/, replacement: prismaClient("wasm-worker-loader.mjs") },
    ],
  },
  plugins: [
    vinext({
      cache: { cdn: workersCacheCdnAdapter() },
    }),
    cloudflare({
      viteEnvironment: {
        name: "rsc",
        childEnvironments: ["ssr"],
      },
    }),
  ],
});
