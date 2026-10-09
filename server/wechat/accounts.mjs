import { createHash } from "node:crypto";
import { createWechatApi } from "../../lib/wechat/api.mjs";
import { createJobService, RequestError } from "./jobs.mjs";
import { createPublicationService } from "./publications.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");
export const ACCOUNT_ID = /^[a-f0-9]{20}$/;

// The browser owns persistent credentials. This process keeps connected API
// clients only in memory; job files contain content and receipts, never secrets.
export function createAccountRegistry({ dataDir, syncToken, apiFactory = createWechatApi }) {
  const deviceId = digest(`zhepage-device:${syncToken}`).slice(0, 32);
  const sessions = new Map();
  const connecting = new Map();

  function get(id) {
    if (!ACCOUNT_ID.test(id || "")) throw new RequestError("公众号标识无效");
    const session = sessions.get(id);
    if (!session) throw new RequestError("请在这台设备的浏览器中重新连接该公众号", 409);
    return session;
  }

  return {
    deviceId,
    busy: () => connecting.size > 0 || [...sessions.values()].some(({ jobs, publications }) => jobs.busy() || publications.busy()),
    list: () => [...sessions.values()].map(({ jobs }) => jobs.account),
    get,
    async connect(input) {
      if (!input || typeof input !== "object" || Array.isArray(input)
        || Object.keys(input).some((key) => !["appId", "appSecret", "name", "deviceId"].includes(key))) throw new RequestError("公众号连接信息不完整");
      if (input.deviceId !== deviceId) throw new RequestError("连接的不是原来绑定的电脑，请检查本机连接设置", 409);
      const { appId, appSecret, name } = input;
      if (typeof appId !== "string" || !/^wx[a-zA-Z0-9]{16}$/.test(appId)
        || typeof appSecret !== "string" || !/^[a-zA-Z0-9]{32}$/.test(appSecret)
        || typeof name !== "string" || !name.trim() || [...name].length > 40 || /[\r\n\0]/u.test(name)) throw new RequestError("请填写有效的 AppID、AppSecret 和公众号名称");
      const id = digest(appId).slice(0, 20);
      if (connecting.has(id)) throw new RequestError("正在检查这个公众号的连接，请稍候", 409);
      if (!sessions.has(id) && sessions.size + connecting.size >= 30) throw new RequestError("这台电脑同时连接的公众号已达 30 个，请先断开不使用的账号", 409);
      connecting.set(id, true);
      try {
        const fingerprint = digest(`${appId}\0${appSecret}`);
        const previous = sessions.get(id);
        if (previous && previous.fingerprint === fingerprint && previous.jobs.account.name === name.trim()) {
          await previous.api.checkConnection();
          return previous.jobs.account;
        }
        if (previous && (previous.jobs.busy() || previous.publications.busy())) throw new RequestError("该公众号仍在处理任务，请完成后再更新连接", 409);
        const api = apiFactory({ appId, appSecret });
        await api.checkConnection();
        // Another request may have begun a job while credential validation
        // awaited WeChat. Keep the original session until that work finishes.
        if (sessions.get(id) !== previous || (previous && (previous.jobs.busy() || previous.publications.busy()))) {
          throw new RequestError("该公众号仍在处理任务，请完成后再更新连接", 409);
        }
        const jobs = createJobService({ dataDir, appId, accountName: name.trim(), api });
        const publications = createPublicationService({ dataDir, accountId: id, api, jobs });
        sessions.set(id, { api, jobs, publications, fingerprint });
        return jobs.account;
      } finally { connecting.delete(id); }
    },
    disconnect(id) {
      if (!ACCOUNT_ID.test(id || "")) throw new RequestError("公众号标识无效");
      const session = sessions.get(id);
      if (connecting.has(id) || (session && (session.jobs.busy() || session.publications.busy()))) throw new RequestError("该公众号仍在处理任务，完成后才能断开", 409);
      sessions.delete(id);
    },
    async idle() { await Promise.allSettled([...sessions.values()].flatMap(({ jobs, publications }) => [jobs.idle(), publications.idle()])); },
  };
}
