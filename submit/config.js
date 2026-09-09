/**
 * Frontend config. After deploying the Worker, set API_BASE to its URL.
 * Local Pages preview can point at `wrangler dev` (http://127.0.0.1:8787).
 */
export const CONFIG = {
  // Set this to your deployed Worker URL from `cd worker && npx wrangler deploy`
  // Example: "https://retcomm-catalog-submit.<account>.workers.dev"
  API_BASE: "https://retcomm-catalog-submit.technicallycomputers.workers.dev",
  // Local: "http://127.0.0.1:8787"
  CATALOG_REPO: "RetroPortingToolKit/Retro-Catalog",
  SCHEMA_URL: "../SCHEMA.md",
};
