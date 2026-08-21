export function measureHtml(measure: HTMLDivElement, html: string) {
  measure.innerHTML = html;
  return measure.scrollHeight;
}

export function measureParts(measure: HTMLDivElement, parts: string[]) {
  return measureHtml(measure, parts.join(""));
}
