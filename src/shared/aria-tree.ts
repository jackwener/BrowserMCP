const SEPARATOR_TEXT = /^- text: (?:"[\s|·•,;:()[\]\/\\\-–—]*"|[\s|·•,;:()[\]\/\\\-–—]+)$/;
/** Compact a serialized ARIA tree without discarding unique names or control state. */
export function compactAria(text: string): string {
  type Node = { line: string; indent: number; children: Node[] };
  const root: Node = { line: '', indent: -1, children: [] };
  const stack = [root];
  for (const raw of text.split('\n')) {
    const line = raw.trimStart().replace(/^(- [\w-]+(?: "(?:[^"\\]|\\.)*")?)((?: \[[^\]]+\])*)(.*)$/, (_all, key: string, attrs: string, tail: string) => key + attrs.replace(/ \[cursor=pointer\]/g, '') + tail);
    const node: Node = { line, indent: raw.length - raw.trimStart().length, children: [] };
    while (stack.length > 1 && stack.at(-1)!.indent >= node.indent) stack.pop();
    stack.at(-1)!.children.push(node); stack.push(node);
  }
  const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();
  function render(node: Node, depth: number): { lines: string[]; text: string } {
    // Inert wrappers print no line; their children move up a level. Unnamed cells and row groups are layout (HN's
    // nested tables spent a third of the snapshot on them); a row stays, it groups a record.
    const unnamed = /^- (generic|group|rowgroup|cell)(?: \[ref=[^\]]+\])?:?$/.test(node.line);
    // An empty row and a separator-only text ("|", "·", "(") carry nothing.
    if (!node.children.length && (/^- row(?: \[ref=[^\]]+\])?$/.test(node.line) || SEPARATOR_TEXT.test(node.line))) return { lines: [], text: '' };
    const children = node.children.map(child => render(child, depth + (unnamed ? 0 : 1)));
    const childText = normalize(children.map(child => child.text).join(' '));
    let line = node.line;
    const label = /^- (generic|group|article|listitem|region) ("(?:[^"\\]|\\.)*")/.exec(line);
    if (label && childText) {
      try {
        // Only remove a name when the full value is also present in the descendants.
        if (normalize(JSON.parse(label[2])) === childText) line = line.replace(` ${label[2]}`, '');
      } catch { /* Keep names that are not JSON string literals. */ }
    }
    const ownText = /^- text: (.*)$/.exec(line)?.[1] ?? /^- \w+ ("(?:[^"\\]|\\.)*")/.exec(line)?.[1] ?? '';
    return { lines: [...(unnamed ? [] : ['  '.repeat(depth) + line]), ...children.flatMap(child => child.lines)], text: childText || ownText.replace(/^"|"$/g, '') };
  }
  return root.children.flatMap(node => render(node, 0).lines).join('\n');
}
