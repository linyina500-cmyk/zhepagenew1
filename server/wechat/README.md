# 公众号贴图草稿服务

这个服务只负责“上传永久图片 → 创建 newspic 贴图草稿 → 读取详情核对”，没有发布、群发或删除操作。它与 Cloudflare 上的折页网页配合使用，可运行在本机 Mac 或固定 IP 服务器上。

当前代码通过模拟微信接口的自动化回归；没有配置真实公众号凭据，尚未完成真实账号验收。名称来自服务配置，连接检查通过官方 token 和草稿总数接口验证权限，不会从接口推断公众号显示名称。

## 免费本机测试（当前采用）

按 [本机使用说明](本机使用说明.md) 双击配置与启动入口。AppID、AppSecret 和独立连接口令仅存放在本机 `.wechat-sync-local/config.env`，任务记录保存在同目录的 `jobs/`；均不提交到 Git，也不进入部署包。

连接路径为 `折页测试网页 → 同域 /api/wechat → 免费 Cloudflare Tunnel → 这台 Mac → 微信官方接口`。同步期间 Mac 必须开机、联网且不休眠。Tunnel 提供进入本机的 HTTPS 地址，不提供固定的微信调用出口；应将本机实际访问微信的公网出口 IP 加入微信白名单，宽带 IP 变化后更新。

先使用无需域名的 Quick Tunnel 验证。每次启动会生成临时服务地址，需更新下面的 Preview 配置并重新部署；它不是稳定的日常服务地址。后续有 Cloudflare 域名时可换成固定名称的 Tunnel，复用同一个本机服务。[Quick Tunnel 官方说明](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)

## 固定 IP 服务器部署（可选）

- 若选择日常不依赖本机开机，准备一台具有固定公网 IPv4 的 Linux 服务器。当前只支持单服务进程、单公众号，一次处理一组素材。
- Node.js 22.18+（22.x）或 24+；服务自身仅使用 Node 内置模块，不需要安装本项目的网页依赖。
- 可持久保存任务记录的磁盘目录。创建后保留至人工完成核对；升级、重启时不可清空。不能运行多个副本或把目录放在容器临时文件系统。
- 一个可配置 HTTPS 的服务域名，例如 `sync.example.com`。普通 Cloudflare Pages 只保存此服务地址；它本身没有可直接用于此部署的专用固定出口 IP。
- 公众号获取稳定调用凭据、永久图片素材上传、新增草稿、草稿详情及草稿总数权限。将实际调用微信的服务器出口 IPv4 加入公众号 IP 白名单。

普通 Cloudflare 与服务组成：`折页网页 → 同域 /api/wechat → 固定 IP 服务 → 微信官方接口`。微信 AppSecret 只放在固定 IP 服务上；不上传到网页、插件或 Cloudflare 前端构建变量。

