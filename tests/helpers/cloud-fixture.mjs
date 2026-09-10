// Real HTTP/authentication/encryption with synthetic platform implementations.
// No platform network calls, credentials, or account browsers are used.
import { createHash } from "node:crypto";
import { createCloudSync } from "../../cloud/server.mjs";

export const CLOUD_TEST_GATEWAY = "browser-test-gateway-secret-never-use-in-production";
export const CLOUD_TEST_PASSWORD = "browser-test-service-password-not-a-real-secret";
const TEST_JPEG = "/9j/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAARCAEAAQADASIAAhEBAxEB/8QAFgABAQEAAAAAAAAAAAAAAAAAAAgH/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/EABQBAQAAAAAAAAAAAAAAAAAAAAD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwDZgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAASOCuBI4CuBI4CuBI4CuAAAABI4CuBI6uAAABI4CuBI4CuBI4CuBI4CuBI6uAAAAAEjq4SOCuASOCuBI4CuEjq4SOCuAAEjq4SOAACuAABI4ACuASOrhI6uABI4CuBI6uASOrhI6uAAAAAEjq4SOCuEjq4SOAACuEjq4SOCuBI6uASOACuBI6uABI4AAArhI6uASOrhI6uASOAArhI6uASOrhI6uAAAAAEjq4SOCuBI4CuBI4CuEjgAAACuAASOACuAEjq4SOCuAASOrhI4CuBI4CuBI4ArhI6uAAAAAASOAACuAASOK4AEjiuASOrhI4CuEjiuASOrgAEjq4AAASOK4SOCuBI4ArgSOCuAAAAAAEjq4SOACuAAAEjq4SOArhI4ACuAAAASOArhI6uAASOAAArhI6uAEjq4AAAAAAAEjq4SOCuAAASOACuAEjq4SOArhI6uAASOCuEjgArgAEjq4SOACuAASOArhI6uAAAAAAAEjq4AAAEjgCuAAEjgCuAAEjq4SOArhI6uAAASOAArgASOAArgAAAAAAAAAEjq4ASOrhI4CuBI6uASOK4ABI4ACuAAASOK4SOArgAAASOACuBI6uASOrgAAAAAAAEjq4SOAACuAABI4ACuAAAASOACuAAAEjgACuAAAAAAAAAEjq4SOAK4ASOK4ASOK4SOAAArhI6uAASOCuEjgArgAEjq4ASOCuASOrgABI6uASOrhI6uAAAAAEjq4SOCuEjq4SOAACuEjq4SOCuEjq4SOCuAAEjq4SOArhI6uAAAEjq4SOArhI6uAASOArhI4ArhI6uAAAAAEjq4SOCuEjq4ASOK4AEjq4SOCuEjgCuBI4AK4AASOArhI6uASOACuBI6uASOK4AEjiuASOrgAAAAAEjq4ASOK4ASOK4ASOK4AEjq4ASOrgAAASOK4ASOK4ASOK4AAAAASOrgASOrgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAf/Z";
const TEST_STORAGE_STATE = { cookies: [{ name: "test-session", value: "synthetic-xhs-session-secret-only", domain: ".xiaohongshu.com", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" }], origins: [] };

export async function createCloudFixture() {
  let cloud;
  let state;
  let loginMode;
  async function reset(options = {}) {
    await cloud?.close();
    loginMode = options.loginMode === "complete" ? "complete" : "waiting";
    state = { verifications: 0, loginStarts: 0, activeRuntimes: 0, closedRuntimes: 0, saves: [] };
    cloud = createCloudSync({
      passwords: { 1: "browser-test-encryption-key-never-use-in-production" },
      accessPassword: CLOUD_TEST_PASSWORD, gatewaySecret: CLOUD_TEST_GATEWAY,
      allowedOrigins: ["https://127.0.0.1:4174"], port: 47832,
      browserFactory: async () => {
        state.activeRuntimes++;
        let closed = false;
        return {
          context: {},
          snapshot: async () => structuredClone(TEST_STORAGE_STATE),
          screenshot: async () => closed ? undefined : `data:image/jpeg;base64,${TEST_JPEG}`,
          close: async () => { if (!closed) { closed = true; state.activeRuntimes--; state.closedRuntimes++; } },
        };
      },
      providers: {
        verifyWechatAccount: async ({ appId }) => { state.verifications++; return { remoteId: appId }; },
        loginXiaohongshu: async ({ signal }) => {
          const number = ++state.loginStarts;
          if (loginMode === "complete") return { remoteId: `synthetic-xhs-${number}`, displayName: "测试创作者" };
          return new Promise((_resolve, reject) => {
            if (signal.aborted) reject(signal.reason);
            else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        },
        saveWechatDraft: save,
        saveXiaohongshuDraft: save,
      },
    });
    await cloud.listen();
  }
  async function save({ account, draft }) {
    // A receipt is impossible unless the real server decoded actual poster PNGs.
    if (!draft.images.length || draft.images.some((image) => image.width !== 1080 || image.height !== 1440 || image.mime !== "image/png" || image.bytes.length < 10000 || image.bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a")) throw new Error("Actual generated poster PNGs were not received");
    state.saves.push({
      accountId: account.id, displayName: account.displayName, platform: account.platform,
      content: { title: draft.title, body: draft.body },
      images: draft.images.map((image) => ({ name: image.name, mime: image.mime, width: image.width, height: image.height, bytes: image.bytes.length, sha256: createHash("sha256").update(image.bytes).digest("hex") })),
    });
    if (account.displayName.includes("待核实")) return { status: "needs_confirmation", message: "测试平台未返回确定结果，请先核对草稿" };
    return { status: "saved", draftId: `test-only-${account.platform}-draft-${state.saves.length}`, message: `测试平台已核对 ${draft.images.length} 张实际 PNG 图片` };
  }
  await reset();
  return {
    reset,
    state: () => structuredClone(state),
    close: () => cloud.close(),
  };
}
