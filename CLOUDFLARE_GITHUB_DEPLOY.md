# Cloudflare Pages + GitHub 部署设置

## 上传 GitHub

1. 解压本发布包。
2. 把解压后的所有文件上传到 GitHub 仓库根目录。
3. 确认仓库根目录能直接看到 `package.json`、`package-lock.json`、`app/`、`functions/` 和 `public/`，不要在外面再套一层 `zhepage` 文件夹。
4. 必须同时覆盖 `package.json` 和 `package-lock.json`。本包的锁文件已经使用 Cloudflare 日志中的 npm 10.9.2 重建并通过 `npm ci` 验证，不能继续保留旧锁文件。

## Cloudflare Pages 构建设置

- Framework preset：None
- Root directory：留空
- Build command：`npm run build:pages`
- Build output directory：`dist-pages`
- Node.js version：22

保存后重新部署最新 GitHub 提交。

## 部署后检查

打开网站后测试文章链接导入。如果接口已正确部署：

- `POST /api/import` 不再返回 405。
- `/api/image?url=...` 不再回退为首页 HTML。
- 富文本导入会自动识别首行标题和章节结构。

## 重要说明

Cloudflare 控制台的 ZIP 拖拽部署不会编译 `functions/` 文件夹，因此本项目必须使用 GitHub 集成，或者从项目根目录使用 Wrangler 部署。仅上传 `dist-pages` 会让界面可打开，但文章链接和远程图片读取都会失败。
