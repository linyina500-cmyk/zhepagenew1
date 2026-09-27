# 小红书本机草稿服务

入口为 `createXhsBrowserDriver({ profileDir })`、`await createXhsService({ dataDir, driver })` 和 `createXhsHandler({ service })`。HTTP 处理器交给共享服务器鉴权，使用同一本机连接口令。服务与驱动初始化均不启动浏览器；用户检查连接或打开登录窗口时，才用本机已安装的 Google Chrome 启动专属持久 profile。运行前需安装 Chrome 和项目的 Playwright 运行依赖，无需插件或另行下载 Playwright 附带的浏览器；不会使用日常 Chrome 的用户资料目录。启动明确启用 `chromiumSandbox: true`，不关闭 Chrome 沙箱。

本实现只处理草稿，不提供发表或定时发表操作。原始 PNG/JPEG 字节先落到任务目录，再通过浏览器原生 `setInputFiles` 按顺序上传。账号首次由创作首页显式展示的“小红书账号”标识绑定；之后每次任务必须使用同一标识。账号身份无法确认或标识发生变化时停止，不根据昵称猜测身份。

**此链路保存的是当前专用浏览器里的本地草稿，不是小红书云端草稿。** 草稿依赖这台电脑的专用 profile；不会自动出现在手机或其他浏览器中。不要清理或替换该 profile 来恢复待核对任务。

登录从创作平台 `/login` 进入，扫码窗口持续保持可见。返回状态为 `connected`（已确认账号）、`login_required`（可见登录表单或二维码，等待用户扫码）、`needs_attention`（页面未加载完成或已有编辑内容需要处理）。加载遮罩或只有“登录”文字不算可用登录页；失败不会显示“已打开”或冒充连接成功。

账号读取使用同一持久浏览器会话内的临时首页，结束后关闭临时页，保留原编辑器及其内容。首页初始化、同源跳转及执行上下文重建共用最多 30 秒的预算；页面关闭或离开平台立即停止读取。每次关键账号核对均重新读取，不复用先前的成功结果。提交检查绑定后，驱动在准备内容、写入前、暂存前和重新打开草稿后核对当前账号；服务层不再重复打开首页。唯一可见账号卡 `.home-card-wrapper .personal .base .text` 内，`.account-name` 提供名称，`.others.description-text > div` 中严格以“小红书账号:”或“小红书账号：”开头的独立字段提供标识。该结构已于 2026-09-22 通过真实首页的可见 DOM 确认；不依赖编辑器顶部的昵称或用户主页链接。

任务目录在任何平台写入前持久保留。已有编号永不重复上传或暂存；服务中断、缺少回执或核对失败均记录为待核对。用户明确确认已在专用浏览器核对后，可调用 `acknowledge(id)` 结束该任务；该动作只改变本机记录，仍保留 `needs_confirmation`，不会伪装为程序已验证保存。新任务仍会检查编辑器是否为空。

`service.lock` 防止两个本机服务并发操作同一 profile。正常退出会删除锁。异常退出时锁保持原样，不能自动清除：先确认原服务和专用浏览器均已退出，再由维护人员核对记录并移除锁文件；旧任务在重新启动后只允许核对，不恢复写入。每个 profile 必须仅由对应的一个 `dataDir` 服务管理，不得把不同服务配置到同一 profile。

## 真实验收尚未完成

完整保存流程**尚未在当前真实账号验收通过**。以下列出选择器与证据规则的核对情况：

- 账号：上述首页账号卡结构、真实登录和临时页账号读取已核对。没有唯一可见账号卡或明确标识时返回身份待确认，不要求已登录用户重复扫码。
- 草稿箱：从唯一的“草稿箱(n)”入口进入“图文笔记(n)”标签，弹窗已打开时复用现有标签。读取 `.draft-item[data-draft-type="image"][data-draft-id]` 原生卡片，要求数量与图文草稿总数一致、ID 无重复。保存后用本次新增的唯一 ID 和标题定位回执，草稿身份来自 `data-draft-id`，不使用标题或链接代替 ID。
- 图片：读取 `.img-preview-area .pr` 中可见的最外层卡片，原生处理遮罩已结束且编辑控制已挂载；正文使用 `.tiptap.ProseMirror`。每追加一张图片，就在该边界记录图片原始解码尺寸与 RGBA 像素的 SHA-256，按顺序保留 `pixels:<宽>x<高>:<哈希>`。临时 blob URL 或 HTTPS 地址不作为持久图片身份；跨域画布污染、解码失败、图片变化或无法读取指纹时保持待核对，不降级为 URL 比较。指纹读取最多 18 张，单张最多 20M 像素、单边不超过 16,384，逐张处理并释放画布。
- 暂存：当前原生 `xhs-publish-btn` 使用 closed shadow root。验证唯一可见宿主、`is-save-draft=true`、`save-text=暂存离开`、`save-disabled=false` 后，仅调用一次原生 `_onSave()`。官方组件 `project-publish-components.c6f26def.js` 中该方法只派发 `save` 事件；不调用发布方法、不猜测替代 handler。保存后等待平台自动打开图文草稿箱，避免与异步抽屉遮罩竞争点击。
- 回读：回执为 `{ kind: "local", id, images }`，不含草稿 URL。从同一原生 ID 的卡片点击“编辑”，重新核对账号，等待图片处理完成后比较完整标题、正文及有序像素指纹。数量、顺序、像素或尺寸不一致，图片损坏或条目身份不明确时均保留待核对。不会把请求成功、暂存提示或相同标题当作草稿已验证。

前端持续读取进行中的任务，直到服务完成、用户取消等待或单次请求失败；自动回读期间仍为 `creating`，不会因超过 90 秒提前要求用户核对。关闭弹窗不取消已提交的后台任务，重新读取会继续等待最终结果。

2026-09-27 实机验收：两张 900×1200 原图按序自动导入、标题与换行配文核对、原生暂存及唯一新增草稿 ID 读取均通过。重新打开后，平台生成的 `sns-creator-preview.xhscdn.com` 签名图片地址返回 HTTP 400，两图无法解码，因此正确保留 `needs_confirmation`。另用网页原生按钮手动上传、保存的单图草稿重开也复现坏图。当前账号/环境下完整同步尚未通过验收，不可宣称图片显示问题已修复；不以修改图片 URL、清空 profile 或重复上传规避。

单元测试使用假浏览器驱动和 DOM fixtures，覆盖原图、账号绑定、同编号防重、进程锁、单任务锁、不确定结果、人工结束、原生保存事件、像素指纹及回读顺序校验。这些测试和模拟平台的浏览器回归不能代替上述真实验收。

## 接口

- `GET /api/xiaohongshu/account` → `{ account: { id, name } }`
- `POST /api/xiaohongshu/login` → `{ status: "connected", account }`、`{ status: "login_required", message }` 或 `{ status: "needs_attention", message }`；扫码由用户完成。
- `POST /api/xiaohongshu/jobs`，multipart 字段 `id/title/body/expectedAccountId/images` → `{ job }`
- `GET /api/xiaohongshu/jobs/:id` → `{ job }`
- `POST /api/xiaohongshu/jobs/:id/verify` → `{ job }`，只回读。
- `POST /api/xiaohongshu/jobs/:id/acknowledge`，JSON 严格为 `{ "confirm": true }` → `{ job }`，只记录人工结束。

公共任务状态为 `uploading/creating/saved/needs_confirmation/failed`；另有独立 `acknowledged` 布尔值。返回值不包含原始图片路径、正文、浏览器 profile、Cookie 或远程图片 URL。
