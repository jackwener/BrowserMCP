function lineIndent(line: string): number { return line.length - line.trimStart().length; }

/** Remove only inert, unnamed wrappers; preserve addressable nodes and all their context. */
export function compactAria(text: string): string {
  const removed: number[] = [];
  return text.split('\n').flatMap(line => {
    const indent = lineIndent(line);
    while (removed.length && removed[removed.length - 1] >= indent) removed.pop();
    if (/^- (generic|group|listitem):?$/.test(line.trim())) {
      removed.push(indent);
      return [];
    }
    return [' '.repeat(Math.max(0, indent - removed.length * 2)) + line.trimStart()];
  }).join('\n');
}
