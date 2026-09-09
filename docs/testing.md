# 回归测试

分页工具的验收需要同时检查正文和真实布局。字符数相同并不代表顺序正确；模拟 DOM 中全部通过，也不代表真实浏览器不会裁掉文字。

## 三层验证的边界

| 层次 | 覆盖内容 | 不能证明的内容 |
| --- | --- | --- |
| `node:test` + jsdom | 导入、清洗、真实 Tiptap 文档事务、异常粘贴、撤销和正文守恒 | 系统剪贴板、字体渲染、CSS 伪元素和真实页面高度 |
| 注入测量值的分页单测 | 递归拆分、表格续排、标题跟随、终止条件、指定几何边界 | 浏览器实际排出的行高、边距、字形以及图片加载后的尺寸 |
| GitHub Actions 中的 Playwright | Chromium、Firefox 加载生产构建与本地字体，使用界面完成导入、排版、图片、保存和 PNG 下载；检查真实 DOM 高度与正文顺序 | 所有浏览器/设备、第三方网站抓取稳定性、真实操作系统剪贴板格式和人工视觉审美 |

测试预期来自 `tests/fixtures/a-share-pressure-article.txt` 原文，而非生产代码的正文提取函数。原文中的五个 NBSP 空段是回归输入的一部分。比较时忽略排版空白，保留其余字符的顺序和数量；预览中单独排除产品添加的封面导语和免责声明。

## 浏览器关键流程

`tests/browser/workbench.spec.ts` 包含七条流程，每条在全新浏览器上下文运行：

1. 包含五个 NBSP 空段的用户长文通过富文本导入，经过自动排版及美化后/基础样式切换，正文仍完整，七个章节仍存在。
2. 五种排版风格、三种成图尺寸、字号、正文字体和主题切换后，全文不丢失，各页不溢出。
3. 正文编辑器接收 PNG 粘贴事件，图片完成真实解码，支持撤销和重做。
4. 导入弹窗与正文编辑器的“＋图片”按钮打开文件选择器并插入图片。
5. 超过字数上限的粘贴被拒绝时，选中正文保持完整，下一次合法粘贴正常。
6. 单页导出产生真实下载文件，检查 PNG 文件头和 1080 × 1350 尺寸，并保存图片作为测试附件。
7. 修改正文、插图、标题与画幅，等待实际草稿写入，再刷新验证恢复结果。

富文本和截图粘贴用 `DataTransfer` / `ClipboardEvent` 提供固定输入，经过应用的真实粘贴处理器和 Tiptap。它不读取系统剪贴板，也不保证所有外部应用生成的原生剪贴板格式都正确。上传走真实文件选择事件；图片由测试生成小型 PNG，无外网图片依赖。

正文对照覆盖所有已展开的预览页。高度验证使用浏览器的 `scrollHeight` 和 `clientHeight`，允许 2 像素舍入误差。此检查关注裁切和横向溢出，不以截图基线代替内容校验。

## 执行与诊断

- `npm run test:unit`：现有快速回归。
- `npm run lint` 和 `npm run typecheck`：代码与类型检查。
- `npm run test:browser:list`：列出浏览器用例；不会启动浏览器或测试服务器。
- GitHub Actions 的 **Verify**：拉取代码、执行 `npm ci`，在独立 runner 中安装指定浏览器，构建 Pages 产物并在 `127.0.0.1:4173` 测试。

工作流只使用 `contents: read` 权限，不读取 secrets，不部署网站，不连接开发者现有浏览器或工作区。所有测试页面来自该 runner 的本地产物；Vite 预览不运行 Cloudflare Functions，因此文章链接抓取与图片代理仍由现有服务端单测检查。

每个浏览器保留 HTML 报告、失败 trace、失败截图及 PNG 导出附件 14 天。失败时先查看测试中的原文对照、页码及溢出高度，再查看 `workbench-status` 与 `uncaught-browser-errors` 附件。单次失败可重试一次用于诊断；CI 启用 `failOnFlakyTests`，重试通过也不会把有偶发失败的任务判为成功。修复应补入固定回归输入，不应仅增加重试或放大等待时间。

本次编写阶段未在开发者主机启动浏览器。此前该主机的 CUA 浏览器通道超时；这套测试是提交到 GitHub 后在独立 CI 中运行的项目验证。只有相应提交的 Actions 运行通过后，才可报告真实浏览器验证通过。

## 借鉴的开源项目

- [microsoft/playwright](https://github.com/microsoft/playwright)，[Apache-2.0](https://github.com/microsoft/playwright/blob/main/LICENSE)：独立浏览器上下文、自动等待、失败轨迹和下载事件。采用官方 `@playwright/test`，固定为 [1.63.0](https://github.com/microsoft/playwright/releases/tag/v1.63.0)。参考 [GitHub Actions](https://playwright.dev/docs/ci-intro)、[webServer](https://playwright.dev/docs/test-webserver) 与 [下载测试](https://playwright.dev/docs/downloads)。
- [ueberdosis/tiptap](https://github.com/ueberdosis/tiptap)，[MIT](https://github.com/ueberdosis/tiptap/blob/main/LICENSE.md)：借鉴真实 Editor 实例和序列化结果验证，见 [setContent 测试](https://github.com/ueberdosis/tiptap/blob/main/packages/core/src/commands/setContent.test.ts) 与 [内容解析测试](https://github.com/ueberdosis/tiptap/blob/main/packages/core/src/helpers/createNodeFromContent.test.ts)。保留本项目的 `node:test`，不引入上游完整工具链。
- [dubzzz/fast-check](https://github.com/dubzzz/fast-check)，[MIT](https://github.com/dubzzz/fast-check/blob/main/LICENSE)：借鉴固定种子、属性不变量和最小失败样本的思路。已固定安装 4.9.0，`tests/pagination-property.test.mjs` 用三个固定种子检查 300 组嵌套富文本、图片位置、完整字素和真实改动识别；失败会缩减为最小反例并打印重现信息。[官方入门](https://fast-check.dev/docs/introduction/getting-started/)
