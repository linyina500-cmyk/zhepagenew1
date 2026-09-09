import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";

async function render(pathname = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${pathname}`, {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the Zhepage application metadata", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<html lang="zh-CN">/i);
  assert.match(html, /<title>折页 · 长文贴图生成器<\/title>/i);
  assert.match(html, /导入文章链接、HTML 或富文本/);
  assert.match(html, /og-zhepage\.png/);
});

test("keeps the requested production defaults", async () => {
  const [page, css, editor, packageJson, readme, guide, articleImporter] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../app/components/ZhepageEditor.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../README.md", import.meta.url), "utf8"),
    readFile(new URL("../使用说明.md", import.meta.url), "utf8"),
    readFile(new URL("../lib/richText/importArticle.ts", import.meta.url), "utf8"),
  ]);

  assert.match(page, /aGVYCtoaJWxN_R2VBSd-_g/);
  assert.match(page, /长鑫科技来了！\\n全网都在算中一签赚多少钱，\\n我想聊五句实话/);
  assert.match(page, /useState\(true\);\s*\n\s*const \[preserveStyles/);
  assert.match(page, /useState<ThemeKey \| null>\("whiteRed"\)/);
  assert.match(page, /useState<FontKey>\("serif"\)/);
  assert.match(page, /useState\("A股研报局"\)/);
  assert.match(page, /useState\("A股研报局出品"\)/);
  assert.match(page, /useState\("A股研报局 · 行情早知道"\)/);
  assert.match(page, /const \[footerText, setFooterText\] = useState\("A股研报局"\)/);
  assert.match(page, /图片左下角文案/);
  assert.match(page, /footerText\.trim\(\) \|\| labName\.trim\(\)/);
  assert.match(page, /何智辉：资质编号A0070622060009/);
  assert.match(page, /曹宇峰：资质编号A0070617060002/);
  assert.match(page, /WORKSPACE_STORAGE_KEY = "zhepage-workspace-v2"/);
  assert.match(page, /LEGACY_WORKSPACE_STORAGE_KEY = "zhepage-workspace-v1"/);
  assert.match(page, /const \[showAllPreviewPages, setShowAllPreviewPages\] = useState\(false\)/);
  assert.match(page, /showAllPreviewPages \? totalPages : Math\.min\(4, totalPages\)/);
  assert.match(page, /onClick=\{\(\) => setShowAllPreviewPages\(true\)\}/);
  assert.doesNotMatch(page, /setVisiblePageCount/);

  assert.match(editor, /from "@tiptap\/react"/);
  assert.doesNotMatch(editor, /@tiptap\/markdown/);
  assert.doesNotMatch(editor, /switchMode/);
  assert.doesNotMatch(editor, /Markdown 内容/);
  assert.match(editor, /toggleHeading\(\{ level: 2 \}\)/);
  assert.match(editor, /data-tooltip=/);
  assert.match(editor, /StyledHighlight\.configure\(\{ multicolor: true \}\)/);
  assert.match(editor, /data-highlight-style/);
  assert.match(editor, /styleType:\s*styleType \|\| "block"/);
  assert.match(editor, /label: "标记笔"/);
  assert.match(editor, /label: "实色块"/);
  assert.match(editor, /setColor\(color\)/);
  assert.doesNotMatch(editor, /setBackgroundColor\(color\)/);
  assert.match(editor, /setMark\("highlight"/);
  assert.match(editor, /UnifiedColorPopover/);
  assert.match(editor, /triggerLabel="字色"/);
  assert.match(editor, /triggerLabel="高亮"/);
  assert.match(editor, /AlignmentControl/);
  assert.match(editor, /AlignIcon/);
  assert.match(editor, /codeBlock: false/);
  assert.doesNotMatch(editor, /toggleCodeBlock/);
  assert.match(editor, /deleteSelection\(\)/);
  assert.match(editor, /TableKit\.configure/);
  assert.match(editor, /label="＋图片"/);
  assert.match(editor, /图片图注/);
  assert.doesNotMatch(editor, /label="链接"/);
  assert.doesNotMatch(editor, /insertTable\(/);
  assert.match(packageJson, /"@tiptap\/react"/);
  assert.match(packageJson, /"react-colorful"/);
  assert.match(packageJson, /"marked"/);
  assert.doesNotMatch(packageJson, /"@tiptap\/markdown"/);
  assert.match(packageJson, /"dev:pages"/);

  assert.match(page, /customThemePresets/);
  assert.match(page, /riskPresets/);
  assert.match(page, /保存当前配色/);
  assert.match(page, /核心配色/);
  assert.match(page, /更多配色/);
  assert.match(page, /custom-theme-option/);
  assert.match(page, /preset\.paperColor/);
  assert.match(page, /Markdown 仅在导入时单向转换为富文本/);
  assert.match(page, /import\("marked"\)/);
  assert.match(page, /gloryGold/);
  assert.match(page, /camelliaRed/);
  assert.match(page, /保存当前版本/);
  assert.match(articleImporter, /element\.removeAttribute\("href"\)/);
  assert.match(articleImporter, /replace\(\/line-height\\s\*:/);
  assert.match(page, /一键导入并替换正文/);
  assert.match(page, /把一篇长文，变成一组可以直接发布的贴图/);
  assert.match(page, /zhepage-guide-seen-v1/);
  assert.match(articleImporter, /function extractRichTextFragment/);
  assert.match(page, /首行标题会自动识别/);
  assert.match(page, /applySource\(sourceEditorHtmlRef\.current, "fragment", true\)/);
  assert.match(page, /setNotice\(\{[\s\S]*?item === "url"[\s\S]*?item === "editor"/);

  assert.match(css, /--poster-paper:\s*#ffffff/);
  assert.match(css, /--poster-accent:\s*#d7352f/);
  assert.match(css, /--poster-title-font:\s*var\(--font-source-han-serif\)/);
  assert.match(css, /font-family:\s*"Zhepage Source Han Serif"/);
  assert.match(css, /source-han-serif-sc-vf\.woff2/);
  assert.match(css, /source-han-sans-sc-vf\.woff2/);
  assert.match(css, /font-synthesis:\s*none/);
  assert.match(page, /waitForPosterFonts\(\[titleFont, bodyFont\]\)/);
  assert.match(css, /\.article-flow mark/);
  assert.match(css, /\.article-flow ul \{ list-style-type: disc !important; \}/);
  assert.match(css, /\.article-flow ol \{ list-style-type: decimal !important; \}/);
  assert.match(css, /font-synthesis: style !important/);
  assert.match(css, /\.layout-editor em, \.layout-editor i \{ display: inline;/);
  assert.match(css, /\.article-flow em, \.article-flow i \{ display: inline;/);
  assert.doesNotMatch(css, /transform:\s*skewX\(-10deg\)/);
  assert.match(css, /mark\[data-highlight-style="marker"\]/);
  assert.match(css, /mark\[data-highlight-style="block"\]/);
  assert.match(css, /\.color-variant-options/);
  assert.match(css, /span\[style\*="color" i\] strong/);
  assert.match(css, /\.color-popover \{ position: fixed/);
  assert.match(css, /\.article-flow blockquote[^}]*var\(--poster-accent\)/s);
  assert.match(css, /\.import-modal-backdrop/);
  assert.match(css, /\.guide-modal-backdrop/);
  assert.match(readme, /\[使用说明\.md\]\(使用说明\.md\)/);
  assert.match(readme, /Tiptap/);
  assert.match(guide, /第一次打开页面/);
  assert.match(guide, /文章链接/);
  assert.match(guide, /批量导出/);
});

test("ships self-hosted Source Han fonts for stable cross-platform pagination", async () => {
  const [serif, sans, headers, license] = await Promise.all([
    stat(new URL("../public/fonts/source-han-serif-sc-vf.woff2", import.meta.url)),
    stat(new URL("../public/fonts/source-han-sans-sc-vf.woff2", import.meta.url)),
    readFile(new URL("../public/_headers", import.meta.url), "utf8"),
    readFile(new URL("../public/fonts/LICENSE.txt", import.meta.url), "utf8"),
  ]);
  assert.ok(serif.size > 20_000_000);
  assert.ok(sans.size > 13_000_000);
  assert.match(headers, /\/fonts\/\*/);
  assert.match(headers, /max-age=31536000, immutable/);
  assert.match(license, /SIL OPEN FONT LICENSE Version 1\.1/);
});

test("ships five independent V4 layouts with compatible theme and workspace state", async () => {
  const [page, css, cover, layoutTypes, presets, tokens, beautifier] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../app/components/PosterCover.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/layouts/layoutTypes.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/layouts/layoutPresets.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/layouts/resolveThemeTokens.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/beautify/beautifyArticle.ts", import.meta.url), "utf8"),
  ]);

  ["xiaohongshu", "financeDeepRead", "dataIndex", "cleanNews", "keyCards"].forEach((key) => {
    assert.match(layoutTypes, new RegExp(`\\|? \\"${key}\\"`));
    assert.match(presets, new RegExp(`${key}:`));
  });
  assert.match(page, /LAYOUT_STYLE_KEYS\.map/);
  assert.match(page, /layoutClassName\(layoutStyle\)/);
  assert.match(page, /useState<LayoutStyleKey>\("xiaohongshu"\)/);
  assert.match(page, /const \[numberedDotStyle, setNumberedDotStyle\] = useState\(true\)/);
  assert.match(page, /numberedDotStyle, previewPresentation/);
  assert.match(page, /version: 2/);
  assert.match(page, /saved\.version === 1 \? "已兼容恢复旧版工作区"/);
  assert.match(page, /saved\.version === 2 && saved\.layoutStyle/);

  const applyLayout = page.match(/function applyLayoutStyle[\s\S]*?\n {2}}/)?.[0] || "";
  const applyTheme = page.match(/function applyTheme[\s\S]*?\n {2}}/)?.[0] || "";
  assert.doesNotMatch(applyLayout, /setThemeKey|setPaperColor|setAccentColor|setTextColor|setHighlightColor/);
  assert.doesNotMatch(applyTheme, /setLayoutStyle/);

  const themeSnapshots = [
    'whiteRed: { name: "白底朱红", detail: "清爽醒目", paper: "#ffffff", accent: "#d7352f", text: "#292624", highlight: "#ffd66b" }',
    'butter: { name: "奶油黄黑", detail: "高对比干货", paper: "#fff8d9", accent: "#171717", text: "#332e25", highlight: "#ff6b35" }',
    'paper: { name: "纸感棕金", detail: "理性高级", paper: "#f7f2e8", accent: "#7a3d13", text: "#5c3519", highlight: "#e5bd54" }',
    'mistBlue: { name: "雾蓝珊瑚", detail: "知识感清晰", paper: "#f2f7ff", accent: "#2457a7", text: "#29384d", highlight: "#ff7b6b" }',
    'gloryGold: { name: "荣耀金", detail: "权威醒目", paper: "#fff9e6", accent: "#0a0a0a", text: "#29251b", highlight: "#ffd700" }',
    'blazeRed: { name: "炽焰红", detail: "强势聚焦", paper: "#fff7f6", accent: "#e61a23", text: "#1f1919", highlight: "#ffc4c7" }',
    'sweetPink: { name: "甜酷粉", detail: "年轻锐利", paper: "#fff6fa", accent: "#e6379c", text: "#1a1a1d", highlight: "#f5bfdc" }',
    'slatePurple: { name: "石板紫", detail: "潮流反差", paper: "#fbf7ff", accent: "#7b2cbf", text: "#33203f", highlight: "#fff000" }',
    'cheeseGreen: { name: "奶酪青苹", detail: "柔和自然", paper: "#fbf1d7", accent: "#5f9843", text: "#2e3d28", highlight: "#b9dda2" }',
    'kleinMint: { name: "克莱因薄荷", detail: "理性先锋", paper: "#f2fbf7", accent: "#012696", text: "#172751", highlight: "#a4e2c6" }',
    'verdigris: { name: "铜绿蒸栗", detail: "复古雅致", paper: "#f4eac5", accent: "#3f796e", text: "#293b37", highlight: "#b9d7cd" }',
    'gooseBlue: { name: "鹅蓝清水", detail: "安静清晰", paper: "#f2fafb", accent: "#113056", text: "#243746", highlight: "#91cfd5" }',
    'terracotta: { name: "赤陶牙黄", detail: "温暖人文", paper: "#fff8f1", accent: "#c96f4d", text: "#49362e", highlight: "#e9eeb9" }',
    'deepSeaBlue: { name: "深海蓝", detail: "沉稳专业", paper: "#f5efea", accent: "#122e8a", text: "#272c3f", highlight: "#c6d1f4" }',
    'camelliaRed: { name: "茶花红", detail: "细腻醒目", paper: "#fff7f8", accent: "#d82440", text: "#3b2428", highlight: "#f1dddf" }',
  ];
  themeSnapshots.forEach((snapshot) => assert.ok(page.includes(snapshot), `theme changed: ${snapshot.slice(0, 18)}`));

  assert.match(tokens, /relativeLuminance/);
  assert.match(tokens, /onAccent:/);
  assert.match(tokens, /color-mix\(in srgb/);
  assert.match(page, /--poster-on-accent/);
  assert.match(page, /--poster-accent-soft/);
  assert.match(page, /--poster-accent-border/);
  assert.match(css, /var\(--poster-on-accent\)/);
  assert.match(css, /var\(--poster-accent-soft\)/);
  assert.match(css, /var\(--poster-accent-border\)/);

  // Every title layer in the four V4 layouts follows the selected theme's
  // accent color. Body copy continues to use --poster-text independently.
  const accentTitleSelectors = [
    ".cover-page.layout-financeDeepRead h3",
    ".cover-page.layout-dataIndex h3",
    ".cover-page.layout-cleanNews h3",
    ".cover-page.layout-keyCards h3",
    ".article-flow.layout-financeDeepRead h2",
    ".article-flow.layout-financeDeepRead h3",
    ".article-flow.layout-financeDeepRead .first-page-lede h1",
    ".article-flow.layout-financeDeepRead .auto-inferred-heading",
    ".article-flow.layout-dataIndex h2",
    ".article-flow.layout-dataIndex h3",
    ".article-flow.layout-dataIndex .first-page-lede h1",
    ".article-flow.layout-dataIndex .auto-inferred-heading",
    ".article-flow.layout-cleanNews h2",
    ".article-flow.layout-cleanNews h3",
    ".article-flow.layout-cleanNews .first-page-lede h1",
    ".article-flow.layout-cleanNews .auto-inferred-heading",
    ".article-flow.layout-keyCards h2",
    ".article-flow.layout-keyCards h3",
    ".article-flow.layout-keyCards .first-page-lede h1",
    ".article-flow.layout-keyCards .auto-inferred-heading",
  ];
  accentTitleSelectors.forEach((selector) => {
    const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const rule = css.match(new RegExp(`${escapedSelector}(?:\\s*,[^{}]*)?\\s*\\{[^}]*\\}`))?.[0] || "";
    assert.ok(rule, `missing title selector: ${selector}`);
    assert.match(rule, /color:\s*var\(--poster-accent\)/, `title is not theme-linked: ${selector}`);
    assert.doesNotMatch(rule, /color:\s*var\(--poster-text\)/, `title still follows body color: ${selector}`);
  });

  assert.match(page, /自动识别文章结构/);
  assert.match(page, /美化后/);
  assert.match(page, /基础样式/);
  assert.match(page, /恢复「\{layoutPreset\.name\}」推荐设置/);
  assert.match(page, /presentationArticleHtml/);
  const autoTypeset = page.match(/function applyAutomaticTypeset[\s\S]*?\n {2}}/)?.[0] || "";
  assert.match(autoTypeset, /setArticleHtml\(result\.html\)/);
  assert.match(autoTypeset, /setSourceEditorHtml\(result\.html\)/);
  assert.match(autoTypeset, /setEditorRevision/);
  assert.match(autoTypeset, /同步到编辑器/);
  assert.doesNotMatch(beautifier, /border-radius": "14px"/);

  assert.match(page, /图片左下角文案（图片底部）/);
  assert.match(page, /footerText\.trim\(\) \|\| labName\.trim\(\)/);
  assert.doesNotMatch(page, /页面利用率/);
  assert.doesNotMatch(css, /page-usage-indicator/);

  assert.match(cover, /adaptiveTitleSize/);
  assert.match(cover, /data-layout-style/);
  assert.match(page, /data-layout-style=\{layoutStyle\}/);
  assert.match(page, /article-flow \$\{layoutClass\}/);
  assert.match(css, /span\[style\*="color" i\]/);

  const layoutCss = css.slice(css.indexOf(".cover-brand, .cover-edition"));
  assert.ok(layoutCss.length > 1000);
  assert.doesNotMatch(layoutCss, /#[0-9a-f]{3,8}/i);
});
