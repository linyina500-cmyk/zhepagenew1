import type { CSSProperties } from "react";
import { layoutClassName } from "../../lib/layouts/layoutClasses";
import { LAYOUT_PRESETS } from "../../lib/layouts/layoutPresets";
import type { LayoutStyleKey } from "../../lib/layouts/layoutTypes";

type PosterCoverProps = {
  layoutStyle: LayoutStyleKey;
  title: string;
  subtitle: string;
  pageBrand: string;
  labName: string;
  coverCredit: string;
  totalPages: number;
  width: number;
  height: number;
  exporting: boolean;
  fontsReady: boolean;
  onExport: () => void;
  setRef: (node: HTMLElement | null) => void;
};

export default function PosterCover({
  layoutStyle,
  title,
  subtitle,
  pageBrand,
  labName,
  coverCredit,
  totalPages,
  width,
  height,
  exporting,
  fontsReady,
  onExport,
  setRef,
}: PosterCoverProps) {
  const preset = LAYOUT_PRESETS[layoutStyle];
  const titleLength = Array.from(title.replace(/\s/g, "")).length;
  const adaptiveTitleSize = Math.round(Math.max(84, Math.min(112, 116 - Math.max(0, titleLength - 22) * .82)));
  const lines = title.split("\n");

  return <article
    className={`poster-page cover-page ${layoutClassName(layoutStyle)}`}
    data-layout-style={layoutStyle}
    ref={setRef}
    style={{ width, height, "--cover-title-size": `${adaptiveTitleSize}px` } as CSSProperties}
  >
    <div className="cover-rule" />
    <div className="cover-brand">{pageBrand}</div>
    <div className="cover-index">{layoutStyle === "dataIndex" ? "01" : `VOL. 01 · ${coverCredit}`}</div>
    <div className="cover-edition">{preset.coverLabel}</div>
    <h3>{lines.map((line, index) => <span key={`${line}-${index}`}>{line}</span>)}</h3>
    <div className="cover-focus-label">{preset.coverBadge}</div>
    <div className="cover-bottom">
      <p>{subtitle}</p>
      <div className="cover-meta"><span>{labName}</span><span>{String(totalPages).padStart(2, "0")} PAGES</span></div>
    </div>
    <button className="page-export" onClick={onExport} disabled={exporting || !fontsReady} aria-label="导出封面">↓</button>
  </article>;
}
