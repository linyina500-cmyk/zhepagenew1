// HTTPS is necessary to exercise the production Secure, HttpOnly service cookie.
// The private cloud service behind this gateway uses only synthetic providers.
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { preview } from "vite";
import { createCloudFixture, CLOUD_TEST_GATEWAY } from "./cloud-fixture.mjs";

const certificateDir = await mkdtemp(path.join(os.tmpdir(), "zhepage-test-https-"));
let server;
let cloud;
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  server?.httpServer.closeAllConnections?.();
  if (server) await new Promise((resolve) => server.httpServer.close(resolve));
  await cloud?.close();
  await rm(certificateDir, { recursive: true, force: true });
}

try {
  const keyPath = path.join(certificateDir, "key.pem");
  const certPath = path.join(certificateDir, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1", "-keyout", keyPath, "-out", certPath], { stdio: "ignore" });
  cloud = await createCloudFixture();
  server = await preview({
    configFile: "vite.pages.config.ts",
    logLevel: "warn",
    plugins: [{ name: "isolated-cloud-fixture-control", configurePreviewServer(previewServer) {
      previewServer.middlewares.use(async (request, response, next) => {
        if (!request.url?.startsWith("/__cloud-test/")) { next(); return; }
        response.setHeader("Content-Type", "application/json");
        response.setHeader("Cache-Control", "no-store");
        try {
          if (request.url === "/__cloud-test/reset" && request.method === "POST") {
            const chunks = []; let size = 0;
            for await (const chunk of request) { size += chunk.length; if (size > 1024) throw new Error("Invalid fixture options"); chunks.push(chunk); }
            await cloud.reset(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
          } else if (request.url !== "/__cloud-test/state" || request.method !== "GET") { response.writeHead(404); response.end("{}"); return; }
          response.end(JSON.stringify(cloud.state()));
        } catch { response.writeHead(500); response.end(JSON.stringify({ error: "Fixture control failed" })); }
      });
    } }],
    preview: {
      host: "127.0.0.1", port: 4174, strictPort: true, open: false,
      https: { key: await readFile(keyPath), cert: await readFile(certPath) },
      proxy: { "/api/sync": { target: "http://127.0.0.1:47832", headers: { "X-Sync-Gateway": CLOUD_TEST_GATEWAY } } },
    },
  });
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { void stop().finally(() => process.exit(0)); });
} catch (error) {
  await stop();
  throw error;
}
