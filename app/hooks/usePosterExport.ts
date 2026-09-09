"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { withTimeout } from "../../lib/async/withTimeout";
import { preparePosterSnapshot } from "../../lib/export/preparePosterSnapshot";

export type ExportVersion = { inputKey: string; paginationVersion: number };
type ExportNotice = { tone: "neutral" | "success" | "error"; text: string };
type PosterExportOptions = {
  exportVersionRef: RefObject<ExportVersion | null>;
  pageRefs: RefObject<Array<HTMLElement | null>>;
  contentPages: string[];
  pageOffset: number;
  totalPages: number;
  format: { width: number; height: number };
  formatKey: string;
  title: string;
  paperColor: string;
  fontKey: string;
  waitForFonts: () => Promise<void>;
  setShowAllPreviewPages: (show: boolean) => void;
  onNotice: (notice: ExportNotice) => void;
};

function downloadDataUrl(dataUrl: string, filename: string) {
  const anchor = document.createElement("a");
  anchor.download = filename;
  anchor.href = dataUrl;
  anchor.click();
}

function formatExportLabel(formatKey: string) {
  if (formatKey === "xiaohongshu") return "小红书";
  if (formatKey === "portrait") return "公众号";
  return "竖屏";
}

function formatExportTitle(title: string) {
  const safeTitle = title
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .replace(/[\\/:*?"<>|]/g, "");
  return Array.from(safeTitle).slice(0, 8).join("") || "未命名";
}

function assertExportSemantics(node: HTMLElement, expectedHtml: string) {
  const expected = new DOMParser().parseFromString(expectedHtml, "text/html").body;
  const preview = node.querySelector<HTMLElement>(".article-flow");
  const template = node.ownerDocument.createElement("template");
  template.innerHTML = node.outerHTML;
  const clone = template.content.querySelector<HTMLElement>(".article-flow");
  if (!preview || !clone) throw new Error("导出正文节点缺失，请刷新页面后重试");
  const selectors = ["h1", "h2", "h3", "strong", "b", "em", "i", "u", "s", "strike", "span[style]", "mark", "blockquote", "ul", "ol", "img", "table"];
  for (const selector of selectors) {
    const expectedCount = expected.querySelectorAll(selector).length;
    if (preview.querySelectorAll(selector).length !== expectedCount || clone.querySelectorAll(selector).length !== expectedCount) {
      throw new Error(`导出前检查失败：${selector} 格式节点未完整保留`);
    }
  }
  const normalizeText = (value: string | null) => (value || "").replace(/\s+/g, "");
  if (normalizeText(preview.textContent) !== normalizeText(expected.textContent) || normalizeText(clone.textContent) !== normalizeText(expected.textContent)) {
    throw new Error("导出前检查失败：分页正文存在缺字或重复");
  }
}

export function usePosterExport({
  exportVersionRef, pageRefs, contentPages, pageOffset, totalPages,
  format, formatKey, title, paperColor, fontKey, waitForFonts,
  setShowAllPreviewPages, onNotice: setNotice,
}: PosterExportOptions) {
  const [exporting, setExporting] = useState(false);
  const htmlToImageModuleRef = useRef<Promise<typeof import("html-to-image")> | null>(null);
  const jsZipModuleRef = useRef<Promise<{ default: typeof import("jszip") }> | null>(null);
  const fontEmbedCssRef = useRef<{ key: string; promise: Promise<string> } | null>(null);

  useEffect(() => {
    fontEmbedCssRef.current = null;
  }, [fontKey]);

  async function getHtmlToImageModule() {
    htmlToImageModuleRef.current ||= import("html-to-image");
    try {
      return await withTimeout(htmlToImageModuleRef.current, 20000, "导出组件加载超时，请刷新页面后重试");
    } catch (error) {
      htmlToImageModuleRef.current = null;
      throw error;
    }
  }

  async function getPosterFontEmbedCss(node: HTMLElement, imageModule: typeof import("html-to-image")) {
    const key = fontKey;
    if (fontEmbedCssRef.current?.key !== key) {
      fontEmbedCssRef.current = {
        key,
        promise: imageModule.getFontEmbedCSS(node, {
          cacheBust: false,
          preferredFontFormat: "woff2",
          fetchRequestInit: { cache: "force-cache" },
        }),
      };
    }
    try {
      return await withTimeout(fontEmbedCssRef.current.promise, 90000, "导出字体准备超时，请刷新页面后重试");
    } catch (error) {
      fontEmbedCssRef.current = null;
      throw error;
    }
  }

  function requireCurrentExport(expected?: ExportVersion) {
    const current = exportVersionRef.current;
    if (expected && current !== expected) throw new Error("内容或样式已更新，已停止本次导出。请等待排版完成后重新导出");
    if (!current) throw new Error("当前内容尚未完成排版，请等待排版成功后再导出");
    return current;
  }

  async function renderPage(index: number, version: ExportVersion) {
    requireCurrentExport(version);
    await withTimeout(waitForFonts(), 20000, "字体加载超时，请刷新页面后重试");
    requireCurrentExport(version);
    if (!pageRefs.current[index]) {
      setShowAllPreviewPages(true);
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve())));
      requireCurrentExport(version);
    }
    const node = pageRefs.current[index];
    if (!node) throw new Error("页面尚未准备好");
    const contentIndex = index - pageOffset;
    if (contentIndex >= 0 && contentPages[contentIndex]) assertExportSemantics(node, contentPages[contentIndex]);
    const imageModule = await getHtmlToImageModule();
    const fontEmbedCSS = await getPosterFontEmbedCss(node, imageModule);
    requireCurrentExport(version);
    const snapshot = await preparePosterSnapshot(node, format, () => { requireCurrentExport(version); });
    const controller = new AbortController();
    const renderTimer = window.setTimeout(() => controller.abort(), 90000);
    try {
      const blob = await withTimeout(imageModule.toBlob(snapshot.node, {
        width: format.width,
        height: format.height,
        pixelRatio: 1,
        cacheBust: false,
        includeQueryParams: true,
        preferredFontFormat: "woff2",
        fontEmbedCSS,
        fetchRequestInit: { cache: "force-cache", signal: controller.signal },
        backgroundColor: paperColor,
        filter: (capturedNode) => !(capturedNode instanceof HTMLElement && capturedNode.classList.contains("page-export")),
        style: { transform: "none", transformOrigin: "top left" },
      }), 95000, `第 ${index + 1} 页转换超时`);
      requireCurrentExport(version);
      if (!blob) throw new Error(`第 ${index + 1} 页图片生成失败`);
      return blob;
    } finally {
      window.clearTimeout(renderTimer);
      snapshot.dispose();
    }
  }

  async function exportOne(index: number) {
    setExporting(true);
    setNotice({ tone: "neutral", text: `正在导出第 ${index + 1} 页…` });
    try {
      const version = requireCurrentExport();
      const blob = await renderPage(index, version);
      requireCurrentExport(version);
      const platform = formatExportLabel(formatKey);
      const downloadUrl = URL.createObjectURL(blob);
      downloadDataUrl(downloadUrl, `折页-${platform}-${String(index + 1).padStart(2, "0")}.png`);
      window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
      setNotice({ tone: "success", text: `第 ${index + 1} 页已导出为高清 PNG` });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "导出失败，请刷新页面后重试" });
    } finally {
      setExporting(false);
    }
  }

  async function exportAll() {
    setExporting(true);
    try {
      const version = requireCurrentExport();
      jsZipModuleRef.current ||= import("jszip");
      const { default: JSZip } = await withTimeout(jsZipModuleRef.current, 20000, "压缩组件加载超时，请刷新页面后重试");
      requireCurrentExport(version);
      const zip = new JSZip();
      for (let index = 0; index < totalPages; index += 1) {
        setNotice({ tone: "neutral", text: index === 0 ? "正在准备导出字体（首次约需数秒）…" : `正在打包 ${index + 1} / ${totalPages}…` });
        const blob = await renderPage(index, version);
        const platform = formatExportLabel(formatKey);
        zip.file(`折页-${platform}-${String(index + 1).padStart(2, "0")}.png`, blob);
      }
      setNotice({ tone: "neutral", text: "图片已生成，正在压缩下载包…" });
      const blob = await withTimeout(zip.generateAsync({ type: "blob" }), 60000, "压缩图片超时，请尝试单张导出");
      requireCurrentExport(version);
      const downloadUrl = URL.createObjectURL(blob);
      downloadDataUrl(downloadUrl, `${formatExportTitle(title)}-${formatExportLabel(formatKey)}-全部贴图.zip`);
      window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
      setNotice({ tone: "success", text: `${totalPages} 张贴图已打包下载` });
    } catch (error) {
      jsZipModuleRef.current = null;
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "批量导出失败，请尝试单张导出" });
    } finally {
      setExporting(false);
    }
  }

  return { exporting, exportOne, exportAll };
}
