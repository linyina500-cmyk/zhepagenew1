import { connectAdjacentCallouts } from "../beautify/connectCallouts";

export function measureHtml(measure: HTMLDivElement, html: string) {
  measure.innerHTML = html;
  connectAdjacentCallouts(measure);
  return measure.scrollHeight;
}

export function measureParts(measure: HTMLDivElement, parts: string[]) {
  return measureHtml(measure, parts.join(""));
}
