#!/bin/zsh

cd -- "${0:A:h}" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

if [[ "$(uname -s)" != "Darwin" ]] || (( ${$(sw_vers -productVersion)%%.*} < 14 )); then
  print "此启动包需要 macOS 14 或更新版本。"
  read "?按回车键关闭窗口。"
  exit 1
fi

if ! command -v node >/dev/null 2>&1 || ! node -e 'var v=process.versions.node.split(".").map(Number);process.exit((v[0]===22&&v[1]>=18)||v[0]>=24?0:1)' >/dev/null 2>&1; then
  print "首次使用需要安装 Node.js 24 或更新版本。"
  print "在即将打开的官网下载 macOS 安装包，按提示安装后，再双击本文件。"
  print "下载地址：https://nodejs.org/zh-cn/download"
  open "https://nodejs.org/zh-cn/download"
  read "?安装完成后可关闭此窗口，再双击“启动折页.command”。按回车键关闭。"
  exit 1
fi

node companion/launch.mjs
launcher_status=$?
if (( launcher_status != 0 )); then
  print "请保留上面的提示；修复后再次双击即可，不需要输入命令。"
  read "?按回车键关闭窗口。"
fi
exit $launcher_status
