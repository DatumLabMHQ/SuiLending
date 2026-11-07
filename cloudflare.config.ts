import { bindings, defineConfig, defineWorker } from "cf/config";
import { createWorkersCacheConfig } from "@vinext/cloudflare/cache/config";

const cache = await createWorkersCacheConfig();

export default defineConfig({
  accountId: "c9bf3d8e875ffe933a9bf895695e0fd1", // Datum Labs
  worker: defineWorker({
    ...cache,
    name: "suilending",
    entrypoint: "vinext/server/fetch-handler",
    compatibilityDate: "2026-11-05",
    compatibilityFlags: ["nodejs_compat"],
    assets: {
      htmlHandling: "none",
      notFoundHandling: "none",
      runWorkerFirst: ["/*", "!/_next/static/*", "!/*/_next/static/*"],
    },
    env: {
      ...cache.env,
      ASSETS: bindings.assets(),
      // Plain (non-secret) settings. Secrets (DATABASE_URL, PLATFORM_READ_URL, CRON_SECRET,
      // SUI_GRPC_*, BLOCKVISION_API_KEY, BEEHIIV_*, SETNEL_*) are Worker secrets, not here.
      // This copy (formerly Vercel `sui-lending-datum`) reads the Datum data platform.
      DATA_SOURCE: bindings.text("platform"),
    },
  }),
});
