// Use the importable runtime types rather than global worker declarations:
// Cloudflare's HTMLRewriter Element must not replace the browser DOM Element.
declare module "cloudflare:workers" {
  export const env: typeof import("@cloudflare/workers-types/2023-07-01").CloudflareWorkersModule.env & {
    DB?: import("@cloudflare/workers-types/2023-07-01").D1Database;
  };
}
