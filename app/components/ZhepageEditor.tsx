"use client";

import { useEffect, useRef, useState, type ChangeEvent, type CSSProperties, type ReactNode } from "react";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Highlight from "@tiptap/extension-highlight";
import Image from "@tiptap/extension-image";
import TextAlign from "@tiptap/extension-text-align";
import { Color, TextStyle } from "@tiptap/extension-text-style";
import { TableKit } from "@tiptap/extension-table";
import { Extension, Mark, Node, getStyleProperty, mergeAttributes } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import UnifiedColorPopover from "./UnifiedColorPopover";
import { createContentLimitExtension, createPasteHandlers } from "../../lib/richText/editorPaste";

type ZhepageEditorProps = {
  html: string;
  revision: number;
  accentColor: string;
  highlightColor: string;
  onChange: (html: string) => void;
  onNotice: (text: string, tone?: "success" | "error") => void;
  onAutoTypeset?: (html: string, numberedDotStyle: boolean) => void;
  numberedDotStyle?: boolean;
  onNumberedDotStyleChange?: (enabled: boolean) => void;
  compact?: boolean;
  insertLeadCardRequest?: number;
};

const TOOLTIP_ID = "editor-toolbar-help";

const PreservedAttributes = Extension.create({
  name: "preservedSourceAttributes",
  addGlobalAttributes() {
    return [{
      types: ["paragraph", "heading", "blockquote", "bulletList", "orderedList", "listItem", "table", "tableRow", "tableCell", "tableHeader", "image", "bold", "italic", "underline", "strike", "highlight", "textStyle"],
      attributes: {
        class: { default: null, parseHTML: (element) => element.getAttribute("class") },
        style: { default: null, parseHTML: (element) => element.getAttribute("style") },
        autoIndex: {
          default: null,
          parseHTML: (element) => element.getAttribute("data-auto-index"),
          renderHTML: (attributes) => attributes.autoIndex ? { "data-auto-index": attributes.autoIndex } : {},
        },
        autoLabel: {
          default: null,
          parseHTML: (element) => element.getAttribute("data-auto-label"),
          renderHTML: (attributes) => attributes.autoLabel ? { "data-auto-label": attributes.autoLabel } : {},
        },
      },
    }];
  },
});

const GenericBlock = Node.create({
  name: "genericBlock",
  group: "block",
  content: "block*",
  defining: true,
  addAttributes() {
    return {
      tag: { default: "div" },
      class: { default: null },
      style: { default: null },
    };
  },
  parseHTML() {
    return ["div", "section", "article", "aside"].map((tag) => ({ tag, getAttrs: () => ({ tag }) }));
  },
  renderHTML({ HTMLAttributes }) {
    const tag = ["div", "section", "article", "aside"].includes(HTMLAttributes.tag) ? HTMLAttributes.tag : "div";
    const attributes = { ...HTMLAttributes };
    delete attributes.tag;
    return [tag, mergeAttributes(attributes), 0];
  },
});

const SourceStyle = Mark.create({
  name: "sourceStyle",
  addAttributes() {
    return { style: { default: null } };
  },
  parseHTML() {
    return [{ tag: "span[style]", getAttrs: (element) => ({ style: (element as HTMLElement).getAttribute("style") }) }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["span", HTMLAttributes, 0];
  },
});

const StyledHighlight = Highlight.extend({
  addAttributes() {
    return {
      color: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-color") || getStyleProperty(element, "background-color") || element.style.backgroundColor,
        renderHTML: (attributes) => attributes.color ? {
          "data-color": attributes.color,
          style: `--highlight-color:${attributes.color};background-color:${attributes.color};color:inherit`,
        } : {},
      },
      styleType: {
        default: "marker",
        parseHTML: (element) => {
          const explicit = element.getAttribute("data-highlight-style");
          if (explicit === "marker" || explicit === "block") return explicit;
          return element.getAttribute("data-color") || getStyleProperty(element, "background-color") ? "block" : "marker";
        },
        renderHTML: (attributes) => ({ "data-highlight-style": attributes.styleType === "block" ? "block" : "marker" }),
      },
    };
  },
});

