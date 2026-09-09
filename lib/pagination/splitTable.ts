import { measureHtml } from "./measureBlock";
import type { FragmentEdges } from "./blockStructure";

export const TABLE_SOURCE_ATTRIBUTE = "data-pagination-table";
export const TABLE_REPEAT_ATTRIBUTE = "data-pagination-table-repeat";

export function tableHeader(table: Element) {
  const explicitHead = table.querySelector(":scope > thead");
  if (explicitHead) return explicitHead.cloneNode(true) as Element;
  const firstRow = table.querySelector(":scope > tbody > tr, :scope > tr");
  if (!firstRow?.children.length || ![...firstRow.children].every((cell) => cell.tagName === "TH")) return null;
  const head = table.ownerDocument.createElement("thead");
  head.append(firstRow.cloneNode(true));
  return head;
}

export function splitTableToPages(
  table: Element,
  parsed: Document,
  measure: HTMLDivElement,
  maxHeight: number,
  firstMaxHeight = maxHeight,
  firstPieceFits?: (html: string) => boolean,
  wrap: (element: Element, edges: FragmentEdges) => Element = (element) => element,
) {
  let rows = [...table.querySelectorAll(":scope > tbody > tr, :scope > tr")];
  const caption = table.querySelector(":scope > caption")?.cloneNode(true) as Element | undefined;
  const colgroup = table.querySelector(":scope > colgroup")?.cloneNode(true) as Element | undefined;
  const head = tableHeader(table);
  const foot = table.querySelector(":scope > tfoot")?.cloneNode(true) as Element | undefined;
  if (head && !table.querySelector(":scope > thead")) rows = rows.slice(1);
  if (!rows.length || rows.length === 1 && !foot) return [table.outerHTML];

  const buildTable = (bodyRows: Element[], includeFoot: boolean, continuation: boolean) => {
    const nextTable = table.cloneNode(false) as Element;
    const appendHeading = (element: Element | null | undefined) => {
      if (!element) return;
      const clone = element.cloneNode(true) as Element;
      if (continuation) clone.setAttribute(TABLE_REPEAT_ATTRIBUTE, "true");
      nextTable.append(clone);
    };
    appendHeading(caption);
    if (colgroup) nextTable.append(colgroup.cloneNode(true));
    appendHeading(head);
    const body = parsed.createElement("tbody");
    bodyRows.forEach((row) => body.append(row.cloneNode(true)));
    nextTable.append(body);
    if (includeFoot && foot) nextTable.append(foot.cloneNode(true));
    return nextTable;
  };
  const pieces: string[] = [];
  let chunkRows: Element[] = [];
  const fitsTable = (candidate: Element, end: boolean) => {
    const wrapped = wrap(candidate, { start: pieces.length === 0, end });
    return pieces.length === 0 && firstPieceFits
      ? firstPieceFits(wrapped.outerHTML)
      : measureHtml(measure, wrapped.outerHTML) <= (pieces.length ? maxHeight : firstMaxHeight) + 2;
  };
  let index = 0;
  while (index < rows.length) {
    const isLastRow = index === rows.length - 1;
    const candidate = buildTable([...chunkRows, rows[index]], isLastRow, pieces.length > 0);
    if (fitsTable(candidate, isLastRow)) {
      chunkRows.push(rows[index]);
      index += 1;
      continue;
    }
    if (isLastRow && foot) {
      const rowsWithoutFoot = buildTable([...chunkRows, rows[index]], false, pieces.length > 0);
      if (fitsTable(rowsWithoutFoot, false)) {
        // Keep all fitting body rows together before moving only the footer.
        pieces.push(rowsWithoutFoot.outerHTML, buildTable([], true, true).outerHTML);
        chunkRows = [];
        index += 1;
        continue;
      }
    }
    if (chunkRows.length) {
      pieces.push(buildTable(chunkRows, false, pieces.length > 0).outerHTML);
      chunkRows = [];
      // Retry this row on the next page, including its actual wrapper edges.
    } else {
      if (!pieces.length && firstPieceFits) {
        // No complete row fits beside existing content. Let the paginator retry
        // the original table on a fresh page without losing or duplicating rows.
        return [table.outerHTML];
      }
      // A single row is indivisible. Preserve it when it exceeds an entire page.
      pieces.push(candidate.outerHTML);
      index += 1;
    }
  }
  if (chunkRows.length) pieces.push(buildTable(chunkRows, true, pieces.length > 0).outerHTML);
  return pieces;
}
