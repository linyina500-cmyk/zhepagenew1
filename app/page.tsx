"use client";

import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import UnifiedColorPopover from "./components/UnifiedColorPopover";
import PosterCover from "./components/PosterCover";
import { usePosterExport, type ExportVersion } from "./hooks/usePosterExport";
import { withTimeout } from "../lib/async/withTimeout";
import { beautifyArticle } from "../lib/beautify/beautifyArticle";
import { layoutClassName } from "../lib/layouts/layoutClasses";
import { LAYOUT_PRESETS, LAYOUT_STYLE_KEYS } from "../lib/layouts/layoutPresets";
import { resolveThemeTokens } from "../lib/layouts/resolveThemeTokens";
import type { LayoutStyleKey, PreviewPresentation } from "../lib/layouts/layoutTypes";
import { paginateArticle } from "../lib/pagination/paginateArticle";
import { extractArticle, extractRichTextFragment } from "../lib/richText/importArticle";

const ZhepageEditor = lazy(() => import("./components/ZhepageEditor"));

type InputMode = "url" | "html" | "editor" | "markdown";
type FormatKey = "xiaohongshu" | "portrait" | "story";
type FontKey = "sans" | "serif";
type PreviewZoom = "fit" | "0.5" | "0.75" | "1";
type DensityKey = "compact" | "standard" | "spacious";
type ThemeKey = "paper" | "whiteRed" | "butter" | "mistBlue"
  | "gloryGold" | "blazeRed" | "sweetPink" | "slatePurple" | "cheeseGreen" | "kleinMint"
  | "verdigris" | "gooseBlue" | "terracotta" | "deepSeaBlue" | "camelliaRed";
type Notice = { tone: "neutral" | "success" | "error"; text: string };
type PaginationState = { inputKey: string; version: number; status: "pending" | "ready" | "error"; error: string };
type CustomThemePreset = {
  id: string;
  name: string;
  paperColor: string;
  accentColor: string;
  textColor: string;
  highlightColor: string;
  titleFont: FontKey;
  bodyFont: FontKey;
};
type RiskPreset = { id: string; name: string; title: string; text: string };
type SavedWorkspace = {
  version: 2;
  mode: InputMode;
  formatKey: FormatKey;
  url: string;
  rawHtml: string;
  markdownInput?: string;
  title: string;
  subtitle: string;
  labName: string;
  coverCredit: string;
  pageBrand: string;
  footerText: string;
  layoutStyle: LayoutStyleKey;
  autoStructure: boolean;
  numberedDotStyle: boolean;
  previewPresentation: PreviewPresentation;
  articleHtml: string;
  firstPageContent: boolean;
  preserveStyles: boolean;
  typeScale: number;
  lineHeight: number;
  bottomReserve: number;
  themeKey: ThemeKey | null;
  paperColor: string;
  accentColor: string;
  textColor: string;
  highlightColor: string;
  titleFont: FontKey;
  bodyFont: FontKey;
  showRiskNote: boolean;
  riskTitle: string;
  riskText: string;
  publicationName: string;
  leadGuide: string;
  qrDataUrl: string;
  customThemePresets: CustomThemePreset[];
  riskPresets: RiskPreset[];
};

type StoredWorkspace = Partial<Omit<SavedWorkspace, "version">> & { version?: 1 | 2 };

const FORMATS: Record<FormatKey, { label: string; detail: string; width: number; height: number }> = {
  xiaohongshu: { label: "小红书 3:4", detail: "1080 × 1440", width: 1080, height: 1440 },
  portrait: { label: "公众号 4:5", detail: "1080 × 1350", width: 1080, height: 1350 },
  story: { label: "竖版 9:16", detail: "1080 × 1920", width: 1080, height: 1920 },
};

const THEMES: Record<ThemeKey, { name: string; detail: string; paper: string; accent: string; text: string; highlight: string }> = {
  whiteRed: { name: "白底朱红", detail: "清爽醒目", paper: "#ffffff", accent: "#d7352f", text: "#292624", highlight: "#ffd66b" },
  butter: { name: "奶油黄黑", detail: "高对比干货", paper: "#fff8d9", accent: "#171717", text: "#332e25", highlight: "#ff6b35" },
  paper: { name: "纸感棕金", detail: "理性高级", paper: "#f7f2e8", accent: "#7a3d13", text: "#5c3519", highlight: "#e5bd54" },
  mistBlue: { name: "雾蓝珊瑚", detail: "知识感清晰", paper: "#f2f7ff", accent: "#2457a7", text: "#29384d", highlight: "#ff7b6b" },
  gloryGold: { name: "荣耀金", detail: "权威醒目", paper: "#fff9e6", accent: "#0a0a0a", text: "#29251b", highlight: "#ffd700" },
  blazeRed: { name: "炽焰红", detail: "强势聚焦", paper: "#fff7f6", accent: "#e61a23", text: "#1f1919", highlight: "#ffc4c7" },
  sweetPink: { name: "甜酷粉", detail: "年轻锐利", paper: "#fff6fa", accent: "#e6379c", text: "#1a1a1d", highlight: "#f5bfdc" },
  slatePurple: { name: "石板紫", detail: "潮流反差", paper: "#fbf7ff", accent: "#7b2cbf", text: "#33203f", highlight: "#fff000" },
  cheeseGreen: { name: "奶酪青苹", detail: "柔和自然", paper: "#fbf1d7", accent: "#5f9843", text: "#2e3d28", highlight: "#b9dda2" },
  kleinMint: { name: "克莱因薄荷", detail: "理性先锋", paper: "#f2fbf7", accent: "#012696", text: "#172751", highlight: "#a4e2c6" },
  verdigris: { name: "铜绿蒸栗", detail: "复古雅致", paper: "#f4eac5", accent: "#3f796e", text: "#293b37", highlight: "#b9d7cd" },
  gooseBlue: { name: "鹅蓝清水", detail: "安静清晰", paper: "#f2fafb", accent: "#113056", text: "#243746", highlight: "#91cfd5" },
  terracotta: { name: "赤陶牙黄", detail: "温暖人文", paper: "#fff8f1", accent: "#c96f4d", text: "#49362e", highlight: "#e9eeb9" },
  deepSeaBlue: { name: "深海蓝", detail: "沉稳专业", paper: "#f5efea", accent: "#122e8a", text: "#272c3f", highlight: "#c6d1f4" },
  camelliaRed: { name: "茶花红", detail: "细腻醒目", paper: "#fff7f8", accent: "#d82440", text: "#3b2428", highlight: "#f1dddf" },
};

const CORE_THEME_KEYS: ThemeKey[] = ["whiteRed", "butter", "paper", "mistBlue"];
const REFERENCE_THEME_KEYS: ThemeKey[] = [
  "gloryGold", "blazeRed", "sweetPink", "slatePurple", "cheeseGreen", "kleinMint",
  "verdigris", "gooseBlue", "terracotta", "deepSeaBlue", "camelliaRed",
];

const DENSITY_PRESETS: Record<DensityKey, { label: string; typeScale: number; lineHeight: number; bottomReserve: number }> = {
  compact: { label: "紧凑", typeScale: 0.9, lineHeight: 1.52, bottomReserve: 0 },
  standard: { label: "标准", typeScale: 1, lineHeight: 1.72, bottomReserve: 0 },
  spacious: { label: "舒展", typeScale: 1.08, lineHeight: 1.86, bottomReserve: 20 },
};

const MAX_TITLE_LENGTH = 80;
const MAX_TITLE_LINES = 4;

function normalizePosterTitle(value: string) {
  let remaining = MAX_TITLE_LENGTH;
  return value.replace(/\r/g, "").split("\n").slice(0, MAX_TITLE_LINES).map((line) => {
    const kept = Array.from(line).slice(0, remaining).join("");
    remaining -= Array.from(kept).length;
    return kept;
  }).join("\n");
}

