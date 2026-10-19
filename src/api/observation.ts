import type { ObserveResult, ObservedContent, ObservedFrame } from './tab.js';
import { ActionError } from './errors.js';

// Leave room for the MCP envelope within the default 12,000-character REPL output.
export const OBSERVATION_BUDGET = 10_000;

/** Page one immutable capture across documents. Offsets are text characters or DOM entries. */
export function observationPage(capture: ObserveResult, cursor?: string): ObserveResult {
  const parts = cursor?.split(':');
  let section = parts ? Number(parts[1]) : 0;
  let offset = parts ? Number(parts[2]) : 0;
  const sections: ObservedContent[] = [capture, ...(capture.frames ?? [])];
  if (parts && (parts.length !== 3 || parts[0] !== capture.snapshotId || !Number.isSafeInteger(section) || section < 0 || section >= sections.length || !Number.isSafeInteger(offset) || offset < 0)) {
    throw new ActionError('stale_observation', 'Observation cursor is invalid or expired.', 'Call tab.observe() for a fresh snapshot.');
  }
  const { state: _state, dom: _dom, warnings: _warnings, diff: _diff, changed: _changed, frames: _frames, image: _image, ...header } = capture;
  let metadataTruncated = false;
  const preview = (value: string | null, limit: number) => {
    if (value === null || value.length <= limit) return value;
    metadataTruncated = true;
    return value.slice(0, limit) + '…';
  };
  const out: ObserveResult = { ...header, url: preview(header.url, 1200), title: preview(header.title, 300), complete: false };
  if (metadataTruncated) out.metadataTruncated = true;
  let progressed = false;
  while (section < sections.length) {
    const source = sections[section];
    const length = source.dom ? source.dom.entries.length : (source.state?.length ?? 0);
    if (offset > length) throw new ActionError('stale_observation', 'Observation cursor offset is invalid.', 'Call tab.observe() for a fresh snapshot.');
    const { state, dom, ...metadata } = section === 0
      ? { state: source.state, dom: source.dom, warnings: source.warnings, diff: source.diff, changed: source.changed }
      : source;
    metadataTruncated = false;
    if ('owner' in metadata) {
      const owner = (metadata as ObservedFrame).owner;
      (metadata as ObservedFrame).owner = { ...owner, id: preview(owner.id, 200)!, name: preview(owner.name, 200)!, src: preview(owner.src, 1000)! };
    }
    if (metadata.warnings) metadata.warnings = metadata.warnings.map(warning => preview(warning, 500)!);
    if ('unavailable' in metadata && typeof metadata.unavailable === 'string') metadata.unavailable = preview(metadata.unavailable, 500)!;
    if (metadataTruncated) metadata.metadataTruncated = true;
    const candidate = (end: number): ObservedContent => ({
      ...metadata,
      ...(dom ? { dom: { ...dom, start: dom.start + offset, entries: dom.entries.slice(offset, end), ...(end < length ? { nextStart: dom.start + end } : {}) } } : {}),
      ...(state !== undefined ? { state: state.slice(offset, end), ...(offset > 0 && state[offset - 1] !== '\n' ? { stateContinued: true } : {}), ...(end < length && state[end - 1] !== '\n' ? { stateContinues: true } : {}) } : {}),
    });
    const place = (content: ObservedContent, end: number): ObserveResult => {
      const nextSection = end === length ? section + 1 : section;
      const nextOffset = end === length ? 0 : end;
      return {
        ...out, ...(section === 0 ? content : { frames: [...(out.frames ?? []), content as ObservedFrame] }),
        complete: nextSection === sections.length,
        ...(nextSection < sections.length ? { nextCursor: `${capture.snapshotId}:${nextSection}:${nextOffset}`, next: { cursor: `${capture.snapshotId}:${nextSection}:${nextOffset}` } } : { nextCursor: undefined, next: undefined }),
      };
    };
    const fits = (end: number) => JSON.stringify(place(candidate(end), end)).length <= OBSERVATION_BUDGET;
    let end = length;
    if (!fits(end)) {
      let low = offset, high = length;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (fits(mid)) low = mid; else high = mid - 1;
      }
      end = low;
      // Keep complete lines whenever possible; a single oversized text line uses explicit fragments.
      if (state && end < length) {
        const newline = state.lastIndexOf('\n', end - 1);
        if (newline >= offset) end = newline + 1;
        // Never split a UTF-16 surrogate pair.
        if (end > offset && /[\uD800-\uDBFF]/.test(state[end - 1])) end--;
      }
      if (end === offset || !fits(end)) {
        if (!progressed) throw new ActionError('observation_metadata_too_large', 'One observation entry or its metadata exceeds the output budget.', 'Observe a narrower ref or read the element with tab.read({target:{ref}}).');
        out.nextCursor = `${capture.snapshotId}:${section}:${offset}`;
        out.next = { cursor: out.nextCursor };
        return out;
      }
    }
    Object.assign(out, place(candidate(end), end));
    progressed = true;
    if (end < length) return out;
    section++;
    offset = 0;
  }
  return out;
}
