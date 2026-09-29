import { timingSafeEqual } from "node:crypto";
import { createConnection, createServer } from "node:net";

const maximumMessage = 2048;
function authentic(actual, expected) {
  if (typeof actual !== "string") return false;
  const left = Buffer.from(actual), right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

// Named pipes have no TCP listener. Authentication is still required: another
// local user must not stop this user's drafts or learn their readiness state.
export async function createWindowsControl({ pipePath, token, status, stop }) {
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.setTimeout(5000, () => socket.destroy());
    let input = "", handled = false;
    socket.on("data", async (chunk) => {
      if (handled) return;
      input += chunk.toString("utf8");
      if (Buffer.byteLength(input) > maximumMessage) { handled = true; socket.destroy(); return; }
      if (!input.includes("\n")) return;
      handled = true;
      let request;
      try { request = JSON.parse(input.slice(0, input.indexOf("\n"))); } catch { socket.end('{"ok":false}\n'); return; }
      if (!request || typeof request !== "object" || Array.isArray(request) || !authentic(request.token, token) || !["status", "stop"].includes(request.action)) { socket.end('{"ok":false}\n'); return; }
      try {
        const state = await status();
        if (request.action === "status") { socket.end(`${JSON.stringify({ ok: true, pid: process.pid, ready: state?.ready === true })}\n`); return; }
        if (!state || typeof state.busy !== "boolean") { socket.end('{"ok":false,"reason":"unknown"}\n'); return; }
        if (state.busy) { socket.end('{"ok":false,"reason":"busy"}\n'); return; }
        // Acceptance must not depend on the peer finishing its pipe read. On
        // Windows the client can receive the ACK before end's callback runs.
        // Start the graceful shutdown first; the owner keeps this pipe alive
        // until its service has drained, which the controller checks below.
        stop();
        socket.end('{"ok":true}\n');
      } catch { socket.end('{"ok":false,"reason":"unknown"}\n'); }
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(pipePath, () => { server.off("error", reject); resolve(); }); });
  return { close: () => new Promise((resolve) => { for (const socket of sockets) socket.destroy(); server.close(resolve); }) };
}

export function windowsControlRequest({ pipePath, token, action, timeoutMs = 5000 }) {
  return new Promise((resolve) => {
    const socket = createConnection(pipePath);
    let input = "", finished = false;
    const finish = (result) => { if (finished) return; finished = true; if (result === null) socket.destroy(); else socket.end(); resolve(result); };
    socket.setTimeout(timeoutMs, () => { socket.destroy(); finish(null); });
    socket.on("error", () => finish(null));
    socket.on("connect", () => socket.write(`${JSON.stringify({ token, action })}\n`));
    socket.on("data", (chunk) => {
      input += chunk.toString("utf8");
      if (Buffer.byteLength(input) > maximumMessage) return finish(null);
      if (!input.includes("\n")) return;
      try { finish(JSON.parse(input.slice(0, input.indexOf("\n")))); } catch { finish(null); }
    });
    socket.on("end", () => finish(null));
  });
}

export async function startWindowsAssistant({ inspect, launch, ready, pause, attempts = 30 }) {
  let state = await inspect();
  if (!state) { await launch(); return; }
  for (let index = 0; index < attempts; index++) {
    if (state.ok && state.pid && state.ready && await ready(state.pid)) return;
    await pause(); state = await inspect();
    if (!state) throw new Error("助手未能启动，请重新打开助手。");
  }
  throw new Error("助手还在准备中，请稍后重新连接，请勿重复启动多个窗口。");
}

export async function stopWindowsAssistant({ inspect, requestStop, pause, attempts = 60 }) {
  if (!(await inspect())) return true;
  const result = await requestStop();
  if (!result?.ok) throw new Error(result?.reason === "busy" ? "正在同步内容，请等待任务完成后再停止助手。" : "暂时无法确认同步状态，请稍后再停止助手。");
  for (let index = 0; index < attempts; index++) {
    if (!(await inspect())) return true;
    await pause();
  }
  return false;
}
