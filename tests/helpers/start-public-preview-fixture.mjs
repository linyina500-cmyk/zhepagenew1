// Serve the real Pages build over HTTPS so the online onboarding and ZIP
// download use a real network response, without routing a synthetic domain.
// This process is only used by the isolated browser test runner.
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { preview } from "vite";

const certificateDir = await mkdtemp(path.join(os.tmpdir(), "zhepage-test-https-"));
let server;
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  server?.httpServer.closeAllConnections?.();
  if (server) await new Promise((resolve) => server.httpServer.close(resolve));
  await rm(certificateDir, { recursive: true, force: true });
}

try {
  const keyPath = path.join(certificateDir, "key.pem");
  const certPath = path.join(certificateDir, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1", "-keyout", keyPath, "-out", certPath], { stdio: "ignore" });
  server = await preview({
    configFile: "vite.pages.config.ts",
    logLevel: "warn",
    preview: { host: "127.0.0.1", port: 4174, strictPort: true, open: false, https: { key: await readFile(keyPath), cert: await readFile(certPath) } },
  });
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { void stop().finally(() => process.exit(0)); });
} catch (error) {
  await stop();
  throw error;
}
