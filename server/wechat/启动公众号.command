#!/bin/sh
set -u

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 1
PROJECT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd) || exit 1
CONFIG_PATH="$PROJECT_DIR/.wechat-sync-local/config.env"
NODE_BIN=""
for candidate in /usr/local/bin/node /opt/homebrew/bin/node; do
  if [ -x "$candidate" ]; then NODE_BIN="$candidate"; break; fi
done
if [ -z "$NODE_BIN" ]; then NODE_BIN=$(command -v node 2>/dev/null || true); fi

pause_window() {
  if [ -t 0 ]; then printf '\n按回车关闭这个窗口。'; IFS= read -r finish_line || true; fi
}
if [ ! -f "$CONFIG_PATH" ] || [ -L "$CONFIG_PATH" ]; then
  printf '尚未找到本机私密配置。请先双击同一文件夹中的“配置公众号.command”。\n'
  pause_window
  exit 1
fi
if [ -z "$NODE_BIN" ] || ! "$NODE_BIN" -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (!(major >= 24 || major === 22 && minor >= 18)) process.exit(1);' 2>/dev/null; then
  printf '未找到可用的 Node.js。需要 Node.js 24，或 22.18 以上的 22 版；请先安装，再双击本文件。\n'
  pause_window
  exit 1
fi

printf '正在启动本机公众号草稿服务和 Cloudflare Tunnel。请保持这个窗口打开。\n'
printf '关闭窗口或按 Control+C 可停止服务；临时连接地址还需要接入折页预览网页。\n'
# The supervisor owns service/tunnel startup and shutdown. Only its file path
# is passed to Node; no credential is loaded or printed by this shell entry.
exec "$NODE_BIN" "$SCRIPT_DIR/local-start.mjs"
