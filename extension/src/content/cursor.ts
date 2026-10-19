/**
 * Content script: the human-visible layer. A cursor overlay that glides to where the agent is
 * about to act (closed shadow root, pointer-events:none, never intercepts clicks). Real input still comes from CDP.
 */

const ROOT_ID = 'browsermcp-overlay-root';
let host: HTMLElement | null = null;
let cursor: HTMLElement | null = null;
let keeper: MutationObserver | null = null;
let pos = { x: -100, y: -100 };
let anim: number | null = null;
let finishMove: ((arrived: boolean) => void) | null = null;

function stopMotion(): void {
  if (anim !== null) cancelAnimationFrame(anim);
  anim = null;
  const finish = finishMove;
  finishMove = null;
  finish?.(false);
}

function place(el: HTMLElement, x: number, y: number, tilt = 0, stretch = 1): void {
  el.style.transform = `translate3d(${x - 2.5}px, ${y - 2}px, 0) rotate(${tilt}deg) scale(${stretch}, ${1 / stretch})`;
}

function ensureOverlay(): HTMLElement {
  if (host && document.documentElement.contains(host)) return cursor!;
  host = document.createElement('div');
  host.id = ROOT_ID;
  host.setAttribute('aria-hidden', 'true');
  host.setAttribute('style', 'all:initial;position:fixed;inset:0;z-index:2147483646;pointer-events:none;');
  const shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = `
    .c{position:fixed;left:0;top:0;width:26px;height:29px;pointer-events:none;will-change:transform;transform-origin:2.5px 2px;opacity:0;filter:blur(5px);transition:opacity .24s ease,filter .24s ease}
    .c.on{opacity:1;filter:blur(0)}
    .c img{display:block;width:26px;height:29px;user-select:none;filter:drop-shadow(0 1px 1px rgba(0,0,0,.48)) drop-shadow(0 0 6px rgba(51,156,255,.78)) drop-shadow(0 0 16px rgba(51,156,255,.38))}
    @media print{.c{display:none}}
    @media(prefers-reduced-motion:reduce){.c{transition:none}}
  `;
  cursor = document.createElement('div');
  cursor.className = 'c';
  const img = document.createElement('img');
  try { img.src = chrome.runtime.getURL('cursor.svg'); } catch { /* context invalidated */ }
  img.width = 26; img.height = 29; img.alt = ''; img.draggable = false;
  cursor.appendChild(img);
  shadow.append(style, cursor);
  document.documentElement.appendChild(host);
  keeper = new MutationObserver(() => { if (host && !document.documentElement.contains(host)) document.documentElement.appendChild(host); });
  keeper.observe(document.documentElement, { childList: true });
  return cursor;
}

function moveTo(x: number, y: number, animate: boolean): Promise<boolean> {
  const el = ensureOverlay();
  el.classList.add('on');
  stopMotion();
  const from = { ...pos };
  const dist = Math.hypot(x - from.x, y - from.y);
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  const duration = !animate || reduced || from.x < 0 || dist < .5 ? 0 : dist > 196 ? Math.min(760, 280 + dist * 0.38) : Math.min(300, 130 + dist * 0.7);
  const start = performance.now();
  if (duration === 0 || document.visibilityState !== 'visible') { pos = { x, y }; place(el, x, y); return Promise.resolve(true); }
  const dx = x - from.x; const dy = y - from.y;
  const arc = dist > 196 ? Math.min(95, dist * 0.16) : 0;
  const perpendicular = { x: -dy / dist, y: dx / dist };
  const mid = { x: (from.x + x) / 2, y: (from.y + y) / 2 };
  const room = (sign: number) => {
    const cx = mid.x + perpendicular.x * arc * sign;
    const cy = mid.y + perpendicular.y * arc * sign;
    return Math.min(cx, innerWidth - cx, cy, innerHeight - cy);
  };
  const sign = room(1) >= room(-1) ? 1 : -1;
  const control = { x: mid.x + perpendicular.x * arc * sign, y: mid.y + perpendicular.y * arc * sign };
  return new Promise((resolve) => {
    finishMove = resolve;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const u = 1 - Math.pow(1 - t, 3);
      const v = 1 - u;
      pos = { x: v * v * from.x + 2 * v * u * control.x + u * u * x, y: v * v * from.y + 2 * v * u * control.y + u * u * y };
      const tilt = Math.max(-9, Math.min(9, (dx - dy) * .018)) * Math.sin(Math.PI * u);
      place(el, pos.x, pos.y, tilt, 1 + .06 * Math.sin(Math.PI * u));
      if (t < 1) { anim = requestAnimationFrame(step); return; }
      anim = null; finishMove = null; pos = { x, y }; place(el, x, y); resolve(true);
    };
    anim = requestAnimationFrame(step);
  });
}

type CursorState = { x: number; y: number; seq: number; visible: boolean; animate?: boolean } | null;

/** The session is done with this tab: tear the overlay down completely (observer off, animation cancelled, root removed). */
function dispose(): void {
  keeper?.disconnect(); keeper = null;
  stopMotion();
  host?.remove(); host = null; cursor = null; pos = { x: -100, y: -100 };
}

/** Render the background-owned state: null → dispose; hidden → fade out (position kept); visible → glide (or jump) to the point, then report arrival with the sequence. */
function render(state: CursorState): Promise<{ arrived: boolean; seq?: number }> {
  if (!state) { dispose(); return Promise.resolve({ arrived: false }); }
  if (!state.visible) { stopMotion(); if (cursor) cursor.classList.remove('on'); pos = { x: state.x, y: state.y }; return Promise.resolve({ arrived: false }); }
  return moveTo(state.x, state.y, state.animate === true && document.visibilityState === 'visible').then((arrived) => ({ arrived, seq: state.seq }));
}

/** A new document (navigation, bfcache restore) starts from the background's state instead of blank. */
/** True until the extension is reloaded/updated; after that the old content script's chrome.* calls throw "Extension context invalidated". */
function alive(): boolean { try { return Boolean(chrome.runtime?.id); } catch { return false; } }

/** A new document (navigation, bfcache restore) starts from the background's state instead of blank. */
function pullState(): void {
  if (!alive()) return; // this content script belongs to a replaced extension version; the fresh one loads on next navigation
  try {
    chrome.runtime.sendMessage({ type: 'opencli:cursor-state?' })
      .then((r: { state?: CursorState } | undefined) => { if (r && r.state !== undefined) void render(r.state ? { ...r.state, animate: false } : null); })
      .catch(() => { /* context invalidated or no listener */ });
  } catch { /* context invalidated */ }
}

chrome.runtime.onMessage.addListener((msg: { type?: string; state?: CursorState }, _sender, sendResponse) => {
  if (msg?.type === 'opencli:ping') { sendResponse({ ok: true }); return false; }
  if (msg?.type === 'opencli:cursor-state') { void render(msg.state ?? null).then(sendResponse); return true; }
  return false;
});
window.addEventListener('pageshow', pullState);
pullState();