const DEFAULT_ARTICLE_URL = "https://mp.weixin.qq.com/s/aGVYCtoaJWxN_R2VBSd-_g";
const DEFAULT_TITLE = "长鑫科技来了！\n全网都在算中一签赚多少钱，\n我想聊五句实话";
const DEFAULT_SUBTITLE = "";
const DEFAULT_RISK_TITLE = "【版权与免责声明】";
const DEFAULT_RISK_TEXT = "以上观点仅供参考学习，所依据的指标和计算模型存在局限性，不构成投资建议，据此操作风险自担。您应自主作出投资决策，自行承担投资风险和损失，投资有风险，入市需谨慎！（汇正财经投顾团队编辑，何智辉：资质编号A0070622060009；曹宇峰：资质编号A0070617060002）";
const DEFAULT_PUBLICATION_NAME = "《热点研报合集》";
const DEFAULT_LEAD_GUIDE = "长按识别二维码，添加助理领取 PDF 资料";
const LEAD_CARD_DISCLAIMER = "观点及过往案例仅供参考学习，不构成投资建议，操作风险自担。";
const WORKSPACE_STORAGE_KEY = "zhepage-workspace-v2";
const LEGACY_WORKSPACE_STORAGE_KEY = "zhepage-workspace-v1";
const POSTER_FONT_FAMILIES: Record<FontKey, string> = {
  serif: '"Zhepage Source Han Serif"',
  sans: '"Zhepage Source Han Sans"',
};
const POSTER_FONT_SAMPLE = "折页长鑫科技行情早知道ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const makePresetId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
const DEFAULT_HTML = `
  <p>长鑫科技即将登陆科创板，市场讨论迅速聚焦到发行规模、上市定价和中签收益。</p>
  <p>热度越高，越需要把概率、估值和交易风险分开看。下面用五个角度梳理这次上市事件。</p>
  <h2>第一句：收益测算之前，先看中签概率</h2>
  <p>打新收益建立在成功中签的前提上。参与成本、概率和资金安排都应该独立评估，不能把偶然结果当作固定收入。</p>
  <blockquote><strong>可以参与概率事件，但不要把概率事件写进确定性的收益计划。</strong></blockquote>
  <h2>第二句：打新与上市后追高是两套逻辑</h2>
  <p>中签者的持仓成本与上市后买入者完全不同。面对首日波动，先判断自己承担的是发行红利，还是高溢价交易风险。</p>
  <h2>第三句：首日价格不等于长期价值</h2>
  <p>流通筹码、市场关注度和短期情绪都会放大价格波动。情景估值只是测算，不是承诺，也不应直接成为交易锚点。</p>
  <h2>第四句：好产业、好公司与好价格要分别判断</h2>
  <p>国产存储具备长期产业价值，但行业周期、盈利波动和估值水平仍需同时观察。认可产业方向，不代表任何价格都合适。</p>
  <h2>第五句：警惕概念股借势炒作</h2>
  <p>供应链关系应以公告、年报、客户认证和真实订单为依据。仅凭市场传闻或名称关联，容易把产业趋势误读成短期题材。</p>
  <h2>写在最后</h2>
  <p>产业的重要时刻值得关注，具体交易仍要回到概率、价格和风险承受能力。把事实与情绪分开，才能做出更清醒的判断。</p>
`;

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  })[character] || character);
}

async function waitForPosterFonts(fonts: FontKey[]) {
  if (typeof document === "undefined" || !document.fonts) return;
  const uniqueFonts = [...new Set(fonts)];
  const declarations = uniqueFonts.flatMap((font) => [
    `400 34px ${POSTER_FONT_FAMILIES[font]}`,
    `900 112px ${POSTER_FONT_FAMILIES[font]}`,
  ]);
  await Promise.all(declarations.map((declaration) => document.fonts.load(declaration, POSTER_FONT_SAMPLE)));
  await document.fonts.ready;
  if (!declarations.every((declaration) => document.fonts.check(declaration, POSTER_FONT_SAMPLE))) {
    throw new Error("思源字体未能完整加载");
  }
}

function createLeadCardHtml(publicationName: string, guide: string, qrDataUrl: string) {
  const qrMarkup = qrDataUrl
    ? `<img class="lead-card-qr" src="${escapeHtml(qrDataUrl)}" alt="刊物领取二维码">`
    : '<div class="lead-card-qr-placeholder">请上传<br>二维码</div>';
  const titleLength = Array.from(publicationName.trim()).length;
  const titleSizeClass = titleLength > 24 ? " is-extra-long" : titleLength > 14 ? " is-long" : "";
  return `<aside class="lead-magnet-card">
    <div class="lead-card-pdf">
      <div class="lead-card-pdf-sheet">
        <span class="lead-card-pdf-badge">PDF</span>
        <img class="lead-card-cover-image" src="/hotspot-report-cover.webp" alt="热点刊物 PDF 封面">
      </div>
    </div>
    <div class="lead-card-body">
      <strong class="lead-card-title${titleSizeClass}">${escapeHtml(publicationName)}</strong>
      <div class="lead-card-lower">
        <div class="lead-card-copy">
          <p class="lead-card-guide">${escapeHtml(guide)}</p>
          <div class="lead-card-cta"><b>扫码领取</b><span>长按识别二维码</span></div>
        </div>
        <div class="lead-card-qr-zone">
          <div class="lead-card-qr-wrap">${qrMarkup}</div>
        </div>
      </div>
    </div>
    <small class="lead-card-disclaimer">${LEAD_CARD_DISCLAIMER}</small>
  </aside>`;
}

