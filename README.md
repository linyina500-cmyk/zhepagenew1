# 折页

把公众号文章、HTML 或富文本自动拆成适合小红书和公众号发布的一张张长文贴图，并提供可视化编辑、完整分页、实时预览和批量导出。

## 主要功能

- 导入微信公众号及其他公开网页文章
- 粘贴 HTML、富文本，或把 Markdown 单向转换为富文本
- 尽量保留原文的标题、颜色、强调、引用、图片和卡片结构
- 按小红书 3:4、公众号 4:5、竖版 9:16 自动分页
- 支持“标题 + 正文”同页或独立封面；5 套版式可与全部主题配色自由组合
- 支持标题、粗斜体、下划线、删除线、引用、两种高亮、列表和对齐等完整排版
- 统一颜色面板支持选中文字单独设置字色和多色高亮，也可调整整套页面配色
- 所有编辑器按钮均有悬停功能说明，格式可再次点击取消
- 支持前空行、手动分页、本地插图、图片缩放/对齐/圆角/图注与删除、横线删除
- 导入的表格会保留结构和样式，并可在富文本编辑器中继续修改
- 超长表格按行分页，并在续页重复表头，不再把单元格压成连续文字
- 长段落使用 DOM 深克隆保真的智能拆分，切点位于行内样式内部时，续页仍保留粗斜体、字色、高亮、下划线与删除线
- 标题自动与下一段保持同页，并优先拆分下一段填补普通正文页留白
- 支持后台页面平衡检测、自动优化分页、页码跳转、预览缩放和三档排版密度；检测结果不在成图界面叠加标签
- 支持不调用 AI API 的“一键自动排版”，自动整理导语、章节标题、结语、关键数据、重点句、结构段、空段、图片和表格，并把识别后的结构同步回富文本编辑器
- 粘贴完整富文本或 Markdown 时自动识别首行标题；导入来源切换后会清除上一来源遗留的失败提示
- 支持“基础样式 / 美化后”即时对照；切换排版不会覆写富文本原文和手动设置的颜色
- 独立设置正文页眉与图片左下角文案，两处品牌文字互不混用
- 自定义配色与风险提示可自由命名并保存到当前浏览器
- 支持插入 PDF 刊物领取卡和末页风险提示
- 自动将正文、主题、尺寸、品牌文案等编辑记录保存在当前浏览器
- 支持单页 PNG 和全部页面 ZIP 下载，文件名自动标注小红书、公众号或竖屏 9:16
- 首屏优先加载静态外壳；导出库、富文本编辑器和后续预览页按需加载

第一次使用请阅读 [使用说明.md](使用说明.md)。

开发分支新增本机草稿同步：支持账号选择、两平台独立文案、图片调整、尺寸提醒和设备本地存档。公众号使用官方图片草稿接口，小红书使用独立窗口适配并保留人工核对。启动方式、开源来源和验证边界见 [DRAFT_SYNC.md](DRAFT_SYNC.md)。

自动排版的中文阅读层级参考了 [doocs/md](https://github.com/doocs/md)、[Markdown Nice](https://github.com/mdnice/markdown-nice) 与 [wechat-format](https://github.com/lyricat/wechat-format) 的公开设计思路，并按贴图分页场景重新实现。V4 提供“小红书爆款、财经深度长文、数据指数型、极简新闻型、重点卡片型”5 套结构版式；版式只管理信息层级，主题只管理颜色，两者可以独立切换。

## 本地运行

需要 Node.js 22.18+（22.x）或 24+。

```bash
npm install
npm run dev
```

浏览器访问 `http://localhost:3000`。

如需在本地测试“文章链接导入”和图片代理，请不要使用普通的 Vite 静态预览。请运行：

```bash
npm run dev:pages
```

该命令会同时启动静态页面与 Cloudflare Pages Functions；普通 `vite preview` 只显示界面，调用 `/api/import` 时会提示文章读取失败。

提交或部署前建议运行：

```bash
npm test
```

## 通过 GitHub 部署到 Cloudflare Pages

把本项目文件直接放在 GitHub 仓库根目录，Cloudflare Pages 使用以下设置：

- Root directory：留空
- Build command：`npm run build:pages`
- Build output directory：`dist-pages`
- Node.js：22

必须保留仓库根目录的 `functions/` 文件夹。Cloudflare Git 集成会把其中的 `/api/import` 和 `/api/image` 一起部署；它们分别负责文章链接读取和远程图片代理。

不要把 `dist-pages` 压缩包直接拖进 Cloudflare 控制台代替 Git 部署。控制台拖拽只能上传静态文件，不会编译 `functions/`，会导致 `/api/import` 返回 405、链接读取失败。完整步骤见 [CLOUDFLARE_GITHUB_DEPLOY.md](CLOUDFLARE_GITHUB_DEPLOY.md)。

## 技术栈

- React 19
- vinext / Vite
- Cloudflare Workers
- html-to-image
- JSZip
- [Tiptap / ProseMirror](https://github.com/ueberdosis/tiptap)（MIT 开源编辑器框架）
- [react-colorful](https://github.com/omgovich/react-colorful)（MIT 开源轻量取色器）
- [Marked](https://github.com/markedjs/marked)（MIT 开源 Markdown 单向解析器）

> Markdown 仅在导入弹窗中单向转换为富文本，避免模式往返造成内容或样式丢失。转换支持标题、粗体、斜体、高亮、列表、引用和 GFM 表格；导入后统一在富文本编辑器中继续修改。贴图导出不可点击，因此编辑器不提供链接创建功能。

## 内容与版权

请只导入、编辑和发布自己有权使用的文章、图片与刊物素材。页面内置的风险提示是排版辅助，不代替法律、合规或投资顾问意见。
