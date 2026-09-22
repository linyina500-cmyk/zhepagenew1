# 小红书本机草稿服务

入口为 `createXhsBrowserDriver({ profileDir })`、`await createXhsService({ dataDir, driver })` 和 `createXhsHandler({ service })`。HTTP 处理器交给共享服务器鉴权，使用同一本机连接口令。服务与驱动初始化均不启动浏览器；用户检查连接或打开登录窗口时，才用本机已安装的 Google Chrome 启动专属持久 profile。运行前需安装 Chrome 和项目的 Playwright 运行依赖，无需另行下载 Playwright 附带的浏览器；不会使用日常 Chrome 的用户资料目录。

本实现只处理草稿，不提供发表或定时发表操作。原始 PNG/JPEG 字节先落到任务目录，再通过浏览器原生 `setInputFiles` 按顺序上传。账号首次由页面中的稳定用户 ID 绑定；之后每次任务必须使用同一账号。账号身份无法确认时停止，不根据昵称猜测身份。

任务目录在任何平台写入前持久保留。已有编号永不重复上传或暂存；服务中断、缺少回执或核对失败均记录为待核对。用户明确确认已在专用浏览器核对后，可调用 `acknowledge(id)` 结束该任务；该动作只改变本机记录，仍保留 `needs_confirmation`，不会伪装为程序已验证保存。新任务仍会检查编辑器是否为空。

`service.lock` 防止两个本机服务并发操作同一 profile。正常退出会删除锁。异常退出时锁保持原样，不能自动清除：先确认原服务和专用浏览器均已退出，再由维护人员核对记录并移除锁文件；旧任务在重新启动后只允许核对，不恢复写入。每个 profile 必须仅由对应的一个 `dataDir` 服务管理，不得把不同服务配置到同一 profile。

## 真实验收尚未完成

以下选择器与证据规则是保守的实现约束，**未在当前真实账号验证**：

- 账号：创作者页面 `header` 或 `[role=banner]` 中唯一的 `www.xiaohongshu.com/user/profile/<24位ID>` 链接及名称。没有该链接时返回身份待确认，不能只用右上角昵称替代稳定 ID。
- 草稿箱：唯一的“草稿箱(n)”入口；需完整读到与总数一致的原生草稿编辑链接。草稿 ID 必须来自链接中的 `draft_id/draftId/note_id/noteId`，不会使用标题作为草稿唯一标识。
- 图片：`.img-preview-area .pr`，原生处理遮罩已结束且编辑控制已挂载；正文使用 `.tiptap.ProseMirror`。这些编辑器选择器来自此前适配器，但本机 Playwright 流程仍需实机验收。
- 暂存：唯一且可用的“暂存离开”或“存草稿”按钮，只点击一次。
- 回读：重新打开同一草稿链接，标题和正文完全一致；图片数量与顺序一致，每张图片实际加载成功，且完整远程 URL 与保存前记录一致。只有 blob 预览、链接变化、图片损坏或条目身份不明确时均保留待核对。不会猜测 CDN 转换规则或把 200/提示语当作图片已保存。

单元测试使用假浏览器驱动和 DOM fixtures，覆盖原图、账号绑定、同编号防重、进程锁、单任务锁、不确定结果、人工结束及回读顺序校验。它们不证明真实平台保存成功，也不证明此前 CDN 400/ORB 问题已解决。

## 接口

- `GET /api/xiaohongshu/account` → `{ account: { id, name } }`
- `POST /api/xiaohongshu/login` → `{ opened: true }`；扫码由用户完成。
- `POST /api/xiaohongshu/jobs`，multipart 字段 `id/title/body/expectedAccountId/images` → `{ job }`
- `GET /api/xiaohongshu/jobs/:id` → `{ job }`
- `POST /api/xiaohongshu/jobs/:id/verify` → `{ job }`，只回读。
- `POST /api/xiaohongshu/jobs/:id/acknowledge`，JSON 严格为 `{ "confirm": true }` → `{ job }`，只记录人工结束。

公共任务状态为 `uploading/creating/saved/needs_confirmation/failed`；另有独立 `acknowledged` 布尔值。返回值不包含原始图片路径、正文、浏览器 profile、Cookie 或远程图片 URL。
