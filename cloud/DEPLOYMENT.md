# 私有网页同步服务部署

本配置面向单个拥有者的开发测试服务。前端继续放在 Cloudflare Pages；`/api/sync/*` 经同站点网关转发到一台固定公网出口 IP 的 Linux 云服务器。服务器临时运行 Playwright，并调用微信官方接口。网盘、纯静态托管和普通 Pages Functions 不能替代该运行环境。

## 运行条件

- 已有或另行准备的 Linux 云服务器，Docker Engine 与 Compose，能访问微信官方 API 和小红书创作者站点。容器限制 2 CPU、3 GiB 内存，主机需留出系统与反向代理空间。
- 固定公网出口 IP，用于公众号 API 白名单；如果经过 NAT，以真正出口地址为准。
- 受管理员控制的 HTTPS 域名和反向代理，转发到服务器 `127.0.0.1:47832`。不要把该端口直接开放到公网。
- 主机支持 Chromium 用户命名空间沙箱；保留非 root 用户、seccomp 和 `no-new-privileges`。先通过下文运行环境检查，不通过时排查主机策略，不用关闭浏览器沙箱规避。
- 若要求临时登录资料不进入主机交换文件，应禁用该主机的 swap，或使用合适的加密交换空间。本项目不能替主机配置作保证。

官方 [Playwright Docker 说明](https://playwright.dev/docs/docker) 将此镜像定位于开发和测试。这里固定 `v1.63.0-noble`，与项目依赖一致；当前交付不代表公开多租户生产运行审计。

## 构建与私密文件

在服务器项目根目录执行：

```bash
docker build -f cloud/Dockerfile -t zhepage-sync:development .
sudo node cloud/init-secrets.mjs /etc/zhepage-sync-secrets
```

初始化要求父目录已存在，目标为仓库外的全新绝对路径。脚本生成三个随机私密文件，拒绝覆盖，不输出密钥值：

| 文件 | 用途 |
| --- | --- |
| `keys.json` | 版本化主密钥，例如结构为 `{ "1": "至少32字节随机值" }`。 |
| `access-password` | 网页服务登录口令，通过私密渠道交给拥有者。 |
| `gateway-secret` | Cloudflare 网关与云端之间的独立随机密钥。 |

用 `docker run --rm --entrypoint id zhepage-sync:development -u` 核对镜像中的 `pwuser` UID，再把私密目录及文件的拥有者设为该 UID。目录权限保持 0700，文件保持 0600 或 0400；不要放宽为其他用户可读。妥善保存主密钥备份，丢失主密钥后无法使用现有浏览器授权包。

复制 `cloud/.env.example` 为忽略提交的 `cloud/.env`，只填写非秘密部署设置：固定测试网址、拥有者标识和私密文件目录。不要把密钥、服务口令、AppSecret 或平台登录资料写入仓库、命令行参数、构建参数或日志。构建上下文采用文件白名单，不包含 `.env` 或私密目录。

## 环境检查与启动

先用合成状态检查浏览器；该检查禁止网络，不会访问真实平台：

```bash
docker run --rm --init --read-only --network=none \
  --tmpfs /tmp:rw,nosuid,nodev,size=1073741824,mode=1777 \
  --tmpfs /home/pwuser:rw,nosuid,nodev,size=16777216,mode=1777 \
  --shm-size=1g --memory=3g --cpus=2 --pids-limit=512 --ulimit core=0 \
  --security-opt no-new-privileges:true \
  --security-opt seccomp=cloud/seccomp_profile.json \
  zhepage-sync:development node cloud/check-runtime.mjs

docker compose --env-file cloud/.env -f cloud/compose.yaml up -d
```

容器根文件系统只读，浏览器临时目录与主页目录为 tmpfs；不挂载账号数据库、浏览器档案或素材目录。清理临时浏览器失败时服务退出，由容器重启释放会话。退出后需核对未完成草稿，不会自动补发。

HTTPS 反向代理只需把同步域名的 `/api/sync/*` 转发到 `127.0.0.1:47832`，其他路径返回 404。允许最大 94 MiB 请求与至少 120 秒读取超时，关闭请求体、Cookie、响应体和查询参数日志。不要配置登录重定向；前端网关会拒绝上游跳转。保留正常 TLS 证书校验。

## 连接 Cloudflare 测试环境

在 Cloudflare Pages 项目的 **Preview** 环境配置：

| 配置 | 值 |
| --- | --- |
| `SYNC_SERVICE_URL` | 同步服务的 HTTPS origin，例如 `https://sync.example.com`，不能带路径、查询串或账号密码。 |
| `SYNC_GATEWAY_SECRET` | 与服务器 `gateway-secret` 一致的值，以 Cloudflare secret 保存。 |

不要把这些配置加到前端公开变量；不要更新 Production 环境。重新部署开发分支后 `/api/sync/*` 才会使用配置。服务器 `SYNC_ALLOWED_ORIGINS` 必须与用户使用的固定测试网站 origin 完全一致；默认是 `https://feature-local-draft-sync.zhepagenew.pages.dev`。新生成的短期预览域名不自动加入白名单。

浏览器只访问前端同站点 API，服务 Cookie 为 `__Host-`、HttpOnly、Secure、SameSite=Strict。网关注入服务端密钥与 Cloudflare 确认的客户端 IP，不转发浏览器伪造的网关身份。云端再次校验网关、网页来源与 CSRF。服务只有一个配置的拥有者，持有服务口令的人共享该身份；不适合给不同用户分发共同口令。

## 首次验收

1. 打开固定测试网址，确认“同步草稿”可连接服务，错误口令被拒绝。
2. 连接自有测试公众号，把服务器固定出口 IP 加入白名单；发送少量合成图片，并在公众号后台核对草稿。
3. 连接自有测试小红书账号，验证网页能显示扫码入口、取消可关闭临时会话；再测试暂存及跨会话草稿是否存在。如果平台要求当前截图界面不能处理的交互，停止并记录，不把它当作同步成功。
4. 分别验证勾选/不勾选记住、刷新、授权失效、断线后的待核实提示和人工核对。确认后再增加账号与真实内容。

代码和模拟 CI 不能替代上述真实平台验收。普通用户操作方式及资料生命周期见 [DRAFT_SYNC.md](../DRAFT_SYNC.md)。

## 密钥轮换与撤销

`iron-session` 负责认证加密：当前依赖使用 AES-256-CBC 与 HMAC 完整性校验，并非自行实现加密算法。会话与平台授权从主密钥派生不同用途的密钥。

轮换时在 `keys.json` 增加更大的正整数版本键并重启服务。新授权包使用最高编号，保留旧键可继续解密旧包。账号包最长 30 天；完成过渡后停用旧键会要求尚未更新的浏览器重新连接。紧急撤销可直接停用旧键，并在平台撤销登录/重置授权；删除浏览器授权包或退出服务只清理当前副本，不会撤销其他已复制的有效副本。

轮换访问口令、网关密钥与主密钥是三个不同操作。服务无持久撤销名单、账号数据库或任务账本；重启后依赖浏览器待核实记录避免误重试，不宣称跨所有设备的永久去重。
