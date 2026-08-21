import { cp, rename, rm } from "node:fs/promises";

await rename("dist-pages/pages-entry/index.html", "dist-pages/index.html");
await rm("dist-pages/pages-entry", { recursive: true, force: true });

// Pages reads Functions from the project-level /functions directory during deployment.
// Public assets are already copied by Vite; this file only normalizes the root index.
await cp("public/_headers", "dist-pages/_headers");
