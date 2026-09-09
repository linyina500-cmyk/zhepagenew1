import { measureParts } from "./measureBlock";
import { connectCalloutsInHtml } from "../beautify/connectCallouts";
import { RICH_LAYOUT_CLASS, isRichLayoutGroup } from "../richText/normalizeRichHtml";
import { articleBlocks, blockIsHeading, blockText } from "./articleBlocks";
import { splitOversizedBlock } from "./splitDomBlock";
import { assertPaginationSemantics } from "./semanticIntegrity";
import type { PaginationResult } from "./paginationTypes";

const FIT_TOLERANCE = 2;

export function paginateArticle(html: string, measure: HTMLDivElement, maxHeight: number): PaginationResult {
  const pages: string[] = [];
  let current: string[] = [];
  const queue = articleBlocks(html);

  const heightOf = (parts: string[]) => measureParts(measure, parts);
  const fits = (parts: string[]) => heightOf(parts) <= maxHeight + FIT_TOLERANCE;
  const commit = () => {
    if (current.length) pages.push(current.join(""));
    current = [];
  };
  const fitCompositeVisual = (block: string) => {
    if (!new RegExp(`class=["'][^"']*${RICH_LAYOUT_CLASS}`).test(block)) return block;
    const parsed = new DOMParser().parseFromString(`<main>${block}</main>`, "text/html");
    const candidate = parsed.querySelector("main")?.firstElementChild;
    if (!candidate || !isRichLayoutGroup(candidate)) return block;
    const originalHeight = heightOf([block]);
    if (originalHeight <= maxHeight + FIT_TOLERANCE) return block;
    const scale = Math.min(0.98, (maxHeight - 8) / originalHeight);
    const fittedHeight = Math.min(maxHeight, Math.ceil(originalHeight * scale));
    const innerWidth = (100 / scale).toFixed(3);
    return `<div class="scaled-composite-visual" style="height:${fittedHeight}px"><div class="scaled-composite-visual-inner" style="width:${innerWidth}%;transform:scale(${scale.toFixed(4)})">${block}</div></div>`;
  };

  while (queue.length) {
    const block = queue.shift()!;
    const isManualBreak = /class=["'][^"']*manual-page-break/.test(block)
      && new DOMParser().parseFromString(block, "text/html").body.firstElementChild?.classList.contains("manual-page-break");
    if (isManualBreak) {
      commit();
      continue;
    }
    if (fits([...current, block])) {
      current.push(block);
      continue;
    }

    const fittedVisual = fitCompositeVisual(block);
    if (fittedVisual !== block) {
      commit();
      current.push(fittedVisual);
      commit();
      continue;
    }

    if (current.length) {
      const availableHeight = Math.max(1, maxHeight - heightOf(current));
      // Measure the first fragment together with the content already on the
      // page. Measuring it alone loses collapsed margins and can incorrectly
      // move a splittable paragraph to the next page, leaving a large hole.
      const { pieces, splitAtPageBoundary } = splitOversizedBlock(
        block,
        measure,
        maxHeight,
        availableHeight,
        (piece) => fits([...current, piece]),
      );
      // Exposing child paragraphs is not a page break. Keep packing them in
      // order instead of committing a mostly empty page after the first child.
      if (pieces.length > 1 && !splitAtPageBoundary) {
        queue.unshift(...pieces);
        continue;
      }
      const firstPieceFits = pieces.length > 1 && fits([...current, pieces[0]]);
      const splitFollowerIsUseful = !blockIsHeading(current[current.length - 1])
        || blockText(pieces[0]).trim().length >= 18;
      if (firstPieceFits && splitFollowerIsUseful) {
        current.push(pieces[0]);
        commit();
        queue.unshift(...pieces.slice(1));
        continue;
      }

      // A measured fragment may be unsuitable after a heading or wrapper.
      // Retry its smaller pieces in order before abandoning the page space.
      if (pieces.length > 1) {
        queue.unshift(...pieces);
        continue;
      }

      // Move a trailing heading only when it leaves content on the old page.
      // A heading already alone on a fresh page cannot move any farther:
      // retrying it with the same unsplittable follower would loop forever.
      if (current.length > 1 && blockIsHeading(current[current.length - 1])) {
        const heading = current.pop()!;
        commit();
        queue.unshift(heading, block);
        continue;
      }

      commit();
      queue.unshift(block);
      continue;
    }

    const { pieces } = splitOversizedBlock(block, measure, maxHeight, maxHeight);
    if (!pieces.length) continue;
    if (pieces.length > 1) {
      queue.unshift(...pieces);
      continue;
    }
    current.push(block);
    commit();
  }

  commit();
  const normalizedPages = pages.map(connectCalloutsInHtml);
  assertPaginationSemantics(html, normalizedPages);
  // This is a UI empty state, added only after the content contract is checked.
  if (!normalizedPages.length) normalizedPages.push("<p>暂无正文内容</p>");
  const usage = normalizedPages.map((page) => Math.min(1.5, heightOf([page]) / maxHeight));
  measure.innerHTML = "";
  return { pages: normalizedPages, usage };
}
