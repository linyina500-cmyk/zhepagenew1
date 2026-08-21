"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { HexColorInput, HexColorPicker } from "react-colorful";

const RECENT_COLORS_KEY = "zhepage-recent-colors-v1";
const RECOMMENDED_COLORS = [
  "#1f1f1f", "#ffffff", "#d7352f", "#a61b29", "#f15b4a", "#ff8a65",
  "#f6c344", "#ffd66b", "#f7e8b3", "#2f7d32", "#66a85c", "#cfe8c7",
  "#2457a7", "#3f7dd8", "#b8d6ff", "#6347a5", "#9a72c7", "#e0d3f4",
  "#7a3d13", "#b47a45", "#ead8bf", "#5d6672", "#9299a3", "#e6e8eb",
];

export type ColorTarget = {
  id: string;
  label: string;
  color?: string;
  fallbackColor: string;
  onApply: (color: string, variant?: string) => void;
  onClear?: () => void;
};

export type ColorVariant = {
  id: string;
  label: string;
  detail: string;
};

type UnifiedColorPopoverProps = {
  targets: ColorTarget[];
  triggerLabel?: string;
  tooltip?: string;
  className?: string;
  clearLabel?: string;
  triggerIcon?: ReactNode;
  variants?: ColorVariant[];
  variantValue?: string;
};

function normalizeHex(color: string, fallback: string) {
  const normalized = color.trim().startsWith("#") ? color.trim() : `#${color.trim()}`;
  if (/^#[0-9a-f]{6}$/i.test(normalized)) return normalized.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(normalized)) {
    return `#${normalized.slice(1).split("").map((character) => character.repeat(2)).join("")}`.toLowerCase();
  }
  return /^#[0-9a-f]{6}$/i.test(fallback) ? fallback.toLowerCase() : "#d7352f";
}

function readRecentColors() {
  if (typeof window === "undefined") return [];
  try {
    const saved = JSON.parse(window.localStorage.getItem(RECENT_COLORS_KEY) || "[]");
    return Array.isArray(saved) ? saved.filter((color) => typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color)).slice(0, 10) : [];
  } catch {
    return [];
  }
}

