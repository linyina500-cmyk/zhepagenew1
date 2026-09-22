#!/bin/sh
set -u

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 1
NODE_BIN=""
for candidate in /usr/local/bin/node /opt/homebrew/bin/node; do
  if [ -x "$candidate" ]; then NODE_BIN="$candidate"; break; fi
done
if [ -z "$NODE_BIN" ]; then NODE_BIN=$(command -v node 2>/dev/null || true); fi

pause_window() {
  if [ -t 0 ]; then printf '\n按回车关闭这个窗口。'; IFS= read -r finish_line || true; fi
}
if [ -z "$NODE_BIN" ] || ! "$NODE_BIN" -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (!(major >= 24 || major === 22 && minor >= 18)) process.exit(1);' 2>/dev/null; then
  printf '未找到可用的 Node.js。需要 Node.js 24，或 22.18 以上的 22 版；请先安装，再双击本文件。\n'
  pause_window
  exit 1
fi

"$NODE_BIN" "$SCRIPT_DIR/local-setup.mjs"
setup_status=$?
pause_window
exit "$setup_status"