function replaceLeadCardPlaceholders(html: string, cardHtml: string) {
  return html.replace(/<div[^>]*class=["'][^"']*lead-card-placeholder[^"']*["'][^>]*>[\s\S]*?<\/div>/gi, cardHtml);
}

function removeEmptyHeadings(html: string) {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  parsed.querySelectorAll("h1,h2,h3,h4,h5,h6").forEach((heading) => {
    if (!heading.textContent?.trim() && !heading.querySelector("img")) heading.remove();
  });
  return parsed.body.innerHTML;
}

function EditorFallback() {
  return <div className="layout-editor editor-loading">正在加载专业编辑器…</div>;
}

export default function Home() {
  const [mode, setMode] = useState<InputMode>("url");
  const [formatKey, setFormatKey] = useState<FormatKey>("xiaohongshu");
  const [url, setUrl] = useState(DEFAULT_ARTICLE_URL);
  const [rawHtml, setRawHtml] = useState(DEFAULT_HTML.trim());
  const [markdownInput, setMarkdownInput] = useState("");
  const [title, setTitle] = useState(DEFAULT_TITLE);
  const [subtitle, setSubtitle] = useState(DEFAULT_SUBTITLE);
  const [labName, setLabName] = useState("A股研报局");
  const [coverCredit, setCoverCredit] = useState("A股研报局出品");
  const [pageBrand, setPageBrand] = useState("A股研报局 · 行情早知道");
  const [footerText, setFooterText] = useState("A股研报局");
  const [layoutStyle, setLayoutStyle] = useState<LayoutStyleKey>("xiaohongshu");
  const [autoStructure, setAutoStructure] = useState(true);
  const [numberedDotStyle, setNumberedDotStyle] = useState(true);
  const [previewPresentation, setPreviewPresentation] = useState<PreviewPresentation>("beautified");
  const [manualTypesetPreview, setManualTypesetPreview] = useState(false);
  const [articleHtml, setArticleHtml] = useState(DEFAULT_HTML);
  const [firstPageContent, setFirstPageContent] = useState(true);
  const [preserveStyles, setPreserveStyles] = useState(true);
  const [typeScale, setTypeScale] = useState(1);
  const [lineHeight, setLineHeight] = useState(1.72);
  const [bottomReserve, setBottomReserve] = useState(0);
  const [themeKey, setThemeKey] = useState<ThemeKey | null>("whiteRed");
  const [paperColor, setPaperColor] = useState("#ffffff");
  const [accentColor, setAccentColor] = useState("#d7352f");
  const [textColor, setTextColor] = useState("#292624");
  const [highlightColor, setHighlightColor] = useState("#ffd66b");
  const [titleFont, setTitleFont] = useState<FontKey>("serif");
  const [bodyFont, setBodyFont] = useState<FontKey>("serif");
  const [showRiskNote, setShowRiskNote] = useState(true);
  const [riskTitle, setRiskTitle] = useState(DEFAULT_RISK_TITLE);
  const [riskText, setRiskText] = useState(DEFAULT_RISK_TEXT);
  const [customThemePresets, setCustomThemePresets] = useState<CustomThemePreset[]>([]);
  const [themePresetName, setThemePresetName] = useState("");
  const [riskPresets, setRiskPresets] = useState<RiskPreset[]>([]);
  const [riskPresetName, setRiskPresetName] = useState("");
  const [publicationName, setPublicationName] = useState(DEFAULT_PUBLICATION_NAME);
  const [leadGuide, setLeadGuide] = useState(DEFAULT_LEAD_GUIDE);
  const [qrDataUrl, setQrDataUrl] = useState("");
  const [contentPages, setContentPages] = useState<string[]>([]);
  const [pageUsage, setPageUsage] = useState<number[]>([]);
  const [paginationState, setPaginationState] = useState<PaginationState>({ inputKey: "", version: 0, status: "pending", error: "" });
  const [paginationRevision, setPaginationRevision] = useState(0);
  const [activePreviewPage, setActivePreviewPage] = useState(0);
  const [previewZoom, setPreviewZoom] = useState<PreviewZoom>("fit");
  const [notice, setNoticeState] = useState<Notice>({ tone: "neutral", text: "示例内容已排版，可直接预览导出" });
  const noticeVersionRef = useRef(0);
  const setNotice = useCallback((next: Notice) => {
    noticeVersionRef.current += 1;
    setNoticeState(next);
  }, []);
  const [working, setWorking] = useState(false);
  const [sourceEditorHtml, setSourceEditorHtml] = useState(DEFAULT_HTML);
  const [leadCardInsertRequest, setLeadCardInsertRequest] = useState(0);
  const [workspaceReady, setWorkspaceReady] = useState(false);
  const importPendingRef = useRef<number | null>(null);
  const importRequestRef = useRef<AbortController | null>(null);
  const currentArticleHtmlRef = useRef(articleHtml);
  const paginationOptimizationRef = useRef<{ pageCount: number; usage: number[]; noticeVersion: number } | null>(null);
  const [editorRevision, setEditorRevision] = useState(0);
  const [showAllPreviewPages, setShowAllPreviewPages] = useState(false);
  const [editorModuleReady, setEditorModuleReady] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [posterFontsReady, setPosterFontsReady] = useState(false);
  const measureRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<Array<HTMLElement | null>>([]);
  const paginationVersionRef = useRef(0);
  const paginationFailedRef = useRef<number | null>(null);
  const exportVersionRef = useRef<ExportVersion | null>(null);
  const format = FORMATS[formatKey];
  const layoutPreset = LAYOUT_PRESETS[layoutStyle];
  const layoutClass = layoutClassName(layoutStyle);
  const themeTokens = resolveThemeTokens({ paper: paperColor, accent: accentColor, text: textColor, highlight: highlightColor });
  const contentHeight = format.height - 300 - bottomReserve;
  const paginationHeight = contentHeight;
  const pageOffset = firstPageContent ? 0 : 1;
  const previewScale = previewZoom === "fit" ? undefined : Number(previewZoom);
  const firstPageHtml = firstPageContent
    ? `<section class="first-page-lede"><h1><span>${title.split("\n").map(escapeHtml).join("<br>")}</span></h1>${subtitle.trim() ? `<p>${escapeHtml(subtitle)}</p>` : ""}</section>`
    : "";
  const riskNoteHtml = showRiskNote
    ? `<aside class="risk-note"><strong>${escapeHtml(riskTitle)}</strong><p>${escapeHtml(riskText).replace(/\n/g, "<br>")}</p></aside>`
    : "";
  const leadCardHtml = createLeadCardHtml(publicationName, leadGuide, qrDataUrl);
  const presentationArticleHtml = useMemo(() => {
    const shouldBeautify = layoutStyle === "xiaohongshu" ? manualTypesetPreview : autoStructure;
    if (!shouldBeautify || previewPresentation === "base" || typeof DOMParser === "undefined") return articleHtml;
    return beautifyArticle(articleHtml, { numberedDotStyle }).html;
  }, [articleHtml, autoStructure, layoutStyle, manualTypesetPreview, numberedDotStyle, previewPresentation]);
  const paginationHtml = `${firstPageHtml}${replaceLeadCardPlaceholders(presentationArticleHtml, leadCardHtml)}${riskNoteHtml}`;
  const paginationInputKey = useMemo(() => JSON.stringify([
    paginationHtml, paginationHeight, preserveStyles, typeScale, lineHeight, titleFont, bodyFont, layoutStyle, pageOffset, paginationRevision,
  ]), [paginationHtml, paginationHeight, preserveStyles, typeScale, lineHeight, titleFont, bodyFont, layoutStyle, pageOffset, paginationRevision]);
  const paginationError = paginationState.inputKey === paginationInputKey && paginationState.status === "error" ? paginationState.error : "";
  const paginationReady = posterFontsReady && paginationState.inputKey === paginationInputKey && paginationState.status === "ready";
  // Keep the last preview mounted while its replacement is being measured.
  // Removing its fixed-height pages would shrink the document and move the
  // user's scroll position; export readiness is checked separately.
  const contentPageCount = contentPages.length;
  const totalPages = contentPageCount ? contentPageCount + pageOffset : 0;
  const visiblePageCount = showAllPreviewPages ? totalPages : Math.min(4, totalPages);
  const sparsePageIndex = paginationReady ? pageUsage.findIndex((usage, index) => index < pageUsage.length - 1 && usage < 0.88) : -1;
  const exportInputKey = useMemo(() => JSON.stringify([
    paginationInputKey, formatKey, title, subtitle, pageBrand, footerText, labName, coverCredit, paperColor, accentColor, textColor, highlightColor,
  ]), [paginationInputKey, formatKey, title, subtitle, pageBrand, footerText, labName, coverCredit, paperColor, accentColor, textColor, highlightColor]);
  const { exporting, exportOne, exportAll } = usePosterExport({
    exportVersionRef, pageRefs, contentPages, pageOffset, totalPages,
    format, formatKey, title, paperColor, fontKey: `${titleFont}:${bodyFont}`,
    waitForFonts: () => waitForPosterFonts([titleFont, bodyFont]),
    setShowAllPreviewPages, onNotice: setNotice,
  });
  const leadCardCount = (articleHtml.match(/lead-card-placeholder/g) || []).length;
  const selectedCustomTheme = customThemePresets.find((preset) => themeKey === null
    && paperColor === preset.paperColor
    && accentColor === preset.accentColor
    && textColor === preset.textColor
    && highlightColor === preset.highlightColor);
  const activeThemeName = themeKey ? THEMES[themeKey].name : selectedCustomTheme?.name || "自定义配色";

  useLayoutEffect(() => {
    currentArticleHtmlRef.current = articleHtml;
  }, [articleHtml]);

  const closeImportDialog = useCallback(() => {
    const request = importRequestRef.current;
    importRequestRef.current = null;
    if (request) {
      request.abort();
      setWorking(false);
      setNotice({ tone: "neutral", text: "已取消导入，当前正文保持不变" });
    }
    setImportOpen(false);
  }, [setNotice]);

  useEffect(() => () => {
    importRequestRef.current?.abort();
    importRequestRef.current = null;
  }, []);

  useEffect(() => {
    let cancelled = false;
    // Font readiness is an external browser resource and must be reset when
    // the selected font family changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPosterFontsReady(false);
    waitForPosterFonts([titleFont, bodyFont])
      .then(() => {
        if (!cancelled) setPosterFontsReady(true);
      })
      .catch(() => {
        if (cancelled) return;
        setPosterFontsReady(true);
        setNotice({ tone: "error", text: "思源字体加载失败，请检查网络后刷新页面" });
      });
    return () => {
      cancelled = true;
    };
  }, [titleFont, bodyFont, setNotice]);

  useLayoutEffect(() => {
    exportVersionRef.current = paginationReady
      ? { inputKey: exportInputKey, paginationVersion: paginationState.version }
      : null;
  }, [exportInputKey, paginationReady, paginationState.version]);

  useLayoutEffect(() => {
    const measure = measureRef.current;
    if (!measure || !posterFontsReady) return;
    let cancelled = false;
    let updateTimer: number | null = null;
    const updateDelay = paginationHtml.length > 120_000 ? 320 : 160;
    const update = (version: number) => {
      if (cancelled || version !== paginationVersionRef.current) return;
      try {
        const result = paginateArticle(paginationHtml, measure, paginationHeight);
        setContentPages(result.pages);
        setPageUsage(result.usage);
        setPaginationState({ inputKey: paginationInputKey, version, status: "ready", error: "" });
        setActivePreviewPage((page) => Math.min(page, Math.max(0, result.pages.length + pageOffset - 1)));
        if (paginationFailedRef.current !== null) {
          const failedNoticeVersion = paginationFailedRef.current;
          paginationFailedRef.current = null;
          if (failedNoticeVersion === noticeVersionRef.current) {
            setNotice({ tone: "success", text: "排版已恢复，最新预览可以导出" });
          }
        }
        if (paginationOptimizationRef.current) {
          const before = paginationOptimizationRef.current;
          paginationOptimizationRef.current = null;
          const beforeLowest = Math.min(...before.usage.slice(0, -1).concat(1));
          const afterLowest = Math.min(...result.usage.slice(0, -1).concat(1));
          const improved = afterLowest > beforeLowest + 0.015 || result.pages.length < before.pageCount;
          if (before.noticeVersion === noticeVersionRef.current) {
            setNotice({
              tone: "success",
              text: improved
                ? "分页优化完成：已减少中间页面留白"
                : `分页优化完成：${result.pages.length} 页已是当前字号与行距下的平衡结果`,
            });
          }
        }
        if (importPendingRef.current !== null) {
          const importNoticeVersion = importPendingRef.current;
          importPendingRef.current = null;
          // The article can still finish paginating after the user has moved
          // on. Its completion must not replace a newer action's notice.
          if (importNoticeVersion === noticeVersionRef.current) {
            setNotice({ tone: "success", text: `导入完成，正文已自动排成 ${result.pages.length} 页` });
            const completedNoticeVersion = noticeVersionRef.current;
            window.requestAnimationFrame(() => {
              if (completedNoticeVersion !== noticeVersionRef.current || document.activeElement?.closest(".professional-editor")) return;
              document.querySelector(".professional-editor")?.closest(".control-section")?.scrollIntoView({ behavior: "smooth", block: "start" });
            });
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "分页保真检查失败，请检查正文格式";
        measure.innerHTML = "";
        setContentPages([]);
        setPageUsage([]);
        setActivePreviewPage(0);
        setPaginationState({ inputKey: paginationInputKey, version, status: "error", error: message });
        exportVersionRef.current = null;
        paginationOptimizationRef.current = null;
        importPendingRef.current = null;
        setNotice({ tone: "error", text: message });
        paginationFailedRef.current = noticeVersionRef.current;
      }
    };
    const scheduleUpdate = () => {
      if (cancelled) return;
      if (updateTimer) window.clearTimeout(updateTimer);
      const version = ++paginationVersionRef.current;
      exportVersionRef.current = null;
      setPaginationState({ inputKey: paginationInputKey, version, status: "pending", error: "" });
      updateTimer = window.setTimeout(() => update(version), updateDelay);
    };
    scheduleUpdate();
    document.fonts?.ready.then(scheduleUpdate);
    const parsed = new DOMParser().parseFromString(paginationHtml, "text/html");
    [...parsed.images].slice(0, 80).forEach((source) => {
      const image = new Image();
      image.onload = scheduleUpdate;
      image.onerror = scheduleUpdate;
      image.src = source.src;
    });
    return () => {
      cancelled = true;
      if (updateTimer) window.clearTimeout(updateTimer);
    };
  }, [paginationHtml, paginationHeight, preserveStyles, typeScale, lineHeight, titleFont, bodyFont, posterFontsReady, paginationRevision, pageOffset, layoutStyle, paginationInputKey, setNotice]);

  /* Workspace restoration intentionally hydrates many independent controls once. */
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(WORKSPACE_STORAGE_KEY)
        || window.localStorage.getItem(LEGACY_WORKSPACE_STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as StoredWorkspace;
      if (saved.version !== 1 && saved.version !== 2) return;
      if (saved.mode) setMode(saved.mode);
      if (saved.formatKey) setFormatKey(saved.formatKey);
      if (typeof saved.url === "string") setUrl(saved.url);
      if (typeof saved.rawHtml === "string") setRawHtml(saved.rawHtml);
      if (typeof saved.markdownInput === "string") setMarkdownInput(saved.markdownInput);
      if (typeof saved.title === "string") setTitle(normalizePosterTitle(saved.title));
      if (typeof saved.subtitle === "string") setSubtitle(saved.subtitle);
      if (typeof saved.labName === "string") setLabName(saved.labName);
      if (typeof saved.coverCredit === "string") setCoverCredit(saved.coverCredit);
      if (typeof saved.pageBrand === "string") setPageBrand(saved.pageBrand);
      if (typeof saved.footerText === "string") setFooterText(saved.footerText);
      if (saved.version === 2 && saved.layoutStyle && saved.layoutStyle in LAYOUT_PRESETS) setLayoutStyle(saved.layoutStyle);
      if (saved.version === 2 && typeof saved.autoStructure === "boolean") setAutoStructure(saved.autoStructure);
      if (typeof saved.numberedDotStyle === "boolean") setNumberedDotStyle(saved.numberedDotStyle);
      if (saved.version === 2 && (saved.previewPresentation === "beautified" || saved.previewPresentation === "base")) setPreviewPresentation(saved.previewPresentation);
      if (typeof saved.articleHtml === "string") {
        setArticleHtml(saved.articleHtml);
        setSourceEditorHtml(saved.articleHtml);
        setEditorRevision((revision) => revision + 1);
      }
      if (typeof saved.firstPageContent === "boolean") setFirstPageContent(saved.firstPageContent);
      if (typeof saved.preserveStyles === "boolean") setPreserveStyles(saved.preserveStyles);
      if (typeof saved.typeScale === "number") setTypeScale(saved.typeScale);
      if (typeof saved.lineHeight === "number") setLineHeight(saved.lineHeight);
      if (typeof saved.bottomReserve === "number") setBottomReserve(saved.bottomReserve);
      if (saved.themeKey === null || saved.themeKey && saved.themeKey in THEMES) setThemeKey(saved.themeKey as ThemeKey | null);
      if (typeof saved.paperColor === "string") setPaperColor(saved.paperColor);
      if (typeof saved.accentColor === "string") setAccentColor(saved.accentColor);
      if (typeof saved.textColor === "string") setTextColor(saved.textColor);
      if (typeof saved.highlightColor === "string") setHighlightColor(saved.highlightColor);
      if (saved.titleFont) setTitleFont(saved.titleFont);
      if (saved.bodyFont) setBodyFont(saved.bodyFont);
      if (typeof saved.showRiskNote === "boolean") setShowRiskNote(saved.showRiskNote);
      if (typeof saved.riskTitle === "string") setRiskTitle(saved.riskTitle);
      if (typeof saved.riskText === "string") setRiskText(saved.riskText);
      if (typeof saved.publicationName === "string") setPublicationName(saved.publicationName);
      if (typeof saved.leadGuide === "string") setLeadGuide(saved.leadGuide);
      if (typeof saved.qrDataUrl === "string") setQrDataUrl(saved.qrDataUrl);
      if (Array.isArray(saved.customThemePresets)) setCustomThemePresets(saved.customThemePresets);
      if (Array.isArray(saved.riskPresets)) setRiskPresets(saved.riskPresets);
      setNotice({ tone: "success", text: saved.version === 1 ? "已兼容恢复旧版工作区" : "已恢复上次编辑内容" });
    } catch {
      window.localStorage.removeItem(WORKSPACE_STORAGE_KEY);
    } finally {
      setWorkspaceReady(true);
    }
  }, [setNotice]);
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    if (!workspaceReady) return;
    const timer = window.setTimeout(() => {
      const workspace: SavedWorkspace = {
        version: 2, mode, formatKey, url, rawHtml, markdownInput, title, subtitle, labName, coverCredit, pageBrand, footerText,
        layoutStyle, autoStructure, numberedDotStyle, previewPresentation, articleHtml,
        firstPageContent, preserveStyles, typeScale, lineHeight, bottomReserve, themeKey, paperColor, accentColor,
        textColor, highlightColor, titleFont, bodyFont, showRiskNote, riskTitle, riskText, publicationName, leadGuide, qrDataUrl,
        customThemePresets, riskPresets,
      };
      try {
        window.localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(workspace));
      } catch {
        const withoutQr = { ...workspace, qrDataUrl: "" };
        try {
          window.localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(withoutQr));
        } catch {
          setNotice({ tone: "error", text: "内容过大，浏览器暂时无法保存本次编辑记录" });
        }
      }
    }, 350);
    return () => window.clearTimeout(timer);
  }, [workspaceReady, mode, formatKey, url, rawHtml, markdownInput, title, subtitle, labName, coverCredit, pageBrand, footerText, layoutStyle, autoStructure, numberedDotStyle, previewPresentation, articleHtml, firstPageContent, preserveStyles, typeScale, lineHeight, bottomReserve, themeKey, paperColor, accentColor, textColor, highlightColor, titleFont, bodyFont, showRiskNote, riskTitle, riskText, publicationName, leadGuide, qrDataUrl, customThemePresets, riskPresets, setNotice]);

  useEffect(() => {
    const timer = window.setTimeout(() => setEditorModuleReady(true), 900);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!importOpen && !helpOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      closeImportDialog();
      setHelpOpen(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [helpOpen, importOpen, closeImportDialog]);

  useEffect(() => {
    if (!workspaceReady) return;
    try {
      if (window.localStorage.getItem("zhepage-guide-seen-v1")) return;
      const timer = window.setTimeout(() => setHelpOpen(true), 450);
      return () => window.clearTimeout(timer);
    } catch {
      return;
    }
  }, [workspaceReady]);

  function closeHelp() {
    setHelpOpen(false);
    try {
      window.localStorage.setItem("zhepage-guide-seen-v1", "1");
    } catch {
      // The guide can still close when storage is unavailable.
    }
  }

  function openImportDialog() {
    setEditorModuleReady(true);
    setHelpOpen(false);
    setImportOpen(true);
    window.requestAnimationFrame(() => document.querySelector(".section-title-row")?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  const applySource = useCallback((source: string, sourceKind: "document" | "fragment", inferTitle = false, sourceUrl?: string) => {
    const result = sourceKind === "document"
      ? { ...extractArticle(source, preserveStyles, sourceUrl), inferredTitle: true }
      : extractRichTextFragment(source, preserveStyles, inferTitle);
    if (!result.html.replace(/<[^>]+>/g, "").trim() && !result.html.includes("<img")) throw new Error("没有识别到可排版的正文内容");
    if (sourceKind === "document" || result.inferredTitle) {
      setTitle(normalizePosterTitle(result.title));
      // Metadata descriptions on WeChat are often clipped previews, not the article lede.
      // Leave the optional subtitle blank so the actual first paragraph starts the body.
      setSubtitle("");
    }
    setArticleHtml(result.html);
    setSourceEditorHtml(result.html);
    setEditorRevision((revision) => revision + 1);
    setAutoStructure(true);
    setManualTypesetPreview(true);
    setPreviewPresentation("beautified");
    setNotice({
      tone: "neutral",
      text: "内容已按原富文本格式读取，正在计算完整分页…",
    });
    importPendingRef.current = noticeVersionRef.current;
  }, [preserveStyles, setNotice]);

  function applyTheme(key: ThemeKey) {
    const theme = THEMES[key];
    setThemeKey(key);
    setPaperColor(theme.paper);
    setAccentColor(theme.accent);
    setTextColor(theme.text);
    setHighlightColor(theme.highlight);
  }

  function applyDensityPreset(key: DensityKey) {
    const preset = DENSITY_PRESETS[key];
    setTypeScale(preset.typeScale);
    setLineHeight(preset.lineHeight);
    setBottomReserve(preset.bottomReserve);
    setNotice({ tone: "success", text: `已应用“${preset.label}”排版密度，仍可继续微调` });
  }

  function applyLayoutStyle(key: LayoutStyleKey) {
    setLayoutStyle(key);
    if (key === "xiaohongshu") setManualTypesetPreview(false);
    setPreviewPresentation("beautified");
    setNotice({ tone: "success", text: `已切换为“${LAYOUT_PRESETS[key].name}”，当前配色保持不变` });
  }

  function restoreLayoutRecommendedSettings() {
    setTypeScale(layoutPreset.typeScale);
    setLineHeight(layoutPreset.lineHeight);
    setBottomReserve(layoutPreset.bottomReserve);
    setNotice({ tone: "success", text: `已恢复“${layoutPreset.name}”推荐字号、行距与密度，配色和正文未改动` });
  }

  function optimizePagination() {
    setPaginationRevision((revision) => revision + 1);
    setNotice({ tone: "neutral", text: sparsePageIndex >= 0 ? `正在优化第 ${sparsePageIndex + 1} 页附近的留白…` : "正在重新检查标题与分页平衡…" });
    paginationOptimizationRef.current = { pageCount: contentPages.length, usage: pageUsage, noticeVersion: noticeVersionRef.current };
  }

  function applyAutomaticTypeset(currentHtml = articleHtml, useNumberedDotStyle = numberedDotStyle) {
    const result = beautifyArticle(currentHtml, { numberedDotStyle: useNumberedDotStyle });
    if (result.changes) {
      setArticleHtml(result.html);
      setSourceEditorHtml(result.html);
      setEditorRevision((revision) => revision + 1);
    }
    setAutoStructure(true);
    setManualTypesetPreview(true);
    setPreviewPresentation("beautified");
    setNotice({
      tone: "success",
      text: result.changes
        ? `已识别 ${result.promotedHeadings} 个标题和 ${result.formattedParagraphs} 个重点段落，并同步到编辑器；未使用 AI`
        : "当前正文结构已经清晰，展示层无需继续调整",
    });
  }

  function goToPreviewPage(index: number) {
    const target = Math.max(0, Math.min(totalPages - 1, index));
    setActivePreviewPage(target);
    if (target >= visiblePageCount) setShowAllPreviewPages(true);
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      pageRefs.current[target]?.closest(".poster-wrap")?.scrollIntoView({ behavior: "smooth", block: "center" });
    }));
  }

  function saveCustomTheme() {
    const name = themePresetName.trim();
    if (!name) {
      setNotice({ tone: "error", text: "请先为当前配色命名" });
      return;
    }
    const previous = customThemePresets.find((preset) => preset.name === name);
    const preset: CustomThemePreset = {
      id: previous?.id || makePresetId(), name, paperColor, accentColor, textColor, highlightColor, titleFont, bodyFont,
    };
    setCustomThemePresets((presets) => previous
      ? presets.map((item) => item.id === previous.id ? preset : item)
      : [...presets, preset]);
    setThemePresetName("");
    setNotice({ tone: "success", text: previous ? `配色“${name}”已更新` : `配色“${name}”已保存` });
  }

  function applyCustomTheme(preset: CustomThemePreset) {
    setThemeKey(null);
    setPaperColor(preset.paperColor);
    setAccentColor(preset.accentColor);
    setTextColor(preset.textColor);
    setHighlightColor(preset.highlightColor);
    setTitleFont(preset.titleFont);
    setBodyFont(preset.bodyFont);
    setNotice({ tone: "success", text: `已应用自定义配色“${preset.name}”` });
  }

  function saveRiskPreset() {
    const name = riskPresetName.trim();
    if (!name) {
      setNotice({ tone: "error", text: "请先为当前风险提示命名" });
      return;
    }
    const previous = riskPresets.find((preset) => preset.name === name);
    const preset: RiskPreset = { id: previous?.id || makePresetId(), name, title: riskTitle, text: riskText };
    setRiskPresets((presets) => previous
      ? presets.map((item) => item.id === previous.id ? preset : item)
      : [...presets, preset]);
    setRiskPresetName("");
    setNotice({ tone: "success", text: previous ? `风险提示“${name}”已更新` : `风险提示“${name}”已保存` });
  }

  function applyRiskPreset(preset: RiskPreset) {
    setRiskTitle(preset.title);
    setRiskText(preset.text);
    setShowRiskNote(true);
    setNotice({ tone: "success", text: `已应用风险提示“${preset.name}”` });
  }

  function insertLeadCard() {
    setLeadCardInsertRequest((request) => request + 1);
  }

  function removeLeadCards() {
    const parsed = new DOMParser().parseFromString(articleHtml, "text/html");
    parsed.querySelectorAll(".lead-card-placeholder").forEach((element) => element.remove());
    const nextHtml = parsed.body.innerHTML;
    setArticleHtml(nextHtml);
    setSourceEditorHtml(nextHtml);
    setEditorRevision((revision) => revision + 1);
    setNotice({ tone: "success", text: "领取卡已移除" });
  }

  function handleQrUpload(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setNotice({ tone: "error", text: "请选择 PNG、JPG 或 WebP 二维码图片" });
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      setNotice({ tone: "error", text: "二维码图片请控制在 8MB 以内" });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setQrDataUrl(typeof reader.result === "string" ? reader.result : "");
      setNotice({ tone: "success", text: "二维码已更新，领取卡实时同步" });
    };
    reader.onerror = () => setNotice({ tone: "error", text: "二维码读取失败，请重新选择" });
    reader.readAsDataURL(file);
    event.target.value = "";
  }

  async function generatePosters() {
    if (importRequestRef.current) return;
    if (mode === "url" && !url.trim()) {
      setNotice({ tone: "error", text: "请先输入文章链接" });
      return;
    }
    setWorking(true);
    setNotice({ tone: "neutral", text: "正在读取并整理内容…" });
    const controller = new AbortController();
    importRequestRef.current = controller;
    const originalArticleHtml = articleHtml;
    const canApplyImport = () => {
      if (importRequestRef.current !== controller) return false;
      if (controller.signal.aborted) throw new DOMException("Import timed out", "AbortError");
      if (currentArticleHtmlRef.current !== originalArticleHtml) throw new Error("正文已更新，已停止本次导入，请确认当前内容后重新导入");
      return true;
    };
    const timeout = window.setTimeout(() => controller.abort(), 45000);
    try {
      if (mode === "url") {
        const response = await fetch("/api/import", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url }),
          signal: controller.signal,
        });
        const payload = await response.json().catch(() => ({})) as { html?: string; error?: string; finalUrl?: string };
        if (!canApplyImport()) return;
        if (!response.ok || !payload.html) throw new Error(payload.error || "文章读取失败");
        applySource(payload.html, "document", false, payload.finalUrl || url);
      } else if (mode === "html") {
        const isDocument = rawHtml.includes("<html") || rawHtml.includes("<head");
        applySource(rawHtml, isDocument ? "document" : "fragment", !isDocument);
      } else if (mode === "markdown") {
        if (!markdownInput.trim()) throw new Error("请先粘贴 Markdown 内容");
        const { marked } = await withTimeout(import("marked"), 20000, "Markdown 转换组件加载超时，请刷新后重试");
        if (!canApplyImport()) return;
        const markdownWithHighlights = markdownInput.replace(/==([^=\n]+)==/g, '<mark data-highlight-style="marker">$1</mark>');
        const convertedHtml = await marked.parse(markdownWithHighlights, { gfm: true, breaks: true });
        if (!canApplyImport()) return;
        applySource(String(convertedHtml), "fragment", true);
      } else {
        applySource(sourceEditorHtml, "fragment", true);
      }
      setImportOpen(false);
    } catch (error) {
      if (importRequestRef.current !== controller) return;
      const message = error instanceof DOMException && error.name === "AbortError"
        ? "读取超时，请重试或改用 HTML 粘贴"
        : error instanceof Error ? error.message : "生成失败，请检查内容";
      setNotice({ tone: "error", text: message });
    } finally {
      window.clearTimeout(timeout);
      if (importRequestRef.current === controller) {
        importRequestRef.current = null;
        setWorking(false);
      }
    }
  }
  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <span className="brand-mark">折</span>
          <div><strong>折页</strong><span>把长内容拆解成富文本图片</span></div>
        </div>
        <div className="top-actions">
          <span className={`status-pill ${notice.tone}`}><i />{notice.text}</span>
          <button className="help-trigger" type="button" onClick={() => {
            closeImportDialog();
            setHelpOpen(true);
          }}><i aria-hidden="true">?</i><span>使用说明</span></button>
          <button className="primary compact" onClick={exportAll} disabled={exporting || !paginationReady}>{exporting ? "处理中…" : !posterFontsReady ? "字体加载中…" : paginationError ? "排版失败" : paginationReady ? `批量导出 ${totalPages} 张` : "正在排版…"}</button>
        </div>
      </header>

      <div className="studio-layout">
        <aside className="control-panel">
          <section className="control-section intro-section">
            <span className="eyebrow">折页工作台</span>
            <h1>从文章到贴图，<br />保留原来的表达。</h1>
            <p>正文只在“排版编辑”中修改；需要更换文章时，点击其中的“一键导入”。</p>
          </section>

          <section className="control-section">
            <span className="eyebrow">01 · 封面文案</span>
            <div className="field-stack"><label htmlFor="poster-title">醒目标题</label><textarea id="poster-title" className="title-input" value={title} maxLength={MAX_TITLE_LENGTH + MAX_TITLE_LINES - 1} onChange={(event) => {
              const normalized = normalizePosterTitle(event.target.value);
              setTitle(normalized);
              if (normalized !== event.target.value) setNotice({ tone: "error", text: `标题最多 ${MAX_TITLE_LENGTH} 字、${MAX_TITLE_LINES} 行` });
            }} /><small>{Array.from(title.replace(/\n/g, "")).length} / {MAX_TITLE_LENGTH} 字 · 最多 {MAX_TITLE_LINES} 行</small></div>
            <div className="field-stack"><label htmlFor="poster-subtitle">导语 / 副标题（可留空）</label><input id="poster-subtitle" value={subtitle} onChange={(event) => setSubtitle(event.target.value)} placeholder="留空时，标题后直接展示正文" /></div>
            <div className="microcopy-grid">
              <div className="field-stack"><label htmlFor="lab-name">底部栏目名</label><input id="lab-name" value={labName} onChange={(event) => setLabName(event.target.value)} /></div>
              <div className="field-stack"><label htmlFor="cover-credit">封面署名</label><input id="cover-credit" value={coverCredit} onChange={(event) => setCoverCredit(event.target.value)} /></div>
            </div>
            <div className="field-stack"><label htmlFor="page-brand">正文页眉（图片顶部）</label><input id="page-brand" value={pageBrand} onChange={(event) => setPageBrand(event.target.value)} /></div>
            <div className="field-stack footer-copy-field"><label htmlFor="footer-text">图片左下角文案（图片底部）</label><input id="footer-text" value={footerText} onChange={(event) => setFooterText(event.target.value)} placeholder="例如：投资有风险，入市需谨慎" maxLength={40} /><small>该文字会显示在每张正文图的左下角，与顶部页眉独立。</small></div>
          </section>

          <section className="control-section">
            <span className="eyebrow">02 · PDF 刊物领取卡</span>
            <div className="field-stack"><label htmlFor="publication-name">刊物名称（可编辑）</label><textarea id="publication-name" className="publication-input" value={publicationName} onChange={(event) => setPublicationName(event.target.value)} /></div>
            <div className="field-stack"><label htmlFor="lead-guide">领取引导语</label><input id="lead-guide" value={leadGuide} onChange={(event) => setLeadGuide(event.target.value)} /></div>
            <div className="qr-upload-row">
              <input id="qr-upload" className="qr-file-input" type="file" accept="image/png,image/jpeg,image/webp" onChange={handleQrUpload} />
              <label className="qr-upload-button" htmlFor="qr-upload">{qrDataUrl ? "更换二维码" : "上传二维码"}</label>
              {qrDataUrl ? <img src={qrDataUrl} alt="已上传的二维码预览" /> : <span>支持 PNG / JPG / WebP</span>}
            </div>
            <div className="lead-card-actions">
              <button className="primary" onMouseDown={(event) => event.preventDefault()} onClick={insertLeadCard}>在光标处插入领取卡</button>
              {leadCardCount > 0 && <button onClick={removeLeadCards}>移除全部（{leadCardCount}）</button>}
            </div>
            <small className="module-tip">先在下方编辑框放置光标，再点击插入。卡片文案与二维码修改后会实时同步。</small>
          </section>

          <section className="control-section last">
            <div className="section-title-row">
              <span className="eyebrow">03 · 排版编辑</span>
              <button className="import-trigger" type="button" onClick={openImportDialog}>＋ 一键导入</button>
            </div>
            {editorModuleReady ? <Suspense fallback={<EditorFallback />}><ZhepageEditor
              html={articleHtml}
              revision={editorRevision}
              accentColor={accentColor}
              highlightColor={highlightColor}
              insertLeadCardRequest={leadCardInsertRequest}
              numberedDotStyle={numberedDotStyle}
              onNumberedDotStyleChange={setNumberedDotStyle}
              onChange={(nextHtml) => {
                const cleaned = removeEmptyHeadings(nextHtml);
                setArticleHtml(cleaned);
                setSourceEditorHtml(cleaned);
              }}
              onAutoTypeset={applyAutomaticTypeset}
              onNotice={(text, tone = "success") => setNotice({ tone, text })}
            /></Suspense> : <EditorFallback />}
            <div className="editor-note"><span>格式按钮具有激活态，再次点击即可取消；鼠标悬停按钮可查看说明。</span></div>

          </section>

          <section className="control-section">
            <span className="eyebrow">04 · 视觉样式</span>
            <div className="visual-style-heading"><b>排版风格</b><span>排版与配色可自由组合</span></div>
            <div className="layout-style-grid" aria-label="排版风格">
              {LAYOUT_STYLE_KEYS.map((key) => {
                const preset = LAYOUT_PRESETS[key];
                return <button type="button" key={key} className={`layout-style-choice ${layoutStyle === key ? "selected" : ""}`} onClick={() => applyLayoutStyle(key)}>
                  <span className={`layout-structure-thumb thumb-${key}`} aria-hidden="true">
                    <i className="thumb-brand" /><i className="thumb-index" /><i className="thumb-title" /><i className="thumb-rule" /><i className="thumb-body" /><i className="thumb-card" />
                  </span>
                  <span className="layout-choice-copy"><b>{preset.name}{preset.recommended && <em>推荐</em>}</b><small>{preset.detail}</small></span>
                </button>;
              })}
            </div>

            <label className="switch-row first-page-switch" aria-label="第一页使用标题加正文">
              <span><b>第一页使用“标题 + 正文”</b><small>大标题约占半屏，实际正文紧接其后</small></span>
              <input type="checkbox" checked={firstPageContent} onChange={(event) => setFirstPageContent(event.target.checked)} />
              <i aria-hidden="true" />
            </label>

            {layoutStyle !== "xiaohongshu" && <label className="switch-row auto-structure-switch" aria-label="自动识别文章结构">
              <span><b>自动识别文章结构</b><small>自动识别章节、数据段、引用、列表和图片，不改写正文。</small></span>
              <input type="checkbox" checked={autoStructure} onChange={(event) => setAutoStructure(event.target.checked)} />
              <i aria-hidden="true" />
            </label>}

            <details className="theme-selector">
              <summary>
                <span><small>当前配色</small><b>{activeThemeName}</b></span>
                <span className="theme-summary-swatches" aria-hidden="true"><i style={{ background: paperColor }} /><i style={{ background: accentColor }} /><i style={{ background: textColor }} /><i style={{ background: highlightColor }} /></span>
                <em aria-hidden="true">⌄</em>
              </summary>
              <div className="theme-selector-panel">
                <span className="theme-group-label">核心配色</span>
                <div className="theme-grid" aria-label="核心主题配色">
                  {CORE_THEME_KEYS.map((key) => {
                    const theme = THEMES[key];
                    return <button type="button" key={key} className={`theme-choice ${themeKey === key ? "selected" : ""}`} onClick={() => applyTheme(key)}>
                      <span className="theme-swatch" style={{ background: theme.paper }}><i style={{ background: theme.accent }} /><i style={{ background: theme.text }} /><i style={{ background: theme.highlight }} /></span>
                      <span><b>{theme.name}</b><small>{theme.detail}</small></span>
                    </button>;
                  })}
                </div>
                <span className="theme-group-label">更多配色</span>
                <div className="theme-grid reference-theme-grid" aria-label="更多主题配色">
                  {REFERENCE_THEME_KEYS.map((key, index) => {
                    const theme = THEMES[key];
                    return <button type="button" key={key} className={`theme-choice ${themeKey === key ? "selected" : ""}`} onClick={() => applyTheme(key)}>
                      <span className="theme-swatch" style={{ background: theme.paper }}><i style={{ background: theme.accent }} /><i style={{ background: theme.text }} /><i style={{ background: theme.highlight }} /></span>
                      <span><b>{theme.name}</b><small>色卡 {String(index + 1).padStart(2, "0")} · {theme.detail}</small></span>
                    </button>;
                  })}
                  {customThemePresets.map((preset) => {
                    const selected = selectedCustomTheme?.id === preset.id;
                    return <div className="custom-theme-option" key={preset.id}>
                      <button type="button" className={`theme-choice ${selected ? "selected" : ""}`} onClick={() => applyCustomTheme(preset)}>
                        <span className="theme-swatch" style={{ background: preset.paperColor }}><i style={{ background: preset.accentColor }} /><i style={{ background: preset.textColor }} /><i style={{ background: preset.highlightColor }} /></span>
                        <span><b>{preset.name}</b><small>自定义 · 点击应用</small></span>
                      </button>
                      <button type="button" className="custom-theme-delete" aria-label={`删除配色 ${preset.name}`} title="删除此配色" onClick={() => setCustomThemePresets((presets) => presets.filter((item) => item.id !== preset.id))}>×</button>
                    </div>;
                  })}
                </div>
              </div>
            </details>
            <small className="theme-linkage-note">标题、重点、引用、数据卡和表格会统一跟随当前主题色。</small>

            <details className="visual-advanced-settings">
              <summary><span><b>微调 / 高级设置</b><small>字体、密度、字号、行距和自定义颜色</small></span><i aria-hidden="true" /></summary>
              <div className="visual-advanced-body">
                <div className="font-grid">
                  <label><span>标题字体</span><select value={titleFont} onChange={(event) => setTitleFont(event.target.value as FontKey)}><option value="sans">思源黑体</option><option value="serif">思源宋体</option></select></label>
                  <label><span>正文字体</span><select value={bodyFont} onChange={(event) => setBodyFont(event.target.value as FontKey)}><option value="serif">思源宋体</option><option value="sans">思源黑体</option></select></label>
                </div>
                <div className="density-presets" aria-label="排版密度预设">
                  {(["compact", "standard", "spacious"] as DensityKey[]).map((key) => <button key={key} type="button" onClick={() => applyDensityPreset(key)}>{DENSITY_PRESETS[key].label}</button>)}
                </div>
                <div className="adjustment-grid">
                  <label><span>字号 <b>{Math.round(typeScale * 100)}%</b></span><input type="range" min="0.82" max="1.24" step="0.02" value={typeScale} onChange={(event) => setTypeScale(Number(event.target.value))} /></label>
                  <label><span>行距 <b>{lineHeight.toFixed(2)}</b></span><input type="range" min="1.4" max="2.05" step="0.05" value={lineHeight} onChange={(event) => setLineHeight(Number(event.target.value))} /></label>
                  <label><span>页底留白 <b>{bottomReserve}px</b></span><input type="range" min="0" max="180" step="20" value={bottomReserve} onChange={(event) => setBottomReserve(Number(event.target.value))} /></label>
                </div>
                <button type="button" className="restore-layout-button" onClick={restoreLayoutRecommendedSettings}>恢复「{layoutPreset.name}」推荐设置</button>
                <div className="pagination-actions"><button type="button" className="smart-pagination-button" onClick={optimizePagination}>自动优化分页</button></div>
                <small className={`pagination-health ${sparsePageIndex >= 0 ? "warning" : "good"}`}>{sparsePageIndex >= 0 ? `第 ${sparsePageIndex + 1} 页留白较多，可尝试自动优化` : "正文会保真跨页续排，优化不会改写文字"}</small>
                <details className="custom-colors">
                  <summary>高级自定义颜色</summary>
                  <UnifiedColorPopover
                    className="page-color-control"
                    triggerLabel="打开统一颜色面板"
                    clearLabel="恢复主题默认色"
                    targets={[
                      { id: "paper", label: "纸张", color: paperColor, fallbackColor: THEMES.whiteRed.paper, onApply: (color) => { setThemeKey(null); setPaperColor(color); }, onClear: () => { setThemeKey(null); setPaperColor(THEMES.whiteRed.paper); } },
                      { id: "accent", label: "标题", color: accentColor, fallbackColor: THEMES.whiteRed.accent, onApply: (color) => { setThemeKey(null); setAccentColor(color); }, onClear: () => { setThemeKey(null); setAccentColor(THEMES.whiteRed.accent); } },
                      { id: "text", label: "正文", color: textColor, fallbackColor: THEMES.whiteRed.text, onApply: (color) => { setThemeKey(null); setTextColor(color); }, onClear: () => { setThemeKey(null); setTextColor(THEMES.whiteRed.text); } },
                      { id: "highlight", label: "高亮", color: highlightColor, fallbackColor: THEMES.whiteRed.highlight, onApply: (color) => { setThemeKey(null); setHighlightColor(color); }, onClear: () => { setThemeKey(null); setHighlightColor(THEMES.whiteRed.highlight); } },
                    ]}
                  />
                  <div className="preset-save-row">
                    <input aria-label="自定义配色名称" value={themePresetName} onChange={(event) => setThemePresetName(event.target.value)} placeholder="例如：品牌红金" />
                    <button type="button" onClick={saveCustomTheme}>保存当前配色</button>
                  </div>
                  <small className="custom-theme-save-hint">保存后会进入上方配色选择器，并显示纸张、标题、正文和高亮四个色块。</small>
                </details>
              </div>
            </details>
          </section>

          <section className="control-section last">
            <span className="eyebrow">05 · 风险提示</span>
            <label className="switch-row first-page-switch" aria-label="末页显示免责声明">
              <span><b>末页显示免责声明</b><small>自动放在最后，空间不足则完整另起一页</small></span>
              <input type="checkbox" checked={showRiskNote} onChange={(event) => setShowRiskNote(event.target.checked)} />
              <i aria-hidden="true" />
            </label>
            {showRiskNote && <>
              <div className="field-stack"><label htmlFor="risk-title">提示标题</label><input id="risk-title" value={riskTitle} onChange={(event) => setRiskTitle(event.target.value)} /></div>
              <div className="field-stack"><label htmlFor="risk-text">提示内容</label><textarea id="risk-text" className="risk-input" value={riskText} onChange={(event) => setRiskText(event.target.value)} /></div>
              <div className="preset-save-row risk-preset-save">
                <input aria-label="风险提示版本名称" value={riskPresetName} onChange={(event) => setRiskPresetName(event.target.value)} placeholder="例如：投顾标准版" />
                <button type="button" onClick={saveRiskPreset}>保存当前版本</button>
              </div>
              {riskPresets.length > 0 && <div className="saved-preset-list" aria-label="已保存的风险提示版本">
                {riskPresets.map((preset) => <div key={preset.id} className="saved-preset-item">
                  <button type="button" className="preset-apply" onClick={() => applyRiskPreset(preset)}><span>{preset.name}</span></button>
                  <button type="button" className="preset-delete" aria-label={`删除风险提示 ${preset.name}`} title="删除此版本" onClick={() => setRiskPresets((presets) => presets.filter((item) => item.id !== preset.id))}>×</button>
                </div>)}
              </div>}
            </>}
          </section>

          <section className="control-section last">
            <span className="eyebrow">06 · 成图尺寸</span>
            <div className="format-grid">
              {(Object.keys(FORMATS) as FormatKey[]).map((key) => (
                <button key={key} className={formatKey === key ? "selected" : ""} onClick={() => setFormatKey(key)}>
                  <i className={`ratio-icon ${key}`} /><span><b>{FORMATS[key].label}</b><small>{FORMATS[key].detail}</small></span>
                </button>
              ))}
            </div>
          </section>
        </aside>

        <section className="preview-workspace">
          <div className="workspace-heading">
            <div><span className="eyebrow" aria-live="polite">{!paginationReady && contentPageCount > 0 ? "预览更新中 · 暂示上次排版" : "实时预览"}</span><h2>{contentPageCount ? `${totalPages} 张贴图` : paginationError ? "排版失败" : "正在排版"} · {format.label}</h2></div>
            <div className="preview-toolbar" aria-label="预览导航">
              <div className="preview-pager">
                <button type="button" onClick={() => goToPreviewPage(activePreviewPage - 1)} disabled={!totalPages || activePreviewPage === 0} aria-label="上一页">‹</button>
                <b>{totalPages ? `${activePreviewPage + 1} / ${totalPages}` : "— / —"}</b>
                <button type="button" onClick={() => goToPreviewPage(activePreviewPage + 1)} disabled={!totalPages || activePreviewPage >= totalPages - 1} aria-label="下一页">›</button>
              </div>
              {(layoutStyle !== "xiaohongshu" || manualTypesetPreview) && <div className="presentation-toggle" aria-label="预览展示方式">
                <button type="button" className={previewPresentation === "beautified" ? "active" : ""} onClick={() => setPreviewPresentation("beautified")}>美化后</button>
                <button type="button" className={previewPresentation === "base" ? "active" : ""} onClick={() => setPreviewPresentation("base")}>基础样式</button>
              </div>}
              <label className="preview-zoom"><span>缩放</span><select value={previewZoom} onChange={(event) => setPreviewZoom(event.target.value as PreviewZoom)}><option value="fit">适合宽度</option><option value="0.5">50%</option><option value="0.75">75%</option><option value="1">100%</option></select></label>
              {!showAllPreviewPages && totalPages > 4 && <button type="button" className="preview-all-button" onClick={() => setShowAllPreviewPages(true)}>查看全部页面</button>}
            </div>
          </div>

          <div className="preview-page-jump" aria-label="快速跳转页面">
            {Array.from({ length: totalPages }, (_, index) => <button key={index} type="button" className={activePreviewPage === index ? "active" : ""} onClick={() => goToPreviewPage(index)}>{index + 1}</button>)}
          </div>

          {!posterFontsReady && !contentPageCount && <div className="poster-font-loading" role="status"><div><i aria-hidden="true" /><b>正在载入思源字体</b><span>字体完成后再计算分页，确保 Windows 与 macOS 一致</span></div></div>}
          {posterFontsReady && !paginationReady && !contentPageCount && <div className="poster-font-loading" role="status"><div>
            {!paginationError && <i aria-hidden="true" />}
            <b>{paginationError ? "当前内容排版失败" : "正在排版当前内容"}</b>
            <span>{paginationError || "排版完成后将显示最新预览，并恢复导出"}</span>
            {paginationError && <button type="button" className="smart-pagination-button" onClick={() => setPaginationRevision((revision) => revision + 1)}>重新排版</button>}
          </div></div>}

          <div className={`poster-grid ${posterFontsReady || contentPageCount > 0 ? "fonts-ready" : "fonts-loading"}`} aria-busy={!paginationReady} style={{
            "--page-height": `${format.height}px`,
            ...(previewScale ? { "--preview-scale": previewScale } : {}),
            "--poster-paper": paperColor,
            "--poster-accent": accentColor,
            "--poster-text": textColor,
            "--poster-highlight": highlightColor,
            "--poster-on-accent": themeTokens.onAccent,
            "--poster-muted": themeTokens.mutedText,
            "--poster-accent-soft": themeTokens.softAccent,
            "--poster-accent-softer": themeTokens.softerAccent,
            "--poster-accent-border": themeTokens.borderAccent,
            "--poster-title-font": titleFont === "serif" ? "var(--font-source-han-serif)" : "var(--font-source-han-sans)",
            "--poster-body-font": bodyFont === "serif" ? "var(--font-source-han-serif)" : "var(--font-source-han-sans)",
          } as React.CSSProperties}>
            {!firstPageContent && visiblePageCount > 0 && <div className={`poster-wrap ${activePreviewPage === 0 ? "active" : ""}`} role="button" tabIndex={0} aria-label="选择封面预览" onClick={() => setActivePreviewPage(0)} onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") setActivePreviewPage(0);
            }}>
              <PosterCover
                layoutStyle={layoutStyle}
                title={title}
                subtitle={subtitle}
                pageBrand={pageBrand}
                labName={labName}
                coverCredit={coverCredit}
                totalPages={totalPages}
                width={format.width}
                height={format.height}
                exporting={exporting}
                fontsReady={paginationReady}
                onExport={() => exportOne(0)}
                setRef={(node) => { pageRefs.current[0] = node; }}
              />
            </div>}

            {contentPages.slice(0, Math.max(0, visiblePageCount - pageOffset)).map((pageHtml, pageIndex) => (
              <div className={`poster-wrap ${activePreviewPage === pageIndex + pageOffset ? "active" : ""}`} key={pageIndex} role="button" tabIndex={0} aria-label={`选择第 ${pageIndex + pageOffset + 1} 页预览`} onClick={() => setActivePreviewPage(pageIndex + pageOffset)} onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") setActivePreviewPage(pageIndex + pageOffset);
              }}>
                <article className={`poster-page content-page ${layoutClass}`} data-layout-style={layoutStyle} ref={(node) => { pageRefs.current[pageIndex + pageOffset] = node; }} style={{ width: format.width, height: format.height }}>
                  <header><span>{pageBrand}</span><b>{String(pageIndex + 1).padStart(2, "0")}</b></header>
                  <div className="article-viewport" style={{ height: contentHeight }}>
                    <div className={`article-flow ${layoutClass} ${preserveStyles ? "preserve" : "unified"}`} style={{ "--type-scale": typeScale, "--article-leading": lineHeight } as React.CSSProperties} dangerouslySetInnerHTML={{ __html: pageHtml }} />
                  </div>
                  <footer><span>{footerText.trim() || labName.trim()}</span><span>{pageIndex + 1} / {contentPageCount}</span></footer>
                  <button className="page-export" onClick={() => exportOne(pageIndex + pageOffset)} disabled={exporting || !paginationReady} aria-label={`导出第 ${pageIndex + pageOffset + 1} 页`}>↓</button>
                </article>
              </div>
            ))}
          </div>

          {!showAllPreviewPages && totalPages > 4 && <button className="load-more-pages" type="button" onClick={() => setShowAllPreviewPages(true)}>
            显示后面的全部 {totalPages - 4} 张贴图
          </button>}

          <div className="measure-viewport" aria-hidden="true" style={{ height: contentHeight }}>
            <div ref={measureRef} className={`article-flow article-measure ${layoutClass} ${preserveStyles ? "preserve" : "unified"}`} style={{
              "--type-scale": typeScale,
              "--article-leading": lineHeight,
              "--poster-paper": paperColor,
              "--poster-accent": accentColor,
              "--poster-text": textColor,
              "--poster-highlight": highlightColor,
              "--poster-on-accent": themeTokens.onAccent,
              "--poster-muted": themeTokens.mutedText,
              "--poster-accent-soft": themeTokens.softAccent,
              "--poster-accent-softer": themeTokens.softerAccent,
              "--poster-accent-border": themeTokens.borderAccent,
              "--poster-title-font": titleFont === "serif" ? "var(--font-source-han-serif)" : "var(--font-source-han-sans)",
              "--poster-body-font": bodyFont === "serif" ? "var(--font-source-han-serif)" : "var(--font-source-han-sans)",
            } as React.CSSProperties} />
          </div>
        </section>
      </div>

      {importOpen && <div className="import-modal-backdrop" role="presentation" onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeImportDialog();
      }}>
        <section className="import-modal" role="dialog" aria-modal="true" aria-labelledby="import-modal-title">
          <header>
            <div><span className="eyebrow">正文来源</span><h2 id="import-modal-title">一键导入并替换正文</h2></div>
            <button type="button" className="modal-close" onClick={closeImportDialog} aria-label="关闭导入窗口">×</button>
          </header>
          <p className="import-modal-tip">选择一种来源导入。导入完成后请回到“排版编辑”继续修改，当前正文会被替换。</p>
          <div className="segmented import-source-tabs" aria-label="内容输入方式">
            {(["url", "html", "editor", "markdown"] as InputMode[]).map((item) => (
              <button key={item} className={mode === item ? "active" : ""} disabled={working} onClick={() => {
                setMode(item);
                if (item === "editor") setEditorModuleReady(true);
                setNotice({
                  tone: "neutral",
                  text: item === "url" ? "请输入公开文章链接"
                    : item === "html" ? "请粘贴 HTML 源码"
                    : item === "editor" ? "请粘贴完整文章，首行标题会自动识别"
                    : "请粘贴 Markdown 内容",
                });
              }}>
                {item === "url" ? "文章链接" : item === "html" ? "HTML" : item === "editor" ? "富文本" : "Markdown"}
              </button>
            ))}
          </div>

          <div className="import-modal-content">
            {mode === "url" && <div className="field-stack"><label htmlFor="article-url">公开文章地址</label><textarea id="article-url" className="url-input" value={url} onChange={(event) => setUrl(event.target.value)} spellCheck={false} disabled={working} /><small>已重点适配微信公众号；其他公开 article / main 页面也可尝试。</small></div>}
            {mode === "html" && <div className="field-stack"><label htmlFor="article-html">HTML 源码</label><textarea id="article-html" className="code-input" value={rawHtml} onChange={(event) => setRawHtml(event.target.value)} spellCheck={false} disabled={working} /></div>}
            {mode === "editor" && <div className="field-stack"><div className="field-label">粘贴富文本</div>{editorModuleReady ? <Suspense fallback={<EditorFallback />}><ZhepageEditor
              compact
              html={sourceEditorHtml}
              revision={editorRevision}
              accentColor={accentColor}
              highlightColor={highlightColor}
              onChange={setSourceEditorHtml}
              onNotice={(text, tone = "success") => setNotice({ tone, text })}
            /></Suspense> : <EditorFallback />}</div>}
            {mode === "markdown" && <div className="field-stack">
              <label htmlFor="article-markdown">Markdown 内容</label>
              <textarea id="article-markdown" className="code-input markdown-import-input" value={markdownInput} onChange={(event) => setMarkdownInput(event.target.value)} placeholder={'# 标题\n\n支持 **粗体**、*斜体*、==高亮==、引用、列表和表格。'} spellCheck={false} disabled={working} />
              <small>Markdown 仅在导入时单向转换为富文本；导入后请在“排版编辑”中继续修改，不会再发生模式往返丢失。</small>
            </div>}
          </div>

          <label className="switch-row import-style-switch" aria-label="保留原文样式">
            <span><b>保留原文样式（推荐）</b><small>{preserveStyles ? "保留颜色、边框、卡片结构与图片" : "使用当前主题重新排版"}</small></span>
            <input type="checkbox" checked={preserveStyles} onChange={(event) => setPreserveStyles(event.target.checked)} disabled={working} />
            <i aria-hidden="true" />
          </label>
          <div className="import-modal-actions">
            <button type="button" onClick={closeImportDialog}>取消</button>
            <button className="primary" type="button" onClick={generatePosters} disabled={working}>{working ? "正在导入…" : "导入并替换正文 →"}</button>
          </div>
          <div className={`inline-notice ${notice.tone}`} role="status" aria-live="polite"><i />{notice.text}</div>
        </section>
      </div>}

      {helpOpen && <div className="guide-modal-backdrop" role="presentation" onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeHelp();
      }}>
        <section className="guide-modal" role="dialog" aria-modal="true" aria-labelledby="guide-modal-title">
          <header className="guide-header">
            <div><span className="guide-kicker">QUICK START</span><h2 id="guide-modal-title">把一篇长文，变成一组可以直接发布的贴图</h2><p>不需要懂设计。导入正文、调整排版、选择尺寸，三步完成。</p></div>
            <button type="button" className="modal-close" onClick={closeHelp} aria-label="关闭使用说明">×</button>
          </header>

          <div className="guide-steps">
            <article className="guide-step">
              <div className="guide-visual guide-import-visual" aria-hidden="true">
                <div className="guide-fake-bar"><i /><i /><i /></div>
                <div className="guide-fake-input">粘贴公众号文章链接</div>
                <div className="guide-fake-button">导入并替换正文 →</div>
              </div>
              <div className="guide-copy"><span>01</span><h3>一键导入内容</h3><p>在“排版编辑”右上角点击一键导入。支持文章链接、HTML、富文本和 Markdown。</p></div>
            </article>

            <article className="guide-step">
              <div className="guide-visual guide-edit-visual" aria-hidden="true">
                <div className="guide-mini-tools"><b>B</b><b>H2</b><b>高亮</b><b>＋图片</b></div>
                <div className="guide-text-line is-title" /><div className="guide-text-line" /><div className="guide-text-line is-short" />
                <div className="guide-live-chip">右侧实时预览</div>
              </div>
              <div className="guide-copy"><span>02</span><h3>编辑并检查分页</h3><p>直接在唯一的正文编辑器修改。标题、引用、高亮、表格、图片和手动分页都会实时同步。</p></div>
            </article>

            <article className="guide-step">
              <div className="guide-visual guide-export-visual" aria-hidden="true">
                <div className="guide-poster-card"><i>01</i><strong>标题</strong><span /><span /></div>
                <div className="guide-poster-card is-back"><i>02</i><strong>正文</strong><span /><span /></div>
                <div className="guide-download-badge">↓ PNG / ZIP</div>
              </div>
              <div className="guide-copy"><span>03</span><h3>选择尺寸并导出</h3><p>选择小红书、公众号或竖屏尺寸；单页下载 PNG，顶部按钮可批量导出全部页面。</p></div>
            </article>
          </div>

          <div className="guide-note"><b>小提示</b><span>页面会自动保存你的正文、配色和风险提示，下次打开可以继续编辑。</span></div>
          <footer className="guide-actions">
            <button type="button" onClick={closeHelp}>我先看看示例</button>
            <button className="primary" type="button" onClick={() => {
              try { window.localStorage.setItem("zhepage-guide-seen-v1", "1"); } catch {
                // Import remains available when storage is unavailable.
              }
              openImportDialog();
            }}>开始导入文章 →</button>
          </footer>
        </section>
      </div>}
    </main>
  );
}