export default function UnifiedColorPopover({ targets, triggerLabel = "颜色", tooltip, className = "", clearLabel = "清除颜色", triggerIcon, variants = [], variantValue }: UnifiedColorPopoverProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState({ top: 12, left: 12, maxHeight: 520, ready: false });
  const [activeId, setActiveId] = useState(targets[0]?.id || "");
  const activeTarget = useMemo(() => targets.find((target) => target.id === activeId) || targets[0], [activeId, targets]);
  const [draft, setDraft] = useState(() => normalizeHex(activeTarget?.color || "", activeTarget?.fallbackColor || "#d7352f"));
  const [draftVariant, setDraftVariant] = useState(variantValue || variants[0]?.id || "");
  const [recentColors, setRecentColors] = useState<string[]>([]);

  useEffect(() => {
    if (!open) return;
    const closeOnPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !popoverRef.current?.contains(target)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", closeOnPointerDown);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnPointerDown);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const updatePlacement = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const gutter = 12;
      const gap = 8;
      const triggerBox = trigger.getBoundingClientRect();
      const popoverWidth = popoverRef.current?.offsetWidth || Math.min(352, window.innerWidth - gutter * 2);
      const popoverHeight = popoverRef.current?.scrollHeight || 500;
      const below = Math.max(0, window.innerHeight - triggerBox.bottom - gap - gutter);
      const above = Math.max(0, triggerBox.top - gap - gutter);
      const openAbove = below < Math.min(popoverHeight, 420) && above > below;
      const maxHeight = Math.max(180, openAbove ? above : below);
      const visibleHeight = Math.min(popoverHeight, maxHeight);
      const maxLeft = Math.max(gutter, window.innerWidth - popoverWidth - gutter);
      const left = Math.min(Math.max(triggerBox.left, gutter), maxLeft);
      const top = openAbove
        ? Math.max(gutter, triggerBox.top - gap - visibleHeight)
        : Math.min(triggerBox.bottom + gap, window.innerHeight - gutter - visibleHeight);
      setPlacement({ top, left, maxHeight, ready: true });
    };
    updatePlacement();
    const frame = window.requestAnimationFrame(updatePlacement);
    window.addEventListener("resize", updatePlacement);
    window.addEventListener("scroll", updatePlacement, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", updatePlacement);
      window.removeEventListener("scroll", updatePlacement, true);
    };
  }, [activeId, open]);

  if (!activeTarget) return null;

  function togglePopover() {
    if (!open) {
      setRecentColors(readRecentColors());
      setDraft(normalizeHex(activeTarget.color || "", activeTarget.fallbackColor));
      setDraftVariant(variantValue || variants[0]?.id || "");
    }
    setOpen((value) => !value);
  }

  function selectTarget(id: string) {
    const nextTarget = targets.find((target) => target.id === id);
    if (!nextTarget) return;
    setActiveId(id);
    setDraft(normalizeHex(nextTarget.color || "", nextTarget.fallbackColor));
  }

  function applyColor() {
    const color = normalizeHex(draft, activeTarget.fallbackColor);
    activeTarget.onApply(color, draftVariant || undefined);
    const nextRecent = [color, ...recentColors.filter((item) => item !== color)].slice(0, 10);
    setRecentColors(nextRecent);
    window.localStorage.setItem(RECENT_COLORS_KEY, JSON.stringify(nextRecent));
    setOpen(false);
  }

  function clearColor() {
    activeTarget.onClear?.();
    setOpen(false);
  }

  return <div ref={rootRef} className={`unified-color-control ${className}`.trim()}>
    <button
      ref={triggerRef}
      type="button"
      className={`color-popover-trigger ${open ? "active" : ""}`}
      aria-expanded={open}
      aria-haspopup="dialog"
      data-tooltip={tooltip}
      onMouseDown={(event) => event.preventDefault()}
      onClick={togglePopover}
    >
      <span className="color-trigger-letter" aria-hidden="true">{triggerIcon || "A"}</span>
      <span>{triggerLabel}</span>
      <span className="color-trigger-swatches" aria-hidden="true">
        {targets.slice(0, 4).map((target) => <i key={target.id} style={{ background: normalizeHex(target.color || "", target.fallbackColor) }} />)}
      </span>
    </button>

    {open && typeof document !== "undefined" && createPortal(<div
      ref={popoverRef}
      className="color-popover"
      role="dialog"
      aria-label="统一颜色面板"
      style={{ top: placement.top, left: placement.left, maxHeight: placement.maxHeight, visibility: placement.ready ? "visible" : "hidden" }}
    >
      <div className="color-popover-head">
        <div><b>颜色面板</b><small>预设、最近使用与自定义色值</small></div>
        <button type="button" aria-label="关闭颜色面板" onClick={() => setOpen(false)}>×</button>
      </div>

      {targets.length > 1 && <div className="color-target-tabs" role="tablist" aria-label="选择要调整的颜色">
        {targets.map((target) => <button
          key={target.id}
          type="button"
          role="tab"
          aria-selected={target.id === activeTarget.id}
          className={target.id === activeTarget.id ? "active" : ""}
          onClick={() => selectTarget(target.id)}
        ><i style={{ background: normalizeHex(target.color || "", target.fallbackColor) }} />{target.label}</button>)}
      </div>}

      {variants.length > 0 && <div className="color-variant-section">
        <span className="color-group-label">高亮样式</span>
        <div className="color-variant-options" role="radiogroup" aria-label="选择高亮样式">
          {variants.map((variant) => <button
            key={variant.id}
            type="button"
            role="radio"
            aria-checked={draftVariant === variant.id}
            className={draftVariant === variant.id ? "selected" : ""}
            onClick={() => setDraftVariant(variant.id)}
          >
            <i className={`highlight-variant-preview ${variant.id}`} style={{ "--variant-color": draft } as CSSProperties}>示例</i>
            <span><b>{variant.label}</b><small>{variant.detail}</small></span>
          </button>)}
        </div>
      </div>}

      <div className="color-picker-layout">
        <HexColorPicker color={draft} onChange={setDraft} />
        <div className="color-picker-side">
          <span className="color-group-label">最近使用</span>
          <div className="color-chip-row recent">
            {(recentColors.length ? recentColors : ["#d7352f", "#292624", "#ffd66b", "#ffffff"]).map((color) => <button key={color} type="button" aria-label={`选择 ${color}`} className={draft === color ? "selected" : ""} style={{ background: color }} onClick={() => setDraft(color)} />)}
          </div>
          <span className="color-group-label">推荐色</span>
          <div className="color-chip-grid">
            {RECOMMENDED_COLORS.map((color) => <button key={color} type="button" aria-label={`选择 ${color}`} className={draft === color ? "selected" : ""} style={{ background: color }} onClick={() => setDraft(color)} />)}
          </div>
        </div>
      </div>

      <div className="color-value-row">
        <span className="color-preview" style={{ background: draft }} aria-hidden="true" />
        <span>#</span>
        <HexColorInput color={draft} onChange={(value) => setDraft(normalizeHex(value, draft))} aria-label="十六进制颜色值" />
      </div>
      <div className="color-popover-actions">
        <button type="button" className="color-clear" disabled={!activeTarget.onClear} onClick={clearColor}>{clearLabel}</button>
        <button type="button" className="color-apply" onClick={applyColor}>应用到{activeTarget.label}</button>
      </div>
    </div>, document.body)}
  </div>;
}
