import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { JSDOM } from "jsdom";

const root = fileURLToPath(new URL("../../", import.meta.url));
const modules = new Map();

export function installDom() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost", pretendToBeVisual: true });
  const names = ["window", "document", "navigator", "DOMParser", "Node", "NodeFilter", "Element", "HTMLElement", "HTMLParagraphElement", "HTMLHeadingElement", "HTMLImageElement", "HTMLAnchorElement", "MutationObserver", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"];
  for (const name of names) {
    const value = dom.window[name];
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: typeof value === "function" && /^[a-z]/.test(name) ? value.bind(dom.window) : value });
  }
  return dom;
}

// Run the actual TypeScript functions, including local imports, in the test DOM.
export function loadDomModule(relativePath) {
  const filename = resolve(root, relativePath);
  if (modules.has(filename)) return modules.get(filename).exports;
  const loaded = { exports: {} };
  modules.set(filename, loaded);
  const nativeRequire = createRequire(filename);
  const require = (specifier) => {
    if (!specifier.startsWith(".")) return nativeRequire(specifier);
    const base = resolve(dirname(filename), specifier);
    const dependency = [base, `${base}.ts`, `${base}.tsx`, `${base}.js`].find((path) => existsSync(path));
    if (!dependency) throw new Error(`Missing test dependency: ${specifier}`);
    return loadDomModule(dependency);
  };
  const { outputText } = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX },
    fileName: filename,
  });
  new Function("require", "module", "exports", outputText)(require, loaded, loaded.exports);
  return loaded.exports;
}
