// Vendor Playwright's injected script (Apache-2.0) from playwright-core's bundle.
// The page-side engine browsermcp relies on: selector engines (role/text/label/testid/css/xpath),
// element states, fill/select helpers, hit-target checks, selector generation and aria snapshots.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const pkg = require('playwright-core/package.json');
const bundle = readFileSync(resolve(dirname(require.resolve('playwright-core/package.json')), 'lib/coreBundle.js'), 'utf8');
const marker = "packages/playwright-core/src/generated/injectedScriptSource.ts";
const at = bundle.indexOf(marker);
if (at < 0) throw new Error('injectedScriptSource marker not found');
const assign = bundle.indexOf("source4 = '", at);
const start = assign + 'source4 = '.length;
let i = start + 1;
while (i < bundle.length) { if (bundle[i] === '\\') { i += 2; continue; } if (bundle[i] === "'") break; i++; }
const literal = bundle.slice(start, i + 1);
const vendored = new Function('return ' + literal)();

// Agent snapshots (mode:"ai") describe what a person can see. Playwright counts opacity:0 as visible, so a
// pre-rendered "Payment successful" banner shows up as page content and agents report success that never happened.
// Content under a fully transparent element is left out; a transparent control stays, because a click still lands
// on it (styled checkboxes, file pickers and selects keep a transparent native control on top).
function patch(text, anchor, replacement) {
  if (text.split(anchor).length !== 2) throw new Error(`Playwright injected source changed; patch anchor not found exactly once:\n${anchor}`);
  return text.replace(anchor, () => replacement);
}
let source = patch(vendored,
  'function generateAriaTree(rootElement, publicOptions) {\n  const options = toInternalOptions(publicOptions);\n',
  `var browsermcpTransparent;
function browsermcpIsTransparent(element) {
  let known = browsermcpTransparent.get(element);
  if (known === undefined) {
    const style = getElementComputedStyle(element);
    const parent = parentElementOrShadowHost(element);
    known = (style != null && style.opacity === "0") || (parent ? browsermcpIsTransparent(parent) : false);
    browsermcpTransparent.set(element, known);
  }
  return known;
}
function browsermcpIsControl(element) {
  const tag = element.nodeName;
  if (tag === "BUTTON" || tag === "SELECT" || tag === "TEXTAREA" || (tag === "INPUT" && element.type !== "hidden")) return true;
  if (tag === "A" && element.hasAttribute("href")) return true;
  if (element.isContentEditable) return true;
  return ["button", "link", "checkbox", "radio", "switch", "textbox", "searchbox", "combobox", "listbox", "option", "menuitem", "menuitemcheckbox", "menuitemradio", "slider", "spinbutton", "tab", "treeitem"].includes(element.getAttribute("role") || "");
}
function generateAriaTree(rootElement, publicOptions) {
  const options = toInternalOptions(publicOptions);
  browsermcpTransparent = new Map();
`);
source = patch(source,
  '    if (options.visibility === "ariaAndVisible")\n      visible = isElementVisibleForAria && isElementVisible(element);\n',
  '    if (options.visibility === "ariaAndVisible")\n      visible = isElementVisibleForAria && isElementVisible(element);\n' +
  '    if (visible && options.visibility === "ariaOrVisible" && browsermcpIsTransparent(element) && !browsermcpIsControl(element))\n      visible = false;\n');

// An empty field in a record (a salary slot left blank for logged-out viewers, a "--" placeholder cleared by script)
// has no text, so ai mode drops it, and "this page has no such field" becomes indistinguishable from "the value is
// withheld". An empty text-level leaf that collapsed to no box (a painted icon or rule is decoration), carries an id or
// class and sits beside text keeps a node and a ref; browsermcp's page module labels it [empty] with the identifier that names it.
source = patch(source,
  'function generateAriaTree(rootElement, publicOptions) {\n',
  `var browsermcpSlotTags = new Set(["P", "SPAN", "DIV", "DD", "TD", "EM", "STRONG", "B", "SMALL", "LABEL", "TIME", "DATA", "OUTPUT"]);
function browsermcpIsEmptySlot(element, ariaNode) {
  if (ariaNode.name || !browsermcpSlotTags.has(element.nodeName) || element.children.length) return false;
  if (!(element.id || (element.getAttribute("class") || "").trim())) return false;
  if (!ariaNode.children.every((child) => typeof child === "string" && !child.trim())) return false;
  // An empty element that still paints a box is a decoration (an icon, a separator), not a missing value.
  const box = element.getBoundingClientRect();
  if (box.width > 0 && box.height > 0) return false;
  const parent = element.parentElement;
  return !!parent && [...parent.children].some((sibling) => sibling !== element && !!(sibling.textContent || "").trim());
}
function generateAriaTree(rootElement, publicOptions) {
`);
source = patch(source,
  '    processElement(childAriaNode || ariaNode, element, ariaChildren, visible);\n',
  `    processElement(childAriaNode || ariaNode, element, ariaChildren, visible);
    if (childAriaNode && visible && options.refs === "interactable" && browsermcpIsEmptySlot(element, childAriaNode)) {
      if (!childAriaNode.ref) {
        computeAriaRef(childAriaNode, { ...options, refs: "all" });
        snapshot.info.set(childAriaNode.ref, { element, nameFromContentRefs: [] });
        snapshot.refs.set(element, childAriaNode.ref);
      }
      childAriaNode.browsermcpEmptySlot = true;
    }
`);
source = patch(source,
  '    if (!node.children.length && isClickTargetRoot(node, ctx))\n      return;\n',
  '    if (node.browsermcpEmptySlot)\n      return;\n    if (!node.children.length && isClickTargetRoot(node, ctx))\n      return;\n');
// Also emit the source as a module both the host (tsc) and the extension (esbuild) import.
writeFileSync('src/shared/injected-source.ts', `// GENERATED by scripts/extract-playwright-injected.mjs — do not edit.\n// Playwright injected script, Apache-2.0 (https://github.com/microsoft/playwright), from playwright-core ${pkg.version}; patched there for agent snapshots (transparent content, empty fields).\nexport const INJECTED_SOURCE: string = ${JSON.stringify(source)};\nexport const INJECTED_VERSION = ${JSON.stringify(pkg.version)};\n`);
console.log('wrote src/shared/injected-source.ts');
