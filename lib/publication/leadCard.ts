export type PublicationCopy = {
  intro: string;
  summary: string;
  offer: string;
  fileLabel: string;
  coverSubtitle: string;
  editionLabel: string;
};

export const DEFAULT_PUBLICATION_NAME = "固态电池产业迈向规模应用";
export const DEFAULT_LEAD_GUIDE = "长按识别，添加小助理，即可领取！";
export const DEFAULT_PUBLICATION_COPY: PublicationCopy = {
  intro: "为此特别整理一份最新的刊物",
  summary: "里面包含看好逻辑，以及值得关注的5个核心方向。",
  offer: "现在，免费开放领取",
  fileLabel: "电子版 · PDF",
  coverSubtitle: "看好逻辑 · 5个核心方向 · 投资参考",
  editionLabel: "电子版刊物",
};

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character]!);
}

// All sizes are relative to the card width, so preview, pagination and export
// use the same layout. Long copy shrinks rather than silently losing words.
function fittedSize(text: string, width: number, maximum: number, height: number) {
  const lines = text.replace(/\r/g, "").split("\n");
  const units = Math.max(1, ...lines.map((line) => [...line].reduce((sum, character) => sum + (/[WMmw@%]/.test(character) ? 1.15 : /^[\x20-\x7e]$/.test(character) ? 0.9 : 1), 0)));
  return Math.min(maximum, width / units, height / (lines.length * 1.2)).toFixed(3);
}

function copy(className: string, text: string, width: number, maximum: number, height: number) {
  return `<div class="${className}" style="font-size:${fittedSize(text, width, maximum, height)}cqw">${escapeHtml(text)}</div>`;
}

export function createLeadCardHtml(publicationName: string, guide: string, qrDataUrl: string, details: PublicationCopy = DEFAULT_PUBLICATION_COPY) {
  const name = publicationName.trim().replace(/^《|》$/g, "");
  const heading = name ? `《${name}》` : "";
  const characters = [...name];
  const coverTitle = !name.includes("\n") && characters.length > 8
    ? `${characters.slice(0, Math.ceil(characters.length / 2)).join("")}\n${characters.slice(Math.ceil(characters.length / 2)).join("")}` : name;
  const safeQr = /^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/=\s]+$/i.test(qrDataUrl) ? qrDataUrl : "";
  const qrMarkup = safeQr
    ? `<img class="lead-card-qr" src="${escapeHtml(safeQr)}" alt="刊物领取二维码">`
    : '<div class="lead-card-qr-placeholder"><span aria-hidden="true">▦</span><span>上传你的二维码</span></div>';
  const guideText = escapeHtml(guide).replace(/即可领取！$/, "<span>即可领取！</span>");
  return `<aside class="lead-magnet-card" aria-label="PDF 刊物领取卡">
    ${copy("lead-card-intro", details.intro, 46, 2.82, 4.15)}
    ${copy("lead-card-title", heading, 89, 6.5, 7.8)}
    ${copy("lead-card-summary", details.summary, 78, 2.65, 3.55)}
    ${copy("lead-card-offer", details.offer, 50, 4.55, 6)}
    <div class="lead-card-panel" aria-hidden="true"></div>
    <div class="lead-card-file">
      <div class="lead-card-file-heading">
        <div class="lead-card-pdf-icon" aria-hidden="true"><img src="/publication-pdf-icon.png" alt=""></div>
        ${copy("lead-card-file-name", name ? `${name.replace(/\n/g, " ")}.pdf` : "", 37, 1.94, 2.5)}
        ${copy("lead-card-file-label", details.fileLabel, 37, 1.6, 2.15)}
      </div>
      <div class="lead-card-cover">
        <img class="lead-card-cover-image" src="/publication-battery.png" alt="蓝色固态电池科技配图">
        <div class="lead-card-cover-copy">
          ${copy("lead-card-cover-title", coverTitle, 41, 2.43, 5.8)}
          ${copy("lead-card-cover-subtitle", details.coverSubtitle, 31.5, 1.49, 1.95)}
          ${copy("lead-card-edition", details.editionLabel, 9.4, 1.62, 2.25)}
        </div>
      </div>
    </div>
    <div class="lead-card-qr-wrap">${qrMarkup}</div>
    <div class="lead-card-guide" style="font-size:${fittedSize(guide, 76, 3.48, 5.8)}cqw"><div class="lead-card-guide-text">${guideText}</div></div>
  </aside>`;
}
