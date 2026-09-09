# 编辑、分页和导出的职责

当前项目继续使用 React、Tiptap 和 Cloudflare Pages。主页面负责工作区状态和界面；内容转换、分页与导出放在独立模块，避免一次编辑经过多套互相不一致的处理。

```mermaid
flowchart LR
  A[导入文章或图片] --> B[统一清洗和资源地址解析]
  B --> C[Tiptap 编辑器]
  C -->|立即同步正文| D[工作区状态]
  D --> E[样式和文章结构]
  E --> F[分页调度]
  F --> G[分块与文字/表格拆分]
  G --> H[实际布局测量]
  H --> I[正文/样式/图片完整性校验]
  I --> J[带版本的预览]
  J --> K[导出 PNG 或 ZIP]
```

## 模块边界

| 模块 | 职责 |
| --- | --- |
| `lib/richText/importArticle.ts` | 选择文章正文、清洗 HTML、根据来源地址解析图片；避免重复代理已导入图片。 |
| `lib/richText/contentNodes.ts` | 统一识别正文、图片、手动分页与手动空行，避免导入和分页各自定义“空内容”。 |
| `lib/richText/editorPaste.ts` / `editorImages.ts` | 剪贴板、拖放、上传的入口及容量限制；只在真实插入成功后提示成功。 |
| `app/components/ZhepageEditor.tsx` | 富文本交互；每次编辑立即通知工作区，分页延迟只由工作区统一调度。 |
| `lib/beautify/*` | 本地文章结构与样式；连接相邻强调段落，不改正文。 |
| `lib/pagination/articleBlocks.ts` | 将文章转换成有序块，保留祖先外壳，提取手动分页边界。 |
| `lib/pagination/blockStructure.ts` | 块是否可拆、祖先外壳和首尾间距规则。 |
| `lib/pagination/splitText.ts` | 按完整可见字符拆长段落，继承所有行内格式。 |
| `lib/pagination/splitTable.ts` | 拆表格行，保留表头、标题、列宽及末尾表脚。 |
| `lib/pagination/splitDomBlock.ts` | 根据块类型选择拆分方式。 |
| `lib/pagination/paginateArticle.ts` | 排页、剩余空间、标题跟随与进度控制，不内嵌内容校验实现。 |
| `lib/pagination/semanticIntegrity.ts` | 比较正文、行内样式、图片身份和位置、显式空行；仅忽略普通空段和格式化空白。 |
| `app/hooks/usePosterExport.ts` | 图片/压缩组件与字体缓存、导出状态、文件名、PNG/ZIP；导出前后核对预览版本。 |
| `lib/async/withTimeout.ts` | 可复用的超时资源清理。 |

## 修改时保持的约束

- 普通空段可以清理；英文词间空格、手动空行和分页生成的空格续段必须保留。
- 不能仅比较字数；内容顺序、格式、图片来源和图片所在位置也必须一致。
- 文本分页只能落在完整可见字符边界，不能拆开 emoji、组合字符或国旗。
- 测量时使用的首尾标记、样式和显示标签必须与最终预览一致。
- 编辑器同步正文不能延迟；耗时的重新分页可以延迟。预览更新期间保留原位置，但过期结果不能导出。
- 取消或关闭导入后，旧请求即使返回也不能更新正文；等待期间发生的新编辑优先。
- 新增输入类型或拆分规则时，应补独立输入预期和失败回归，不能只检查源代码里是否出现某个函数名。

## 验证

运行 `npm test`、`npm run lint`、`npm run typecheck`；浏览器回归由 GitHub Actions 在独立 Chromium 和 Firefox 中执行。测量替身用于内容与分页决策检查，真实浏览器负责字体、页面尺寸、溢出和下载。详细范围见 [测试说明](testing.md)。