function ToolButton({ label, tip, active = false, disabled = false, onClick }: {
  label: ReactNode;
  tip: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return <button
    type="button"
    className={active ? "active" : ""}
    aria-pressed={active}
    aria-describedby={TOOLTIP_ID}
    data-tooltip={tip}
    disabled={disabled}
    onMouseDown={(event) => event.preventDefault()}
    onClick={onClick}
  >{label}</button>;
}

type TextAlignment = "left" | "center" | "right";

function AlignIcon({ alignment }: { alignment: TextAlignment }) {
  const widths = alignment === "left" ? [16, 11, 16, 8] : alignment === "right" ? [16, 11, 16, 8] : [16, 10, 16, 8];
  return <svg className={`editor-icon align-${alignment}`} viewBox="0 0 20 20" aria-hidden="true">
    {widths.map((width, index) => {
      const x = alignment === "left" ? 2 : alignment === "right" ? 18 - width : 10 - width / 2;
      return <rect key={`${width}-${index}`} x={x} y={3 + index * 4} width={width} height="1.8" rx=".9" />;
    })}
  </svg>;
}

function TextColorIcon() {
  return <svg className="editor-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M4 16 9.2 3h1.7L16 16h-2.3l-1.2-3.2H7.4L6.2 16H4Zm4.1-5.2h3.7L10 5.8l-1.9 5Z" /><rect x="3" y="17" width="14" height="2" rx="1" /></svg>;
}

function HighlightIcon() {
  return <svg className="editor-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="m6.1 12.8 6.7-8.7 3.1 2.5-6.7 8.6H6.1v-2.4Z" /><path d="M4 17h12v2H4z" /></svg>;
}

function AlignmentControl({ value, onChange }: { value: TextAlignment; onChange: (alignment: TextAlignment) => void }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (event.target instanceof window.Node && !rootRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const labels: Record<TextAlignment, string> = { left: "左对齐", center: "居中对齐", right: "右对齐" };
  return <div className="alignment-control" ref={rootRef}>
    <button type="button" className={open ? "active" : ""} aria-expanded={open} aria-haspopup="menu" data-tooltip={`段落对齐：当前${labels[value]}`} onMouseDown={(event) => event.preventDefault()} onClick={() => setOpen((current) => !current)}>
      <AlignIcon alignment={value} /><span className="toolbar-chevron" aria-hidden="true">▾</span>
    </button>
    {open && <div className="alignment-popover" role="menu" aria-label="段落对齐方式">
      {(["left", "center", "right"] as const).map((alignment) => <button key={alignment} type="button" role="menuitemradio" aria-checked={alignment === value} aria-label={labels[alignment]} className={alignment === value ? "active" : ""} data-tooltip={labels[alignment]} onMouseDown={(event) => event.preventDefault()} onClick={() => { onChange(alignment); setOpen(false); }}><AlignIcon alignment={alignment} /></button>)}
    </div>}
  </div>;
}

function BlankLineControl({ onInsert }: { onInsert: (position: "before" | "after") => void }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (event.target instanceof window.Node && !rootRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  return <div className="blank-line-control" ref={rootRef}>
    <button type="button" className={open ? "active" : ""} aria-expanded={open} aria-haspopup="menu" data-tooltip="空行：选择插在当前段落或图片的前面/后面" onMouseDown={(event) => event.preventDefault()} onClick={() => setOpen((current) => !current)}>＋空行 <span aria-hidden="true">▾</span></button>
    {open && <div className="blank-line-popover" role="menu" aria-label="插入空行位置">
      <button type="button" role="menuitem" onMouseDown={(event) => event.preventDefault()} onClick={() => { onInsert("before"); setOpen(false); }}>段前空行</button>
      <button type="button" role="menuitem" onMouseDown={(event) => event.preventDefault()} onClick={() => { onInsert("after"); setOpen(false); }}>段后空行</button>
    </div>}
  </div>;
}

export default function ZhepageEditor({ html, revision, accentColor, highlightColor, onChange, onNotice, onAutoTypeset, numberedDotStyle = true, onNumberedDotStyleChange, compact = false, insertLeadCardRequest = 0 }: ZhepageEditorProps) {
  const imageCaptionRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const applyingExternalContent = useRef(false);
  const lastRevision = useRef(revision);
  const updateTimer = useRef<number | null>(null);
  const selectedImagePosition = useRef(-1);

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] }, link: false, code: false, codeBlock: false }),
      createContentLimitExtension(onNotice),
      GenericBlock,
      SourceStyle,
      PreservedAttributes,
      StyledHighlight.configure({ multicolor: true }),
      TextStyle,
      Color,
      Image.configure({ allowBase64: true, resize: { enabled: false } }),
      TextAlign.configure({ types: ["heading", "paragraph"] }),
      TableKit.configure({ table: { resizable: true } }),
    ],
    content: html,
    editorProps: {
      attributes: { class: "tiptap-surface", spellcheck: "false" },
      ...createPasteHandlers(onNotice),
    },
    onUpdate: ({ editor: currentEditor }) => {
      if (applyingExternalContent.current) return;
      if (compact) {
        onChange(currentEditor.getHTML());
        return;
      }
      if (updateTimer.current) window.clearTimeout(updateTimer.current);
      const delay = currentEditor.state.doc.content.size > 60_000 ? 320 : 180;
      updateTimer.current = window.setTimeout(() => onChange(currentEditor.getHTML()), delay);
    },
  });

  const editorState = useEditorState({
    editor,
    selector: ({ editor: currentEditor }) => ({
      bold: currentEditor?.isActive("bold") || false,
      italic: currentEditor?.isActive("italic") || false,
      strike: currentEditor?.isActive("strike") || false,
      underline: currentEditor?.isActive("underline") || false,
      heading1: currentEditor?.isActive("heading", { level: 1 }) || false,
      heading2: currentEditor?.isActive("heading", { level: 2 }) || false,
      heading3: currentEditor?.isActive("heading", { level: 3 }) || false,
      blockquote: currentEditor?.isActive("blockquote") || false,
      highlight: currentEditor?.isActive("highlight") || false,
      textColor: currentEditor?.getAttributes("textStyle").color || "",
      highlightColor: currentEditor?.getAttributes("highlight").color || "",
      highlightStyle: currentEditor?.getAttributes("highlight").styleType || "",
      bulletList: currentEditor?.isActive("bulletList") || false,
      orderedList: currentEditor?.isActive("orderedList") || false,
      left: currentEditor?.isActive({ textAlign: "left" }) || false,
      center: currentEditor?.isActive({ textAlign: "center" }) || false,
      right: currentEditor?.isActive({ textAlign: "right" }) || false,
      canUndo: currentEditor?.can().undo() || false,
      canRedo: currentEditor?.can().redo() || false,
      image: currentEditor?.isActive("image") || false,
      imageStyle: currentEditor?.isActive("image") ? currentEditor.getAttributes("image").style || "" : "",
      imagePosition: currentEditor?.isActive("image") ? currentEditor.state.selection.from : -1,
      divider: currentEditor?.isActive("horizontalRule") || false,
    }),
  });

  useEffect(() => {
    if (!editor) return;
    const rememberImageSelection = () => {
      selectedImagePosition.current = editor.isActive("image") ? editor.state.selection.from : -1;
    };
    rememberImageSelection();
    editor.on("selectionUpdate", rememberImageSelection);
    return () => editor.off("selectionUpdate", rememberImageSelection);
  }, [editor]);

  useEffect(() => {
    if (!editor || revision === lastRevision.current) return;
    lastRevision.current = revision;
    if (updateTimer.current) window.clearTimeout(updateTimer.current);
    applyingExternalContent.current = true;
    editor.chain().setMeta("richTextExternalContent", true).setContent(html, { emitUpdate: false }).run();
    applyingExternalContent.current = false;
  }, [editor, html, revision]);

  useEffect(() => () => {
    if (updateTimer.current) window.clearTimeout(updateTimer.current);
  }, []);

  useEffect(() => {
    if (!editor || !insertLeadCardRequest) return;
    insertGenericBlock("lead-card-placeholder", "— PDF 刊物领取卡 —");
  // The counter is an explicit insertion request from the parent controls.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, insertLeadCardRequest]);

  if (!editor) return <div className="layout-editor editor-loading">正在加载专业编辑器…</div>;

  function insertGenericBlock(className: string, label: string) {
    editor!.chain().focus().insertContent([
      { type: "genericBlock", attrs: { tag: "div", class: className }, content: [{ type: "paragraph", content: [{ type: "text", text: label }] }] },
      { type: "paragraph" },
    ]).run();
  }

  function removeGenericBlocks(className: string) {
    const transaction = editor!.state.tr;
    const ranges: Array<{ from: number; to: number }> = [];
    editor!.state.doc.descendants((node, position) => {
      if (node.type.name === "genericBlock" && String(node.attrs.class || "").split(/\s+/).includes(className)) ranges.push({ from: position, to: position + node.nodeSize });
    });
    ranges.reverse().forEach(({ from, to }) => transaction.delete(from, to));
    if (ranges.length) editor!.view.dispatch(transaction);
    onNotice(ranges.length ? `已清除 ${ranges.length} 处手动分页` : "当前没有手动分页");
  }

  function insertBlankLine(position: "before" | "after") {
    const currentEditor = editor!;
    const { selection, schema, doc } = currentEditor.state;
    const rememberedImage = doc.nodeAt(selectedImagePosition.current);
    const imagePosition = rememberedImage?.type.name === "image" ? selectedImagePosition.current : -1;
    const boundary = imagePosition >= 0
      ? position === "before" ? imagePosition : imagePosition + rememberedImage!.nodeSize
      : position === "before"
        ? selection.$from.depth > 0 ? selection.$from.before(1) : selection.from
        : selection.$to.depth > 0 ? selection.$to.after(1) : selection.to;
    const resolved = doc.resolve(boundary);
    const neighbor = position === "before" ? resolved.nodeBefore : resolved.nodeAfter;
    if (String(neighbor?.attrs.class || "").split(/\s+/).includes("manual-empty-line")) {
      onNotice(position === "before" ? "当前内容前已有空行" : "当前内容后已有空行");
      return;
    }
    const blank = schema.nodes.paragraph.create({ class: "manual-empty-line" });
    const transaction = currentEditor.state.tr.insert(boundary, blank);
    if (imagePosition >= 0) {
      const nextImagePosition = position === "before" ? imagePosition + blank.nodeSize : imagePosition;
      transaction.setSelection(NodeSelection.create(transaction.doc, nextImagePosition));
      selectedImagePosition.current = nextImagePosition;
    }
    currentEditor.view.dispatch(transaction);
    currentEditor.view.focus();
    onNotice(position === "before" ? "已插入段前空行" : "已插入段后空行");
  }

  function clearFormatting() {
    editor!.chain().focus().unsetAllMarks().clearNodes().command(({ tr }) => {
      const positions: number[] = [];
      if (tr.selection.empty && tr.selection.$from.depth > 0) {
        positions.push(tr.selection.$from.before(1));
      } else {
        tr.doc.nodesBetween(tr.selection.from, tr.selection.to, (node, position) => {
          if (node.isTextblock) positions.push(position);
        });
      }
      positions.reverse().forEach((position) => {
        const node = tr.doc.nodeAt(position);
        if (!node) return;
        const attributes = { ...node.attrs };
        if ("class" in attributes) attributes.class = null;
        if ("style" in attributes) attributes.style = null;
        if ("autoIndex" in attributes) attributes.autoIndex = null;
        if ("autoLabel" in attributes) attributes.autoLabel = null;
        tr.setNodeMarkup(position, undefined, attributes, node.marks);
      });
      return true;
    }).run();
    onNotice("已清除所选内容的格式和自动排版装饰");
  }

  function imageStyle(overrides: Record<string, string>) {
    const declarations = new Map<string, string>();
    String(editor!.getAttributes("image").style || "").split(";").forEach((declaration) => {
      const separator = declaration.indexOf(":");
      if (separator < 1) return;
      declarations.set(declaration.slice(0, separator).trim().toLowerCase(), declaration.slice(separator + 1).trim());
    });
    Object.entries(overrides).forEach(([property, value]) => {
      if (value) declarations.set(property, value);
      else declarations.delete(property);
    });
    declarations.set("height", "auto");
    declarations.set("max-width", "100%");
    declarations.set("display", "block");
    return [...declarations].map(([property, value]) => `${property}:${value}`).join(";");
  }

  function setImageAlignment(alignment: "left" | "center" | "right") {
    const margins = alignment === "left"
      ? { "margin-left": "0", "margin-right": "auto" }
      : alignment === "right"
        ? { "margin-left": "auto", "margin-right": "0" }
        : { "margin-left": "auto", "margin-right": "auto" };
    editor!.chain().focus().updateAttributes("image", { style: imageStyle(margins) }).run();
  }

  function handleImageUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!/^image\/(png|jpe?g|webp)$/i.test(file.type)) {
      onNotice("请上传 PNG、JPG 或 WebP 图片");
      event.target.value = "";
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      editor!.chain().focus().setImage({
        src: String(reader.result),
        alt: file.name,
        style: "width:100%;height:auto;max-width:100%;display:block;margin-left:auto;margin-right:auto",
      }).run();
      onNotice("图片已插入，可继续调整尺寸、对齐、圆角和图注");
    };
    reader.onerror = () => onNotice("图片读取失败，请重新选择");
    reader.readAsDataURL(file);
    event.target.value = "";
  }

  function saveImageCaption() {
    const imageCaption = imageCaptionRef.current?.value.trim() || "";
    const position = editor!.state.selection.from;
    const imageNode = editor!.state.doc.nodeAt(position);
    if (!imageNode || imageNode.type.name !== "image") return;
    const nextPosition = position + imageNode.nodeSize;
    const nextNode = editor!.state.doc.nodeAt(nextPosition);
    const chain = editor!.chain().focus();
    if (nextNode?.type.name === "paragraph" && nextNode.attrs.class === "image-caption") {
      chain.command(({ tr }) => {
        tr.delete(nextPosition, nextPosition + nextNode.nodeSize);
        return true;
      });
    }
    if (imageCaption) {
      chain.insertContentAt(nextPosition, {
        type: "paragraph",
        attrs: { class: "image-caption", style: "text-align:center" },
        content: [{ type: "text", text: imageCaption }],
      });
    }
    chain.run();
    onNotice(imageCaption ? "图片图注已更新" : "图片图注已移除");
  }

  const selectedImageWidth = Math.max(30, Math.min(100, Number.parseFloat(editorState.imageStyle.match(/width\s*:\s*([\d.]+)%/i)?.[1] || "100")));
  const selectedImageAlignment = /margin-left\s*:\s*0(?:px)?/i.test(editorState.imageStyle) ? "left"
    : /margin-right\s*:\s*0(?:px)?/i.test(editorState.imageStyle) ? "right" : "center";
  const selectedImageRounded = /border-radius\s*:\s*(?!0(?:px|rem|em|%)?(?:;|$))/i.test(editorState.imageStyle);

  return <div className={`professional-editor ${compact ? "compact" : ""}`} style={{ "--editor-accent": accentColor, "--editor-highlight": highlightColor } as CSSProperties}>
    <div className="editor-mode-tabs" aria-label="编辑格式">
      <strong>富文本编辑</strong>
      <span>基于 Tiptap / ProseMirror</span>
    </div>

    <>
      <input ref={imageInputRef} className="editor-image-input" type="file" accept="image/png,image/jpeg,image/webp" onChange={handleImageUpload} />
      {!compact && onAutoTypeset && <div className="auto-typeset-bar" aria-label="自动排版">
        <button type="button" className="editor-auto-typeset" onClick={() => onAutoTypeset(editor.getHTML(), numberedDotStyle)}>
          <span><b>一键自动排版</b><small>整理导语、章节标题、重点段落和图表</small></span>
          <em>本地规则 · 不使用 AI</em>
        </button>
        {onNumberedDotStyleChange && <label className="numbered-style-choice" htmlFor="numbered-dot-style">序号点线标题
          <input id="numbered-dot-style" type="checkbox" checked={numberedDotStyle} onChange={(event) => onNumberedDotStyleChange(event.target.checked)} />
          <span aria-hidden="true"><b>序号点线标题</b><small>关闭后仍识别标题，但不添加点线装饰</small></span>
        </label>}
      </div>}
      <div className="editor-toolbar" aria-label="富文本排版工具" role="toolbar">
        <span id={TOOLTIP_ID} className="sr-only">鼠标悬停按钮可查看功能说明</span>
        <ToolButton label={<b>B</b>} tip="粗体：再次点击取消" active={editorState.bold} onClick={() => editor.chain().focus().toggleBold().run()} />
        <ToolButton label={<i>I</i>} tip="斜体：再次点击取消" active={editorState.italic} onClick={() => editor.chain().focus().toggleItalic().run()} />
        <ToolButton label={<u>U</u>} tip="下划线：再次点击取消" active={editorState.underline} onClick={() => editor.chain().focus().toggleUnderline().run()} />
        <ToolButton label={<s>S</s>} tip="删除线：再次点击取消" active={editorState.strike} onClick={() => editor.chain().focus().toggleStrike().run()} />
        <ToolButton label="H1" tip="一级标题：再次点击恢复正文" active={editorState.heading1} onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()} />
        <ToolButton label="H2" tip="二级标题：再次点击恢复正文" active={editorState.heading2} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} />
        <ToolButton label="H3" tip="三级标题：再次点击恢复正文" active={editorState.heading3} onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()} />
        <ToolButton label="❝" tip="引用块：再次点击恢复正文" active={editorState.blockquote} onClick={() => editor.chain().focus().toggleBlockquote().run()} />
        <UnifiedColorPopover
          className="editor-color-control"
          triggerLabel="字色"
          triggerIcon={<TextColorIcon />}
          tooltip="选中文字后，单独调整文字颜色"
          targets={[
            { id: "text", label: "文字", color: editorState.textColor, fallbackColor: accentColor, onApply: (color) => editor.chain().focus().setColor(color).run(), onClear: () => editor.chain().focus().unsetColor().run() },
          ]}
        />
        <UnifiedColorPopover
          className="editor-color-control editor-highlight-control"
          triggerLabel="高亮"
          triggerIcon={<HighlightIcon />}
          tooltip="选中文字后添加自定义颜色高亮；可随时清除"
          variantValue={editorState.highlightStyle || "block"}
          variants={[
            { id: "marker", label: "标记笔", detail: "轻柔划线，适合长文" },
            { id: "block", label: "实色块", detail: "完整底色，强调更强" },
          ]}
          targets={[
            { id: "highlight", label: "高亮", color: editorState.highlightColor, fallbackColor: highlightColor, onApply: (color, styleType) => editor.chain().focus().setMark("highlight", { color, styleType: styleType || "block" }).run(), onClear: () => editor.chain().focus().unsetHighlight().run() },
          ]}
        />
        <ToolButton label="• 列表" tip="无序列表：再次点击取消" active={editorState.bulletList} onClick={() => editor.chain().focus().toggleBulletList().run()} />
        <ToolButton label="1. 列表" tip="有序列表：再次点击取消" active={editorState.orderedList} onClick={() => editor.chain().focus().toggleOrderedList().run()} />
        <AlignmentControl value={editorState.right ? "right" : editorState.center ? "center" : "left"} onChange={(alignment) => editor.chain().focus().setTextAlign(alignment).run()} />
        {!compact && <BlankLineControl onInsert={insertBlankLine} />}
        {!compact && <ToolButton label="＋分页" tip="从光标位置开始新的一张贴图" onClick={() => insertGenericBlock("manual-page-break", "— 手动分页 —")} />}
        {!compact && <ToolButton label="＋领取卡" tip="在光标位置插入 PDF 刊物领取卡" onClick={() => insertGenericBlock("lead-card-placeholder", "— PDF 刊物领取卡 —")} />}
        <ToolButton label="＋图片" tip="插入 PNG、JPG 或 WebP 图片；插入后可调整尺寸、对齐、圆角和图注" onClick={() => imageInputRef.current?.click()} />
        <ToolButton label="横线" tip="插入分隔线；选中后可删除" onClick={() => editor.chain().focus().setHorizontalRule().run()} />
        <ToolButton label="清除格式" tip="清除选中文字的样式、自动装饰并恢复正文段落" onClick={clearFormatting} />
        {!compact && <ToolButton label="清分页" tip="清除文中所有手动分页标记，恢复自动分页" onClick={() => removeGenericBlocks("manual-page-break")} />}
        <ToolButton label="↶" tip="撤销上一步，也可按 Ctrl/Command + Z" disabled={!editorState.canUndo} onClick={() => editor.chain().focus().undo().run()} />
        <ToolButton label="↷" tip="重做，也可按 Ctrl/Command + Shift + Z" disabled={!editorState.canRedo} onClick={() => editor.chain().focus().redo().run()} />
      </div>
      <div className="layout-editor"><EditorContent editor={editor} /></div>
      {!compact && editorState.image && <div className="image-adjuster">
        <div><span>已选中图片 · 宽度</span><b>{selectedImageWidth}%</b></div>
        <input aria-label="图片宽度" type="range" min="30" max="100" step="5" value={selectedImageWidth} onChange={(event) => {
          const width = Number(event.target.value);
          editor.chain().focus().updateAttributes("image", { style: imageStyle({ width: `${width}%` }) }).run();
        }} />
        <div className="image-size-presets">{[40, 60, 80, 100].map((width) => <button key={width} type="button" className={selectedImageWidth === width ? "active" : ""} data-tooltip={`将图片调整为页面宽度的 ${width}%`} onClick={() => editor.chain().focus().updateAttributes("image", { style: imageStyle({ width: `${width}%` }) }).run()}>{width}%</button>)}</div>
        <div className="image-presentation-tools" aria-label="图片展示方式">
          {(["left", "center", "right"] as const).map((alignment) => <button key={alignment} type="button" className={selectedImageAlignment === alignment ? "active" : ""} data-tooltip={`图片${alignment === "left" ? "左" : alignment === "right" ? "右" : "居中"}对齐`} onClick={() => setImageAlignment(alignment)}>{alignment === "left" ? "靠左" : alignment === "right" ? "靠右" : "居中"}</button>)}
          <button type="button" className={selectedImageRounded ? "active" : ""} data-tooltip="切换图片圆角，适合卡片式配图" onClick={() => editor.chain().focus().updateAttributes("image", { style: imageStyle({ "border-radius": selectedImageRounded ? "0" : "18px" }) }).run()}>圆角</button>
        </div>
        <div className="image-caption-editor">
          <input key={editorState.imagePosition} ref={imageCaptionRef} aria-label="图片图注" placeholder="可选：输入图片图注" />
          <button type="button" data-tooltip="保存图注；留空保存可删除现有图注" onClick={saveImageCaption}>保存图注</button>
        </div>
        <button type="button" className="delete-image-button" data-tooltip="删除当前图片，可用撤销恢复" onClick={() => editor.chain().focus().deleteSelection().run()}>删除这张图片</button>
      </div>}
      {!compact && editorState.divider && <div className="divider-adjuster"><span>已选中横线</span><button type="button" data-tooltip="删除横线后插入普通空段落，避免文字连在一起" onClick={() => editor.chain().focus().deleteSelection().insertContent({ type: "paragraph" }).run()}>删除这条横线</button></div>}
    </>
  </div>;
}
