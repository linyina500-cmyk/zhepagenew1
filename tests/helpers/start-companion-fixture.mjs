// Isolated browser-test server. All platform providers below are synthetic;
// this fixture never launches an account browser or calls a remote platform.
import { mkdtemp, rm } from "node:fs/promises";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { createCompanion } from "../../companion/server.mjs";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "zhepage-browser-helper-"));
const helper = await createCompanion({
  dataDir, token: "browser-test-pairing-code-only-not-a-real-secret",
  allowedOrigins: ["http://127.0.0.1:4173"],
  browserFactory: async () => {
    const context = new EventEmitter();
    context.close = async () => { context.emit("close"); };
    return context;
  },
  providers: {
    loginXiaohongshu: async ({ signal }) => new Promise((_resolve, reject) => {
      if (!signal) { reject(new Error("The simulated login requires a cancellation signal")); return; }
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
    verifyWechatAccount: async ({ appId }) => ({ remoteId: appId }),
    saveWechatDraft: async ({ draft }) => {
      if (!draft.images.length || draft.images.some((image) => image.width !== 1080 || image.height !== 1440 || image.mime !== "image/png" || image.bytes.length < 10000)) throw new Error("Actual poster PNGs were not received");
      return { status: "saved", draftId: "test-only-verified-draft", message: `测试环境已收到并核对 ${draft.images.length} 张 PNG 图片`, url: "https://mp.weixin.qq.com/" };
    },
  },
});
await helper.listen();
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await helper.close();
  await rm(dataDir, { recursive: true, force: true });
  process.exit(0);
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
