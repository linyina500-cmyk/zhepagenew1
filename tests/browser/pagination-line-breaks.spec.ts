import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import ts from "typescript";

// Run the actual splitter with the actual stylesheet. A DOM-only height mock
// cannot detect a soft break that paints an extra line at a page boundary.
const modules = Object.fromEntries([
  ["./splitText", "lib/pagination/splitText.ts"],
  ["./measureBlock", "lib/pagination/measureBlock.ts"],
  ["../beautify/connectCallouts", "lib/beautify/connectCallouts.ts"],
  ["../richText/contentNodes", "lib/richText/contentNodes.ts"],
].map(([name, file]) => [name, ts.transpileModule(readFileSync(file, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText]));
const stylesheet = readFileSync("app/globals.css", "utf8");

test("soft breaks crossing page boundaries preserve their painted line count and inline marks", async ({ page }) => {
  await page.setContent(`<style>${stylesheet}
    .article-flow { width: 200px; }
    .article-flow p { margin: 0; font: 20px/40px sans-serif !important; }
    </style><div id="measure" class="article-flow"></div>`);
  const results = await page.evaluate((sources) => {
    const cache: Record<string, { exports: Record<string, unknown> }> = {};
    const load = (name: string): Record<string, unknown> => {
      if (cache[name]) return cache[name].exports;
      const loaded = cache[name] = { exports: {} };
      new Function("require", "module", "exports", sources[name])(load, loaded, loaded.exports);
      return loaded.exports;
    };
    const { splitTextPreservingDom } = load("./splitText") as typeof import("../../lib/pagination/splitText");
    const measure = document.querySelector<HTMLDivElement>("#measure")!;
    const sequence = (element: Element) => {
      let result = "";
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.nodeType === Node.TEXT_NODE) result += node.textContent;
        else if ((node as Element).matches("br")) result += "\n";
      }
      return result;
    };
    return [
      "<p>A<br></p>",
      "<p>A<br>B<br>C<br></p>",
      "<p>A<br><br><br></p>",
      "<p><strong>A<br></strong></p>",
      "<p>A<strong><br></strong>B</p>",
      "<p><br>A<br>B<br></p>",
    ].map((html) => {
      measure.innerHTML = html;
      const original = measure.firstElementChild!.cloneNode(true) as Element;
      const sourceHeight = measure.scrollHeight;
      const pieces = splitTextPreservingDom(original, measure, 80, 40);
      return {
        html, sourceHeight, sourceSequence: sequence(original),
        outputSequence: pieces.map(sequence).join(""),
        heights: pieces.map((piece) => { measure.innerHTML = piece.outerHTML; return measure.scrollHeight; }),
        preservesMarks: !original.querySelector("strong") || pieces.every((piece) =>
          !piece.querySelector("br") || Boolean(piece.querySelector("strong > br"))),
      };
    });
  }, modules);
  for (const result of results) {
    expect(result.outputSequence, result.html).toBe(result.sourceSequence);
    expect(result.preservesMarks, result.html).toBe(true);
    expect(result.heights[0], result.html).toBeLessThanOrEqual(40);
    expect(result.heights.slice(1).every((height) => height <= 80), result.html).toBe(true);
    expect(result.heights.reduce((sum, height) => sum + height, 0), result.html).toBe(result.sourceHeight);
  }
});
