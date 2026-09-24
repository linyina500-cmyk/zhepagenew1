import { meaningfulContentNode } from "../richText/contentNodes";

/** Separate only the editor's risk block, keeping every body node in place. */
export function separateRiskNote(html: string) {
  const template = document.createElement("template");
  template.innerHTML = html;
  const notes = template.content.querySelectorAll(".risk-note");
  const hadRisk = notes.length > 0;
  notes.forEach((note) => note.remove());
  const hasContent = [...template.content.childNodes].some(meaningfulContentNode);
  return { html: template.innerHTML, riskOnly: hadRisk && !hasContent };
}