Cloudflare 当前另有 Workers VPC → Gateway 专用出口路线，但专用出口需要 Zero Trust Enterprise 附加服务，本包没有按此路线部署。[Cloudflare 专用出口说明](https://developers.cloudflare.com/cloudflare-one/traffic-policies/egress-policies/dedicated-egress-ips/)

## 安装

开发机在仓库根目录运行 `npm run pack:wechat`，得到 `dist-wechat/zhepage-wechat-service.tar.gz`。包中只有服务代码、公开说明和空白配置模板，没有凭据。

在服务器创建专用用户 `zhepage`，把包解压到 `/opt/zhepage-wechat`，保持其中 `server/wechat/` 和 `lib/wechat/` 相对结构。创建 `/var/lib/zhepage-wechat`，所有者设为 `zhepage`，权限设为 `700`。

将 `server/wechat/.env.example` 复制到 `/etc/zhepage-wechat.env`，仅在服务器私密填写：

| 配置 | 内容 |
| --- | --- |
| `WECHAT_APP_ID` | 目标公众号 AppID |
| `WECHAT_APP_SECRET` | 目标公众号 AppSecret，不发送到聊天或写入代码 |
| `WECHAT_ACCOUNT_NAME` | 用于网页核对的目标公众号名称，需与 AppID 对应 |
| `WECHAT_SYNC_TOKEN` | 单独生成的 32–256 位随机连接口令；不是 AppSecret；不得有空白 |
| `WECHAT_DATA_DIR` | `/var/lib/zhepage-wechat` |
| `WECHAT_HOST` / `WECHAT_PORT` | 保持 `127.0.0.1` / `8788` |

配置文件权限设为 `600`，由 root 持有；systemd 负责读取。不要在 shell 命令、部署日志或聊天中粘贴真实 AppSecret。随机连接口令也只通过私密方式交给使用者，之后在折页的“公众号连接口令”中填写。

安装 `zhepage-wechat.service` 到 systemd，确认 `ExecStart` 的 Node 路径正确，再启用服务。服务关闭会等待正在处理的任务；异常退出后只读已有记录，不重放创建。日志只输出启动信息，不输出请求头、图片、正文、密钥或带 token 的微信请求地址。

使用 HTTPS 反向代理将服务域名转到 `127.0.0.1:8788`。附带 `Caddyfile.example` 可作为 Caddy 配置起点；替换为你自己的域名，开放必要的 HTTPS/证书验证端口。服务端口 8788 不直接向公网开放。反向代理需允许至少 61 MiB 的请求、120 秒的上传时间，避免完整素材被提前截断。

服务 `GET /api/wechat/account`、所有任务接口都要求连接口令。不要把该口令硬编码进网页，或通过 URL 参数发送。服务不提供跨域访问许可，日常由折页同域 API 转发。

## Cloudflare 配置

只在 **测试分支的 Preview 环境**设置服务端变量 `WECHAT_SYNC_URL=https://你的服务域名`，网址必须是 HTTPS 根地址，不含账号、密码、查询参数或子路径。重新部署测试分支，保留项目 `functions/api/wechat/[[path]].ts`。不要给变量加 `VITE_` 或 `NEXT_PUBLIC_` 前缀。

网页检查连接时会经此路径检查微信权限，并显示配置的名称和 AppID 派生的账号标识。点击同步前后服务会核对同一账号，避免服务器配置换号后误传。

没有配置地址时返回 `503` 和“公众号同步服务尚未配置”。这不是公众号权限问题，也不会触发图片上传。生产分支保持原部署，验收通过前不合并或切换生产。

## 数据及中断恢复

- 全量校验后顺序上传，保留原图字节，不裁剪、转码或截断。最多 20 张，单图 10,000,000 字节，总图 60 MiB。
- 本工具标题上限 20 字；正文同时限制 1,000 个字符和 2,048 UTF-8 字节。这是当前保守限制，官方 newspic 正文上限本轮未直接核实，不将其写成平台硬上限。
- 每次请求先保留本机全部图片和任务编号，再发送；服务持久化编号、内容指纹、已确认图片素材编号和草稿编号。原始图片只在上传期间留于服务内存。
- 重复任务编号只读已有结果；编号对应不同内容时拒绝。创建请求超时、回执缺失或重启中断后均不自动重试创建。
- 有草稿编号时，“重新核对草稿内容”只调用读取接口。无编号的不确定结果需人工去公众号草稿箱核对，不能通过重试自动推断未保存。
- `saved` 仅表示微信详情接口中 newspic 类型、标题、原文和全部图片素材编号顺序匹配。图片实际显示仍需在网页草稿箱人工检查，人工确认单独记录。
- 上传失败可能留下永久图片素材；服务不会擅自删除素材。磁盘写入故障时优先保留进程已知的草稿编号，网页明确提示先修复存储并核对，不能保证断电后保留尚未落盘的编号。

## 真实验收

配置完成后，用一份明确标记为测试的真实多页海报：检查公众号连接，确认名称及账号标识，点击同步，等接口读回核对，再到公众号草稿箱重新打开该条，核对全部图片、顺序、标题及换行。关闭折页重开后检查可读取原任务；重复读取不得新增草稿。全程只存草稿。

如果出现错误码 `40164`，核对服务器实际访问微信时的出口 IP，而非 Cloudflare 网站 IP。使用 IPv4 出口的部署应避免系统优先改走未加白名单的 IPv6。
