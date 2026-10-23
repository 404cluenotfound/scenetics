import { useEffect, useMemo, useRef, useState } from 'react';
import type { Anchor, ElementType, MotionState, Scene, SceneElement, TrackProp } from './types';
import {
  generateAnimationsCss,
  generatePageJsx,
  sampleElementAt,
  sampleTracksAt,
  collectOffsets,
  anchorTranslate,
  placeholderImageSrc,
  SHADOWS,
  TRACK_DEFAULTS,
} from './lib/codegen.js';
import { createDefaultScene, createElement, FRAMES, localGenerate, migrateScene, normaliseElements, uid } from './lib/model';
import {
  candidatesToSpecs,
  colorToHex,
  detectFormat,
  IMPORT_CAP,
  jsxToHtml,
  pickEntryFile,
  readZipEntries,
  resolveAssetSrc,
} from './lib/importer.js';
import type { ImportCandidate } from './lib/importer.js';

const API = (import.meta as any).env?.VITE_API_URL || 'http://localhost:4000';
const LS_SCENE = 'scenetics-scene';
const LS_THEME = 'scenetics-theme';

const PALETTE: { type: ElementType; label: string }[] = [
  { type: 'heading', label: 'Heading' },
  { type: 'text', label: 'Text' },
  { type: 'button', label: 'Button' },
  { type: 'card', label: 'Card' },
  { type: 'image', label: 'Image' },
];

const ANCHORS: Anchor[] = [
  'top-left', 'top-center', 'top-right',
  'center-left', 'center', 'center-right',
  'bottom-left', 'bottom-center', 'bottom-right',
];

const TRACK_PROPS: TrackProp[] = ['translateX', 'translateY', 'scale', 'rotate', 'opacity'];

const FONTS = [
  'inherit', 'Inter', 'Roboto', 'Poppins', 'Montserrat', 'Playfair Display',
  'Georgia', 'Arial', 'Verdana', 'Trebuchet MS', 'Courier New', 'Impact',
];

const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const;
type Handle = (typeof HANDLES)[number];

const HANDLE_STYLE: Record<Handle, React.CSSProperties> = {
  nw: { left: -6, top: -6, cursor: 'nwse-resize' },
  n: { left: '50%', marginLeft: -6, top: -6, cursor: 'ns-resize' },
  ne: { right: -6, top: -6, cursor: 'nesw-resize' },
  e: { right: -6, top: '50%', marginTop: -6, cursor: 'ew-resize' },
  se: { right: -6, bottom: -6, cursor: 'nwse-resize' },
  s: { left: '50%', marginLeft: -6, bottom: -6, cursor: 'ns-resize' },
  sw: { left: -6, bottom: -6, cursor: 'nesw-resize' },
  w: { left: -6, top: '50%', marginTop: -6, cursor: 'ew-resize' },
};

const clampPct = (v: number) => Math.min(100, Math.max(0, v));
const r1 = (v: number) => Math.round(v * 10) / 10;
const esc = (s: string) => ((window as any).CSS?.escape ? (window as any).CSS.escape(s) : s);

/* ================================================================== */
/* v0.3 Import — the DOM half of the pipeline.                          */
/* Imported markup renders in a hidden, sandboxed iframe at a fixed     */
/* desktop width; we measure the rendered DOM (bounding rects relative  */
/* to the page root + computed styles) into plain ImportCandidate       */
/* objects, and the PURE mapping in lib/importer.js turns those into    */
/* native scene elements. Editor-only: nothing here reaches exports.    */
/* ================================================================== */

const IMPORT_RENDER_WIDTH = 1280;
const IMPORT_SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'TITLE', 'HEAD', 'NOSCRIPT', 'TEMPLATE', 'BR', 'WBR']);

function hasTailwindClasses(markup: string): boolean {
  const joined = (markup.match(/class(?:Name)?\s*=\s*"[^"]*"/g) || []).join(' ');
  return /\b(flex|grid|items-|justify-|content-|text-|bg-|p[trblxy]?-|m[trblxy]?-|w-|h-|min-h|rounded|font-|gap-|border|shadow|leading-|tracking-|uppercase|object-|overflow-|relative|absolute|fixed|inset-|top-|left-|z-)/.test(joined);
}

function buildImportDocument(markup: string, cssTexts: string[], useTailwind: boolean): string {
  const tailwind = useTailwind ? '<script src="https://cdn.tailwindcss.com"></script>' : '';
  const styles = cssTexts.map((t) => `<style>${t.replace(/<\/style/gi, '<\\/style')}</style>`).join('');
  if (/<!doctype|<html[\s>]/i.test(markup)) {
    if (/<\/head>/i.test(markup)) return markup.replace(/<\/head>/i, `${tailwind}${styles}</head>`);
    return markup.replace(/<body/i, `${tailwind}${styles}<body`);
  }
  return `<!doctype html><html><head><meta charset="utf-8">${tailwind}${styles}</head><body>${markup}</body></html>`;
}

function extractCandidatesFromDoc(
  doc: Document,
  win: Window
): { candidates: ImportCandidate[]; skipped: number; pageWidth: number; pageHeight: number } {
  const candidates: ImportCandidate[] = [];
  let skipped = 0;
  let visited = 0;
  const docEl = doc.documentElement;
  const pageWidth = Math.max(docEl.scrollWidth || 0, doc.body?.scrollWidth || 0, IMPORT_RENDER_WIDTH);
  const pageHeight = Math.max(docEl.scrollHeight || 0, doc.body?.scrollHeight || 0, 1);
  const rootRect = docEl.getBoundingClientRect();

  const directText = (el: Element) =>
    Array.from(el.childNodes)
      .filter((n) => n.nodeType === 3)
      .map((n) => n.textContent || '')
      .join(' ');
  const allLeaves = (el: Element) => Array.from(el.children).every((ch) => ch.children.length === 0);

  const visit = (el: Element) => {
    if (visited++ > 4000) return;
    const tag = el.tagName;
    if (IMPORT_SKIP_TAGS.has(tag)) return;
    const cs = win.getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const rect = { left: r.left - rootRect.left, top: r.top - rootRect.top, width: r.width, height: r.height };
    const meaningfulSize = r.width >= 2 && r.height >= 2;

    if (tag === 'SVG' || tag === 'IFRAME' || tag === 'VIDEO' || tag === 'CANVAS') {
      if (meaningfulSize) skipped += 1; // cannot become a native element (v1)
      return;
    }
    if (cs.display === 'none' || cs.visibility === 'hidden') {
      if (meaningfulSize && ((el.textContent || '').trim() || tag === 'IMG')) skipped += 1;
      return;
    }

    const styleOf = (): ImportCandidate['style'] => ({
      color: cs.color,
      backgroundColor: cs.backgroundColor,
      fontSizePx: parseFloat(cs.fontSize) || undefined,
      fontWeight: cs.fontWeight,
      fontStyle: cs.fontStyle,
      textAlign: cs.textAlign,
      borderRadius: cs.borderTopLeftRadius,
      opacity: parseFloat(cs.opacity),
      fontFamily: cs.fontFamily,
      lineHeightPx: parseFloat(cs.lineHeight) || undefined,
    });

    if (tag === 'IMG') {
      const img = el as HTMLImageElement;
      if (meaningfulSize) {
        candidates.push({ tag: 'img', text: img.alt || '', src: img.currentSrc || img.src || '', rect, style: styleOf() });
      } else skipped += 1;
      return;
    }

    const kids = Array.from(el.children).filter((ch) => !IMPORT_SKIP_TAGS.has(ch.tagName));
    const ownText = directText(el).replace(/\s+/g, ' ').trim();
    const fullText = (el.textContent || '').replace(/\s+/g, ' ').trim();
    const hasBgImage = !!cs.backgroundImage && cs.backgroundImage !== 'none';
    const bgVisible = colorToHex(cs.backgroundColor) !== null || hasBgImage;

    if (kids.length === 0) {
      if (fullText) candidates.push({ tag: tag.toLowerCase(), text: fullText, rect, style: styleOf() });
      return;
    }
    if (allLeaves(el) && fullText) {
      // e.g. <h1>Hello <span>world</span></h1> — one element, not fragments.
      candidates.push({ tag: tag.toLowerCase(), text: fullText, rect, style: styleOf() });
      return;
    }
    // Container with a real background: keep it as a card behind its
    // children (z-order = push order), then still convert the children.
    if (bgVisible && rect.width * rect.height > pageWidth * pageHeight * 0.004) {
      candidates.push({ tag: tag.toLowerCase(), text: ownText, container: true, hasBgImage, rect, style: styleOf() });
    } else if (bgVisible && ownText) {
      candidates.push({ tag: tag.toLowerCase(), text: ownText, rect, style: styleOf() });
    }
    for (const ch of Array.from(el.children)) visit(ch);
  };

  if (doc.body) for (const ch of Array.from(doc.body.children)) visit(ch);
  return { candidates, skipped, pageWidth, pageHeight };
}

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif', ico: 'image/x-icon',
};

function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    s += String.fromCharCode(...bytes.subarray(i, i + CH));
  }
  return btoa(s);
}

function fileToDataUrl(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(f);
  });
}

export default function App() {
  const [scene, setScene] = useState<Scene>(() => {
    try {
      const raw = localStorage.getItem(LS_SCENE);
      if (raw) {
        // v0.2 migration: fill defaults for fields old saves don't have.
        const migrated = migrateScene(JSON.parse(raw));
        if (migrated) return migrated;
      }
    } catch { /* fall through to default */ }
    return createDefaultScene();
  });
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [scrollPct, setScrollPct] = useState(0);
  const [theme, setTheme] = useState<string>(() => localStorage.getItem(LS_THEME) || 'dark');
  const [codeTab, setCodeTab] = useState<'jsx' | 'css'>('jsx');
  const [motionDraft, setMotionDraft] = useState<MotionState>({ ...TRACK_DEFAULTS } as MotionState);
  const [aiPrompt, setAiPrompt] = useState('');
  const [status, setStatus] = useState('');
  const [zoom, setZoom] = useState(1);
  const [snap, setSnap] = useState(false);
  const [lockRatio, setLockRatio] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const clipboardRef = useRef<SceneElement[]>([]);

  /* ---------------- v0.3 import state ---------------- */
  const [showImport, setShowImport] = useState(false);
  const [importText, setImportText] = useState('');
  const [importBusy, setImportBusy] = useState(false);
  const [importNote, setImportNote] = useState('');
  const [importSourceLabel, setImportSourceLabel] = useState('');
  const bundleRef = useRef<{
    label: string;
    entry: string;
    format: 'html' | 'jsx';
    assets: Record<string, string>;
    cssTexts: string[];
  } | null>(null);

  const primary: SceneElement | null =
    scene.elements.find((e) => e.id === selectedIds[selectedIds.length - 1]) || null;

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(LS_THEME, theme);
  }, [theme]);

  // Keep the selection pointing at elements that still exist (undo/delete).
  useEffect(() => {
    setSelectedIds((ids) => {
      const valid = ids.filter((id) => scene.elements.some((e) => e.id === id));
      return valid.length === ids.length ? ids : valid;
    });
  }, [scene]);

  // When the selection or the scrub position changes, show the element's
  // RAW track state in the Motion panel (base rotation / flip are separate
  // static tools; the panel edits keyframe values only).
  useEffect(() => {
    if (primary) setMotionDraft(sampleTracksAt(primary, scrollPct));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [primary?.id, scrollPct]);

  const pageJsx = useMemo(() => generatePageJsx(scene), [scene]);
  const animCss = useMemo(() => generateAnimationsCss(scene), [scene]);

  /* ---------------- undo / redo history ----------------
     Snapshots of scene JSON. Discrete edits push the previous scene;
     rapid bursts (typing, sliders) are coalesced; pointer gestures
     (drag / resize / rotate) push exactly one snapshot on release. */
  const [past, setPast] = useState<Scene[]>([]);
  const [future, setFuture] = useState<Scene[]>([]);
  const sceneRef = useRef(scene);
  sceneRef.current = scene;
  const prevSceneRef = useRef(scene);
  const gestureStartRef = useRef<Scene | null>(null);
  const restoringRef = useRef(false);
  const lastPushRef = useRef(0);
  const pendingRef = useRef<{ prev: Scene; result: Scene; timer: number } | null>(null);

  const pushHistory = (snapshot: Scene) => {
    setPast((p) => [...p.slice(-49), snapshot]); // cap ~50
    setFuture([]);
  };

  useEffect(() => {
    const prev = prevSceneRef.current;
    prevSceneRef.current = scene;
    if (restoringRef.current) {
      restoringRef.current = false;
      pendingRef.current = null;
      return;
    }
    if (gestureStartRef.current) return; // pushed by endGesture()
    if (prev === scene) return;
    const now = Date.now();
    if (now - lastPushRef.current >= 600 && !pendingRef.current) {
      pushHistory(prev);
      lastPushRef.current = now;
      return;
    }
    if (!pendingRef.current) pendingRef.current = { prev, result: scene, timer: 0 };
    else pendingRef.current.result = scene;
    window.clearTimeout(pendingRef.current.timer);
    pendingRef.current.timer = window.setTimeout(() => {
      const p = pendingRef.current;
      pendingRef.current = null;
      if (p && sceneRef.current === p.result && !restoringRef.current && !gestureStartRef.current) {
        pushHistory(p.prev);
        lastPushRef.current = Date.now();
      }
    }, 700);
  }, [scene]);

  const beginGesture = () => {
    if (!gestureStartRef.current) gestureStartRef.current = sceneRef.current;
  };
  const endGesture = () => {
    if (gestureStartRef.current) {
      if (gestureStartRef.current !== sceneRef.current) pushHistory(gestureStartRef.current);
      gestureStartRef.current = null;
      lastPushRef.current = Date.now();
    }
  };

  const undo = () => {
    if (past.length === 0) return;
    pendingRef.current = null;
    restoringRef.current = true;
    const target = past[past.length - 1];
    setPast(past.slice(0, -1));
    setFuture((f) => [scene, ...f].slice(0, 50));
    setScene(target);
    setStatus('Undone.');
  };
  const redo = () => {
    if (future.length === 0) return;
    pendingRef.current = null;
    restoringRef.current = true;
    const target = future[0];
    setFuture(future.slice(1));
    setPast((p) => [...p.slice(-49), scene]);
    setScene(target);
    setStatus('Redone.');
  };

  /* ---------------- scene mutation helpers ---------------- */
  const updateElement = (id: string, patch: Partial<SceneElement>) =>
    setScene((s) => ({ ...s, elements: s.elements.map((e) => (e.id === id ? { ...e, ...patch } : e)) }));

  const updateElements = (
    ids: string[],
    patch: Partial<SceneElement> | ((e: SceneElement) => Partial<SceneElement>)
  ) =>
    setScene((s) => ({
      ...s,
      elements: s.elements.map((e) =>
        ids.includes(e.id) ? { ...e, ...(typeof patch === 'function' ? patch(e) : patch) } : e
      ),
    }));

  const addElement = (el: SceneElement) => {
    setScene((s) => ({ ...s, elements: [...s.elements, el] }));
    setSelectedIds([el.id]);
  };

  const addFromPalette = (type: ElementType) => addElement(createElement(type));

  const addFrame = (build: () => SceneElement[]) => {
    const els = build();
    setScene((s) => ({ ...s, elements: [...s.elements, ...els] }));
    if (els[0]) setSelectedIds([els[0].id]);
    setStatus(`Frame added: ${els.length} editable elements.`);
  };

  /* ---------------- selection-aware actions ---------------- */
  const cloneWithNewIds = (els: SceneElement[]): SceneElement[] => {
    const groupMap = new Map<string, string>();
    return els.map((e) => {
      let gid = e.groupId;
      if (gid) {
        if (!groupMap.has(gid)) groupMap.set(gid, uid('grp'));
        gid = groupMap.get(gid)!;
      }
      return {
        ...e,
        id: uid(),
        groupId: gid,
        locked: false,
        tracks: JSON.parse(JSON.stringify(e.tracks || {})),
      };
    });
  };

  const offsetClones = (clones: SceneElement[]) =>
    clones.map((c) => ({ ...c, xPercent: clampPct(c.xPercent + 4), yPercent: clampPct(c.yPercent + 4) }));

  const duplicateSelected = () => {
    const els = scene.elements.filter((e) => selectedIds.includes(e.id));
    if (els.length === 0) return;
    const clones = offsetClones(cloneWithNewIds(els));
    setScene((s) => ({ ...s, elements: [...s.elements, ...clones] }));
    setSelectedIds(clones.map((c) => c.id));
    setStatus(`Duplicated ${clones.length} element(s).`);
  };

  const copySelected = () => {
    const els = scene.elements.filter((e) => selectedIds.includes(e.id));
    if (els.length === 0) return;
    clipboardRef.current = JSON.parse(JSON.stringify(els));
    try { navigator.clipboard.writeText(JSON.stringify(els)); } catch { /* internal clipboard still works */ }
    setStatus(`Copied ${els.length} element(s).`);
  };

  const pasteClipboard = () => {
    if (clipboardRef.current.length === 0) {
      setStatus('Nothing copied yet — select an element and copy it first.');
      return;
    }
    const clones = offsetClones(cloneWithNewIds(clipboardRef.current));
    setScene((s) => ({ ...s, elements: [...s.elements, ...clones] }));
    setSelectedIds(clones.map((c) => c.id));
    setStatus(`Pasted ${clones.length} element(s).`);
  };

  const deleteSelected = () => {
    if (selectedIds.length === 0) return;
    setScene((s) => ({ ...s, elements: s.elements.filter((e) => !selectedIds.includes(e.id)) }));
    setSelectedIds([]);
    setStatus('Deleted.');
  };

  const groupSelected = () => {
    if (selectedIds.length < 2) return;
    updateElements(selectedIds, { groupId: uid('grp') });
    setStatus('Grouped — grouped elements select and move together. Export stays flat.');
  };

  const ungroupPrimary = () => {
    const gid = primary?.groupId;
    if (!gid) return;
    setScene((s) => ({
      ...s,
      elements: s.elements.map((e) => (e.groupId === gid ? { ...e, groupId: null } : e)),
    }));
    setStatus('Ungrouped.');
  };

  /** Z-order = array order (later = on top). */
  const reorder = (id: string, dir: 'front' | 'back' | 'forward' | 'backward') => {
    setScene((s) => {
      const els = [...s.elements];
      const i = els.findIndex((e) => e.id === id);
      if (i < 0) return s;
      const [el] = els.splice(i, 1);
      let j = i;
      if (dir === 'front') j = els.length;
      if (dir === 'back') j = 0;
      if (dir === 'forward') j = Math.min(els.length, i + 1);
      if (dir === 'backward') j = Math.max(0, i - 1);
      els.splice(j, 0, el);
      return { ...s, elements: els };
    });
  };

  /* ---------------- align & distribute ----------------
     Measured from the live stage DOM at click time, then written back
     through the anchor model: the element's anchor stays the same, we
     solve for the x/y % that puts its box where the alignment wants it. */
  const measureBox = (id: string) => {
    const stage = stageRef.current;
    if (!stage) return null;
    const node = stage.querySelector(`[data-elid="${esc(id)}"]`);
    if (!node) return null;
    const sr = stage.getBoundingClientRect();
    const r = (node as HTMLElement).getBoundingClientRect();
    return {
      L: ((r.left - sr.left) / sr.width) * 100,
      T: ((r.top - sr.top) / sr.height) * 100,
      W: (r.width / sr.width) * 100,
      H: (r.height / sr.height) * 100,
    };
  };

  const alignSelected = (mode: 'left' | 'hcenter' | 'right' | 'top' | 'vmiddle' | 'bottom') => {
    if (selectedIds.length === 0) return;
    const boxes = new Map<string, NonNullable<ReturnType<typeof measureBox>>>();
    for (const id of selectedIds) {
      const b = measureBox(id);
      if (!b) return;
      boxes.set(id, b);
    }
    const list = [...boxes.values()];
    const target =
      list.length === 1
        ? { L: 0, T: 0, W: 100, H: 100 }
        : {
            L: Math.min(...list.map((b) => b.L)),
            T: Math.min(...list.map((b) => b.T)),
            W: Math.max(...list.map((b) => b.L + b.W)) - Math.min(...list.map((b) => b.L)),
            H: Math.max(...list.map((b) => b.T + b.H)) - Math.min(...list.map((b) => b.T)),
          };
    setScene((s) => ({
      ...s,
      elements: s.elements.map((e) => {
        const b = boxes.get(e.id);
        if (!b) return e;
        const a = anchorTranslate(e.anchor);
        let x = e.xPercent;
        let y = e.yPercent;
        if (mode === 'left') x = target.L - (a.x / 100) * e.widthPercent;
        if (mode === 'hcenter') x = target.L + (target.W - b.W) / 2 - (a.x / 100) * e.widthPercent;
        if (mode === 'right') x = target.L + target.W - b.W - (a.x / 100) * e.widthPercent;
        if (mode === 'top') y = target.T - (a.y / 100) * b.H;
        if (mode === 'vmiddle') y = target.T + (target.H - b.H) / 2 - (a.y / 100) * b.H;
        if (mode === 'bottom') y = target.T + target.H - b.H - (a.y / 100) * b.H;
        return { ...e, xPercent: r1(x), yPercent: r1(y) };
      }),
    }));
  };

  const distributeSelected = (axis: 'h' | 'v') => {
    if (selectedIds.length < 3) {
      setStatus('Distribute needs at least 3 selected elements.');
      return;
    }
    const items: { id: string; box: NonNullable<ReturnType<typeof measureBox>> }[] = [];
    for (const id of selectedIds) {
      const box = measureBox(id);
      if (!box) return;
      items.push({ id, box });
    }
    const sorted = [...items].sort((p, q) => (axis === 'h' ? p.box.L - q.box.L : p.box.T - q.box.T));
    const first = sorted[0].box;
    const last = sorted[sorted.length - 1].box;
    const spanStart = axis === 'h' ? first.L : first.T;
    const spanEnd = axis === 'h' ? last.L + last.W : last.T + last.H;
    const totalSize = sorted.reduce((sum, i) => sum + (axis === 'h' ? i.box.W : i.box.H), 0);
    const gap = (spanEnd - spanStart - totalSize) / (sorted.length - 1);
    const placement = new Map<string, { pos: number; size: number }>();
    let cursor = spanStart;
    for (const i of sorted) {
      const size = axis === 'h' ? i.box.W : i.box.H;
      placement.set(i.id, { pos: cursor, size });
      cursor += size + gap;
    }
    setScene((s) => ({
      ...s,
      elements: s.elements.map((e) => {
        const p = placement.get(e.id);
        if (!p) return e;
        const a = anchorTranslate(e.anchor);
        return axis === 'h'
          ? { ...e, xPercent: r1(p.pos - (a.x / 100) * e.widthPercent) }
          : { ...e, yPercent: r1(p.pos - (a.y / 100) * p.size) };
      }),
    }));
  };

  /* ---------------- pointer tools (editor only) ----------------
     The model stores anchor + percent offsets (constraint 1). Pointer
     deltas are converted to percentages of the stage before touching
     the model — raw px never gets stored. */
  const sv = (v: number) => (snap ? Math.round(v) : r1(v));

  const startMove = (ev: React.PointerEvent, ids: string[]) => {
    const stage = stageRef.current;
    if (!stage) return;
    beginGesture();
    const rect = stage.getBoundingClientRect();
    const startX = ev.clientX;
    const startY = ev.clientY;
    const starts = new Map<string, { x: number; y: number }>();
    for (const id of ids) {
      const e = sceneRef.current.elements.find((x) => x.id === id);
      if (e) starts.set(id, { x: e.xPercent, y: e.yPercent });
    }
    const onMove = (mv: PointerEvent) => {
      const dx = ((mv.clientX - startX) / rect.width) * 100;
      const dy = ((mv.clientY - startY) / rect.height) * 100;
      setScene((s) => ({
        ...s,
        elements: s.elements.map((e) => {
          const st = starts.get(e.id);
          if (!st) return e;
          return { ...e, xPercent: sv(clampPct(st.x + dx)), yPercent: sv(clampPct(st.y + dy)) };
        }),
      }));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      endGesture();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const onElementPointerDown = (ev: React.PointerEvent, el: SceneElement) => {
    ev.stopPropagation();
    if (el.locked) return; // locked: selectable only via the Layers list
    ev.preventDefault();
    if (ev.shiftKey) {
      // Shift+click toggles membership in the selection (no drag).
      setSelectedIds((ids) => (ids.includes(el.id) ? ids.filter((i) => i !== el.id) : [...ids, el.id]));
      return;
    }
    let ids = selectedIds;
    if (el.groupId) {
      const g = scene.elements.filter((e) => e.groupId === el.groupId).map((e) => e.id);
      if (ids.length !== g.length || !g.every((id) => ids.includes(id))) {
        ids = g;
        setSelectedIds(g);
      }
    } else if (!ids.includes(el.id)) {
      ids = [el.id];
      setSelectedIds([el.id]);
    }
    startMove(ev, ids);
  };

  const startResize = (ev: React.PointerEvent, el: SceneElement, handle: Handle) => {
    ev.preventDefault();
    ev.stopPropagation();
    const stage = stageRef.current;
    if (!stage) return;
    beginGesture();
    const rect = stage.getBoundingClientRect();
    const startX = ev.clientX;
    const startY = ev.clientY;
    const box = measureBox(el.id);
    const a = anchorTranslate(el.anchor);
    const W0 = el.widthPercent;
    const H0 = el.heightPercent ?? (box ? box.H : 20);
    const L0 = el.xPercent + (a.x / 100) * W0;
    const T0 = el.yPercent + (a.y / 100) * H0;
    const ratio = H0 / W0; // in % space — the stage size is fixed mid-drag
    const hadHeight = el.heightPercent != null;
    const east = handle.includes('e');
    const west = handle.includes('w');
    const south = handle.includes('s');
    const north = handle.includes('n');
    const onMove = (mv: PointerEvent) => {
      const dx = ((mv.clientX - startX) / rect.width) * 100;
      const dy = ((mv.clientY - startY) / rect.height) * 100;
      let W = W0;
      let H = H0;
      let L = L0;
      let T = T0;
      if (east) { W = W0 + dx; L = L0; }
      if (west) { W = W0 - dx; L = L0 + dx; }
      if (south) { H = H0 + dy; T = T0; }
      if (north) { H = H0 - dy; T = T0 + dy; }
      const Wc = Math.min(100, Math.max(5, W));
      if (west) L = L0 + W0 - Wc; // keep the east edge fixed
      W = Wc;
      const Hc = Math.min(100, Math.max(3, H));
      if (north) T = T0 + H0 - Hc; // keep the south edge fixed
      H = Hc;
      if (lockRatio) {
        if (east || west) {
          const Hn = Math.min(100, Math.max(3, W * ratio));
          if (north) T = T0 + H0 - Hn;
          else if (!south) T = T0 + (H0 - Hn) / 2;
          H = Hn;
        } else if (north || south) {
          const Wn = Math.min(100, Math.max(5, H / ratio));
          if (west) L = L0 + W0 - Wn;
          else if (!east) L = L0 + (W0 - Wn) / 2;
          W = Wn;
        }
      }
      const patch: Partial<SceneElement> = {
        widthPercent: sv(W),
        xPercent: sv(L - (a.x / 100) * W),
        yPercent: sv(T - (a.y / 100) * H),
      };
      // Dragging a vertical edge (or locking the ratio) gives the element
      // an explicit height; pure horizontal resizes leave auto height alone.
      if (south || north || lockRatio || hadHeight) patch.heightPercent = sv(H);
      updateElement(el.id, patch);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      endGesture();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const startRotate = (ev: React.PointerEvent, el: SceneElement) => {
    ev.preventDefault();
    ev.stopPropagation();
    const stage = stageRef.current;
    if (!stage) return;
    const node = stage.querySelector(`[data-elid="${esc(el.id)}"]`);
    if (!node) return;
    beginGesture();
    const r = (node as HTMLElement).getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const startAngle = (Math.atan2(ev.clientY - cy, ev.clientX - cx) * 180) / Math.PI;
    const ids = selectedIds.includes(el.id) ? selectedIds : [el.id];
    const starts = new Map<string, number>();
    for (const id of ids) {
      const e = sceneRef.current.elements.find((x) => x.id === id);
      if (e) starts.set(id, e.baseRotate || 0);
    }
    const onMove = (mv: PointerEvent) => {
      const ang = (Math.atan2(mv.clientY - cy, mv.clientX - cx) * 180) / Math.PI;
      let delta = ang - startAngle;
      if (mv.shiftKey) delta = Math.round(delta / 15) * 15; // shift = 15° steps
      setScene((s) => ({
        ...s,
        elements: s.elements.map((e) => {
          const st = starts.get(e.id);
          if (st === undefined) return e;
          let v = r1(st + delta);
          if (v > 180) v -= 360;
          if (v < -180) v += 360;
          return { ...e, baseRotate: v };
        }),
      }));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      endGesture();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  /* ---------------- keyboard shortcuts ---------------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      if (mod && key === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
      if (mod && key === 'y') { e.preventDefault(); redo(); return; }
      if (mod && key === 'd') { e.preventDefault(); duplicateSelected(); return; }
      if (mod && key === 'c') {
        if (window.getSelection()?.toString()) return; // let real text copy win
        copySelected();
        return;
      }
      if (mod && key === 'v') { pasteClipboard(); return; }
      if (e.key === 'Escape') { setSelectedIds([]); return; }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedIds.length > 0) {
        e.preventDefault();
        deleteSelected();
        return;
      }
      if (e.key.startsWith('Arrow') && selectedIds.length > 0) {
        e.preventDefault();
        const step = e.shiftKey ? 5 : 1;
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        setScene((s) => ({
          ...s,
          elements: s.elements.map((el) =>
            selectedIds.includes(el.id)
              ? { ...el, xPercent: clampPct(el.xPercent + dx), yPercent: clampPct(el.yPercent + dy) }
              : el
          ),
        }));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  /* ---------------- scroll keyframes ---------------- */
  const addKeyframe = () => {
    if (!primary) return;
    const offset = Math.round(scrollPct);
    const tracks = { ...(primary.tracks || {}) } as SceneElement['tracks'];
    for (const prop of TRACK_PROPS) {
      const list = (tracks[prop] || []).filter((k) => k.offset !== offset);
      list.push({ offset, value: Math.round(motionDraft[prop] * 1000) / 1000 });
      list.sort((a, b) => a.offset - b.offset);
      tracks[prop] = list;
    }
    updateElement(primary.id, { tracks });
    setStatus(`Keyframe added at scroll ${offset}% for “${primary.text.slice(0, 24)}”.`);
  };

  const deleteKeyframe = (offset: number) => {
    if (!primary) return;
    const tracks = { ...(primary.tracks || {}) } as SceneElement['tracks'];
    for (const prop of TRACK_PROPS) {
      tracks[prop] = (tracks[prop] || []).filter((k) => k.offset !== offset);
      if (tracks[prop]!.length === 0) delete tracks[prop];
    }
    updateElement(primary.id, { tracks });
  };

  /* ---------------- save / load ---------------- */
  const save = async () => {
    localStorage.setItem(LS_SCENE, JSON.stringify(scene));
    setStatus('Saved locally.');
    try {
      const res = await fetch(`${API}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: scene.name, scene }),
      });
      if (res.ok) setStatus('Saved locally + to server.');
      else setStatus(`Saved locally. Server save skipped (${res.status} — is Mongo running?).`);
    } catch {
      setStatus('Saved locally. Server not reachable (that is fine for the standalone demo).');
    }
  };

  const loadLocal = () => {
    try {
      const raw = localStorage.getItem(LS_SCENE);
      if (raw) {
        const migrated = migrateScene(JSON.parse(raw));
        if (migrated) {
          setScene(migrated);
          setStatus('Loaded from local storage.');
        } else setStatus('Local save was corrupted — keeping current scene.');
      } else setStatus('Nothing saved locally yet.');
    } catch { setStatus('Local save was corrupted — keeping current scene.'); }
  };

  /* ---------------- v0.3 import: source loading ---------------- */
  type BundleItem = { name: string; text?: string; dataUrl?: string };

  const buildBundle = async (items: BundleItem[], label: string) => {
    const names = items.map((i) => i.name);
    const byName = new Map(items.map((i) => [i.name, i]));
    let entryName = pickEntryFile(names);
    if (!entryName) {
      setImportNote('No entry page found — the upload needs an index.html / .html page or a main page component (.jsx/.tsx).');
      return;
    }
    let entryItem = byName.get(entryName);
    let format = detectFormat(entryItem?.text || '', entryName);
    // React shell case: index.html is just <div id="root"> + a module
    // script — the real markup lives in the page component. Prefer it.
    if (format === 'html') {
      const visibleText = (entryItem?.text || '').replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, '').trim();
      if (visibleText.length < 20 && /id\s*=\s*["']root["']/.test(entryItem?.text || '')) {
        const comp = items.find(
          (i) => /\.(jsx|tsx)$/i.test(i.name) && !/main\.(jsx|tsx)$/i.test(i.name) && typeof i.text === 'string'
        );
        if (comp) {
          entryName = comp.name;
          entryItem = comp;
          format = 'jsx';
        }
      }
    }
    if (!entryItem || typeof entryItem.text !== 'string') {
      setImportNote(`Could not read the entry file (${entryName}).`);
      return;
    }
    const assets: Record<string, string> = {};
    for (const i of items) if (i.dataUrl) assets[i.name] = i.dataUrl;
    const cssTexts = items
      .filter((i) => /\.css$/i.test(i.name) && typeof i.text === 'string')
      .map((i) => (i.text as string).slice(0, 120000));
    bundleRef.current = { label, entry: entryItem.text, format, assets, cssTexts };
    setImportText(entryItem.text);
    setImportSourceLabel(`${label} — entry: ${entryName}`);
    setImportNote(
      `Loaded ${label}: entry ${entryName}, ${cssTexts.length} stylesheet(s), ${Object.keys(assets).length} image(s). Now choose replace or add below.`
    );
  };

  const onImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    try {
      const text = await f.text();
      bundleRef.current = null;
      setImportText(text);
      setImportSourceLabel(`File: ${f.name}`);
      setImportNote(`Loaded ${f.name}. Now choose replace or add below.`);
    } catch {
      setImportNote('Could not read that file.');
    }
  };

  const onImportZip = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    setImportNote('Reading zip…');
    try {
      const raw = await readZipEntries(new Uint8Array(await f.arrayBuffer()));
      const decoder = new TextDecoder();
      const items: BundleItem[] = [];
      for (const entry of raw) {
        if (entry.data.length > 4_000_000) continue;
        const ext = entry.name.toLowerCase().split('.').pop() || '';
        if (['html', 'htm', 'css', 'jsx', 'tsx'].includes(ext)) {
          items.push({ name: entry.name, text: decoder.decode(entry.data) });
        } else if (IMAGE_MIME[ext]) {
          items.push({ name: entry.name, dataUrl: `data:${IMAGE_MIME[ext]};base64,${bytesToBase64(entry.data)}` });
        }
      }
      await buildBundle(items, `Zip: ${f.name}`);
    } catch (err) {
      setImportNote(err instanceof Error ? err.message : 'Could not read that zip file.');
    }
  };

  const onImportFolder = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (files.length === 0) return;
    setImportNote('Reading folder…');
    try {
      const items: BundleItem[] = [];
      for (const f of files) {
        if (f.size > 4_000_000) continue;
        const rel = f.webkitRelativePath ? f.webkitRelativePath.split('/').slice(1).join('/') || f.name : f.name;
        const ext = f.name.toLowerCase().split('.').pop() || '';
        if (['html', 'htm', 'css', 'jsx', 'tsx'].includes(ext)) {
          items.push({ name: rel, text: await f.text() });
        } else if (IMAGE_MIME[ext]) {
          items.push({ name: rel, dataUrl: await fileToDataUrl(f) });
        }
      }
      await buildBundle(items, 'Folder upload');
    } catch {
      setImportNote('Could not read that folder.');
    }
  };

  /* ---------------- v0.3 import: convert + apply ----------------
     One setScene call per import => exactly one undo snapshot, so a
     single Ctrl+Z reverts the whole import (history effect above). */
  const runImport = async (mode: 'replace' | 'append') => {
    if (importBusy) return;
    const bundle = bundleRef.current;
    let markup = '';
    let format: 'html' | 'jsx' = 'html';
    let assets: Record<string, string> = {};
    let cssTexts: string[] = [];
    let label = 'pasted code';
    if (bundle) {
      markup = bundle.entry;
      format = bundle.format;
      assets = bundle.assets;
      cssTexts = bundle.cssTexts;
      label = bundle.label;
    } else {
      markup = importText;
      format = detectFormat(markup);
    }
    if (!markup.trim()) {
      setImportNote('Paste some HTML/JSX code, or upload a file, folder or zip first.');
      return;
    }
    setImportBusy(true);
    setImportNote('Converting… the page is rendered off-screen for a moment so it can be measured.');
    const iframe = document.createElement('iframe');
    try {
      const htmlMarkup = format === 'jsx' ? jsxToHtml(markup) : markup;
      const useTailwind = hasTailwindClasses(htmlMarkup);
      const docHtml = buildImportDocument(htmlMarkup, cssTexts, useTailwind);

      iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
      iframe.style.cssText = `position:absolute;left:-10000px;top:0;width:${IMPORT_RENDER_WIDTH}px;height:600px;border:0;visibility:hidden;`;
      const loaded = new Promise<void>((resolve) => {
        iframe.onload = () => resolve();
        window.setTimeout(resolve, 6000);
      });
      iframe.srcdoc = docHtml;
      document.body.appendChild(iframe);
      await loaded;
      const win = iframe.contentWindow;
      const idoc = iframe.contentDocument;
      if (!win || !idoc || !idoc.body) throw new Error('the sandboxed render was blocked');

      // Folder/zip images: swap relative <img src> for uploaded data URLs
      // BEFORE measuring, so image boxes use the real pictures.
      if (Object.keys(assets).length > 0) {
        idoc.querySelectorAll('img').forEach((img) => {
          const raw = img.getAttribute('src') || '';
          const resolved = resolveAssetSrc(raw, assets);
          if (resolved && resolved !== raw) img.setAttribute('src', resolved);
        });
      }

      // Tailwind Play CDN: give it a bounded moment to generate utilities,
      // then continue regardless (offline => inline/computed styles only).
      if (useTailwind) {
        const t0 = Date.now();
        while (Date.now() - t0 < 1800) {
          if ((win as any).tailwind) break;
          await new Promise((r) => setTimeout(r, 120));
        }
        await new Promise((r) => setTimeout(r, 350));
      }

      // Let images settle (bounded) so their boxes are final.
      const imgs = Array.from(idoc.images || []);
      await Promise.race([
        Promise.all(
          imgs.map((im) =>
            im.complete
              ? Promise.resolve()
              : new Promise<void>((res) => {
                  im.onload = () => res();
                  im.onerror = () => res();
                })
          )
        ),
        new Promise((r) => setTimeout(r, 1500)),
      ]);

      // Grow the iframe to the full page height so element rects map to
      // % of the whole page (the stage then represents the full page).
      const fullH = Math.max(idoc.documentElement.scrollHeight || 0, idoc.body?.scrollHeight || 0);
      if (fullH > 0) iframe.style.height = `${fullH}px`;
      await new Promise((r) => requestAnimationFrame(() => r(null)));

      const { candidates, skipped: domSkipped, pageWidth, pageHeight } = extractCandidatesFromDoc(idoc, win);
      const fontScale = (stageRef.current?.clientWidth || IMPORT_RENDER_WIDTH) / IMPORT_RENDER_WIDTH;
      const { specs, skipped: mapSkipped, truncated } = candidatesToSpecs(candidates, {
        width: pageWidth,
        height: pageHeight,
        fontScale,
      });
      const els = specs.map((sp) => createElement(sp.type, sp.fields));
      const skipped = domSkipped + mapSkipped;
      if (els.length === 0) {
        setImportNote(
          'Nothing could be converted. Import works best on markup-based landing pages — pages built almost entirely from scripts, canvas or SVG have nothing to measure.'
        );
        return;
      }
      if (mode === 'replace') setScene((s) => ({ ...s, elements: els }));
      else setScene((s) => ({ ...s, elements: [...s.elements, ...els] }));
      setSelectedIds(els.map((el) => el.id));
      setShowImport(false);
      setStatus(
        `Imported ${els.length} element(s) from ${label}${mode === 'append' ? ' (added to the current page)' : ''}.` +
          (skipped > 0 ? ` ${skipped} item(s) couldn't be converted and were skipped.` : '') +
          (truncated ? ` Stopped at the ${IMPORT_CAP}-element import cap — the page was large.` : '') +
          ' One Ctrl+Z undoes the whole import.'
      );
    } catch (err) {
      setImportNote(
        `Import failed (${err instanceof Error ? err.message : 'unknown error'}). Your current page was not changed.`
      );
    } finally {
      iframe.remove();
      setImportBusy(false);
    }
  };

  /* ---------------- AI generation ---------------- */
  const generate = async () => {
    const prompt = aiPrompt.trim();
    if (!prompt) return;
    setStatus('Asking AI…');
    let inserted = 0;
    try {
      const res = await fetch(`${API}/api/ai/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
      });
      if (!res.ok) throw new Error(`server ${res.status}`);
      const data = await res.json();
      const els = normaliseElements(data.elements);
      if (els.length === 0) throw new Error('empty AI result');
      els.forEach((el) => addElement(el));
      inserted = els.length;
      setStatus(`AI (Grok via server) added ${inserted} element(s).`);
    } catch {
      // Local fallback generator — keeps the feature working standalone
      // (server down, or server returned 501 because no Grok key is set).
      const els = localGenerate(prompt);
      els.forEach((el) => addElement(el));
      setStatus(`Server AI unavailable — local fallback added ${els.length} element(s).`);
    }
    setAiPrompt('');
  };

  const copyCode = async () => {
    try { await navigator.clipboard.writeText(codeTab === 'jsx' ? pageJsx : animCss); setStatus('Code copied.'); } catch { /* clipboard unavailable */ }
  };

  /* ---------------- render helpers ---------------- */
  const renderElement = (el: SceneElement) => {
    const hasTracks = collectOffsets(el).length > 0;
    // Editor preview uses the SAME merged sampling as the exporter
    // (sampleElementAt: tracks + baseRotate + flip), so they cannot drift.
    const m = hasTracks ? sampleElementAt(el, scrollPct) : null;
    const rot = m ? m.rotate : el.baseRotate || 0;
    const sx = m ? m.scaleX : el.flipH ? -1 : 1;
    const sy = m ? m.scaleY : el.flipV ? -1 : 1;
    const op = m ? m.opacity : el.opacity;
    const a = anchorTranslate(el.anchor);
    const isSel = selectedIds.includes(el.id);
    const isPrimary = primary?.id === el.id;

    const wrapperStyle: React.CSSProperties = {
      position: 'absolute',
      left: `${el.xPercent}%`,
      top: `${el.yPercent}%`,
      width: `${el.widthPercent}%`,
      height: el.heightPercent != null ? `${el.heightPercent}%` : undefined,
      minHeight: el.type === 'card' && el.heightPercent == null ? '18%' : undefined,
      aspectRatio: el.type === 'image' && el.heightPercent == null ? '4 / 3' : undefined,
      transform: `translate(${a.x}%, ${a.y}%) translate(${m ? m.translateX : 0}px, ${m ? m.translateY : 0}px) rotate(${rot}deg) scale(${sx}, ${sy})`,
      opacity: op,
      cursor: el.locked ? 'default' : 'grab',
      userSelect: 'none',
      pointerEvents: el.locked ? 'none' : 'auto',
      boxSizing: 'border-box',
    };

    const innerStyle: React.CSSProperties = {
      width: '100%',
      height: '100%',
      margin: 0,
      boxSizing: 'border-box',
      color: el.color,
      backgroundColor: el.type === 'card' || el.type === 'button' || el.type === 'image' ? el.bg : 'transparent',
      fontSize: el.fontSize,
      fontFamily: el.fontFamily !== 'inherit' ? el.fontFamily : undefined,
      fontWeight: el.bold ? 700 : 400,
      fontStyle: el.italic ? 'italic' : undefined,
      textDecoration: el.underline ? 'underline' : undefined,
      textAlign: el.textAlign,
      lineHeight: el.lineHeight,
      letterSpacing: el.letterSpacing || undefined,
      borderRadius: el.radius,
      border: el.borderWidth > 0 ? `${el.borderWidth}px solid ${el.borderColor}` : undefined,
      boxShadow: el.shadow !== 'none' ? SHADOWS[el.shadow] : undefined,
      padding: el.type === 'card' ? 20 : el.type === 'button' ? '10px 20px' : 0,
      overflow: el.heightPercent != null ? 'hidden' : undefined,
    };

    let inner: React.ReactNode;
    if (el.type === 'image') {
      // Same crop rendering as the export: overflow-hidden frame, img with
      // object-fit: cover + object-position + inner zoom.
      inner = (
        <figure style={{ ...innerStyle, overflow: 'hidden' }}>
          <img
            src={el.imageSrc || placeholderImageSrc(el)}
            alt={el.text}
            draggable={false}
            style={{
              width: '100%',
              height: '100%',
              display: 'block',
              objectFit: 'cover',
              objectPosition: `${el.cropX}% ${el.cropY}%`,
              transform: `scale(${el.cropZoom})`,
            }}
          />
        </figure>
      );
    } else {
      const Tag = (el.type === 'heading' ? 'h2' : el.type === 'text' ? 'p' : el.type === 'button' ? 'button' : 'article') as any;
      inner = <Tag style={innerStyle}>{el.text}</Tag>;
    }

    return (
      <div key={el.id} data-elid={el.id} style={wrapperStyle} onPointerDown={(e) => onElementPointerDown(e, el)}>
        {inner}
        {isSel && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              border: `2px solid ${el.locked ? '#8b8b9e' : '#7c3aed'}`,
              borderRadius: 2,
              pointerEvents: 'none',
              zIndex: 5,
            }}
          >
            {isPrimary && !el.locked && (
              <>
                <div
                  style={{ position: 'absolute', left: '50%', top: -16, width: 2, height: 14, marginLeft: -1, background: '#7c3aed' }}
                />
                <div
                  title="Drag to rotate (Shift = 15° steps)"
                  onPointerDown={(e) => startRotate(e, el)}
                  style={{
                    position: 'absolute', left: '50%', top: -32, marginLeft: -8,
                    width: 16, height: 16, borderRadius: '50%',
                    background: '#7c3aed', border: '2px solid #fff',
                    pointerEvents: 'auto', cursor: 'grab', zIndex: 6, boxSizing: 'border-box',
                  }}
                />
                {HANDLES.map((h) => (
                  <div
                    key={h}
                    onPointerDown={(e) => startResize(e, el, h)}
                    style={{
                      position: 'absolute', width: 12, height: 12, borderRadius: 3,
                      background: '#fff', border: '2px solid #7c3aed',
                      pointerEvents: 'auto', zIndex: 6, boxSizing: 'border-box',
                      ...HANDLE_STYLE[h],
                    }}
                  />
                ))}
              </>
            )}
          </div>
        )}
      </div>
    );
  };

  const motionField = (label: string, prop: TrackProp, min: number, max: number, step: number) => (
    <div key={prop}>
      <label className="lbl">{label}: {motionDraft[prop]}</label>
      <input type="range" min={min} max={max} step={step} value={motionDraft[prop]}
        onChange={(e) => setMotionDraft((d) => ({ ...d, [prop]: Number(e.target.value) }))}
        className="w-full accent-violet-600" />
    </div>
  );

  const toggleBtn = (active: boolean): React.CSSProperties => ({
    background: active ? '#7c3aed' : undefined,
    color: active ? '#fff' : undefined,
    fontWeight: active ? 700 : undefined,
  });

  return (
    <div className="flex flex-col h-full">
      {/* ---------- top bar ---------- */}
      <header className="panel flex items-center gap-3 px-4 py-2 border-b flex-wrap">
        <div className="font-bold text-lg" style={{ color: '#a78bfa' }}>Scenetics</div>
        <span className="muted text-xs">v0.3</span>
        <span className="muted text-xs hidden md:inline">Scenes that move — drag, scroll-animate, export real code.</span>
        <div className="flex-1" />
        <button className="btn" onClick={undo} disabled={past.length === 0} title="Ctrl/Cmd+Z">↩ Undo</button>
        <button className="btn" onClick={redo} disabled={future.length === 0} title="Ctrl/Cmd+Shift+Z">↪ Redo</button>
        <label className="lbl" style={{ margin: 0 }}>Scene scroll length (vh)</label>
        <input type="number" min={100} max={1000} step={50} value={scene.scrollLengthVh}
          onChange={(e) => setScene((s) => ({ ...s, scrollLengthVh: Number(e.target.value) || 300 }))}
          className="input" style={{ width: 90 }} />
        <button className="btn" onClick={save}>Save</button>
        <button className="btn" onClick={loadLocal}>Load</button>
        <button className="btn btn-accent" onClick={() => setShowImport(true)} title="Import an existing landing page (HTML / JSX / folder / zip) as editable elements">⇩ Import</button>
        <a className="btn" href={`${API}/auth/google`} title="Google sign-in (server OAuth — skeleton in MVP)">Login with Google</a>
        <button className="btn" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
          {theme === 'dark' ? '☀ Light' : '🌙 Dark'}
        </button>
      </header>

      <div className="flex flex-1 min-h-0">
        {/* ---------- left panel ---------- */}
        <aside className="panel border-r p-3 overflow-y-auto" style={{ width: 230 }}>
          <div className="font-semibold text-sm mb-2">Components</div>
          <div className="grid grid-cols-2 gap-2">
            {PALETTE.map((p) => (
              <button key={p.type} className="btn" onClick={() => addFromPalette(p.type)}>+ {p.label}</button>
            ))}
          </div>

          <div className="font-semibold text-sm mt-5 mb-2">Frames</div>
          <div className="flex flex-col gap-2">
            {FRAMES.map((f) => (
              <button key={f.name} className="btn text-left" onClick={() => addFrame(f.build)}>
                <div className="font-semibold">{f.name}</div>
                <div className="muted" style={{ fontSize: 11 }}>{f.description}</div>
              </button>
            ))}
          </div>

          <div className="font-semibold text-sm mt-5 mb-2">AI — describe a component</div>
          <textarea className="input" rows={3} value={aiPrompt} onChange={(e) => setAiPrompt(e.target.value)}
            placeholder="e.g. a pricing card, a hero section…" />
          <button className="btn btn-accent w-full mt-2" onClick={generate}>Generate with AI</button>
          <p className="muted" style={{ fontSize: 11 }}>
            Uses Grok via the server. If the server or API key is unavailable, a local fallback generator runs instead.
          </p>
          {status && <p style={{ fontSize: 11, color: '#a78bfa' }}>{status}</p>}
        </aside>

        {/* ---------- centre: canvas + scrub ---------- */}
        <main className="flex-1 flex flex-col min-w-0">
          <div className="panel border-b px-4 py-2 flex items-center gap-3 flex-wrap">
            <label className="lbl" style={{ margin: 0, whiteSpace: 'nowrap' }}>↕ Scroll scrub — {Math.round(scrollPct)}%</label>
            <input type="range" min={0} max={100} step={0.5} value={scrollPct}
              onChange={(e) => setScrollPct(Number(e.target.value))}
              className="flex-1 accent-violet-600" style={{ minWidth: 120 }} />
            <div className="flex items-center gap-1">
              <button className="btn" title="Zoom out" onClick={() => setZoom((z) => Math.max(0.5, r1(z - 0.1)))}>−</button>
              <span className="muted text-xs" style={{ width: 42, textAlign: 'center' }}>{Math.round(zoom * 100)}%</span>
              <button className="btn" title="Zoom in" onClick={() => setZoom((z) => Math.min(1.5, r1(z + 0.1)))}>+</button>
            </div>
            <label className="muted text-xs flex items-center gap-1" title="Snap drag/resize to whole % values">
              <input type="checkbox" checked={snap} onChange={(e) => setSnap(e.target.checked)} className="accent-violet-600" /> Snap
            </label>
            <label className="muted text-xs flex items-center gap-1" title="Keep the width/height ratio while resizing">
              <input type="checkbox" checked={lockRatio} onChange={(e) => setLockRatio(e.target.checked)} className="accent-violet-600" /> Lock ratio
            </label>
            <span className="muted text-xs hidden xl:inline">Preview only — exports use native CSS scroll timelines.</span>
          </div>
          <div className="flex-1 p-4 overflow-auto" style={{ background: 'var(--bg)' }}>
            <div style={{ width: `${zoom * 100}%`, height: `${zoom * 100}%`, minWidth: 320, minHeight: 420 }}>
              <div ref={stageRef} onPointerDown={() => setSelectedIds([])}
                style={{ position: 'relative', width: '100%', height: '100%', background: 'var(--stage-bg)', borderRadius: 12, overflow: 'hidden' }}>
                {scene.elements.map(renderElement)}
                {scene.elements.length === 0 && (
                  <p className="muted" style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    Add a component or a frame to start.
                  </p>
                )}
              </div>
            </div>
          </div>

          {/* ---------- live code panel ---------- */}
          <section className="panel border-t" style={{ height: 250, display: 'flex', flexDirection: 'column' }}>
            <div className="flex items-center gap-2 px-3 py-1.5 border-b panel">
              <button className="btn" style={codeTab === 'jsx' ? { borderColor: '#7c3aed' } : {}} onClick={() => setCodeTab('jsx')}>Page.jsx</button>
              <button className="btn" style={codeTab === 'css' ? { borderColor: '#7c3aed' } : {}} onClick={() => setCodeTab('css')}>animations.css</button>
              <span className="muted text-xs">Live — updates on every change. No LLM: deterministic code generation.</span>
              <div className="flex-1" />
              <button className="btn" onClick={copyCode}>Copy</button>
            </div>
            <pre className="code flex-1 overflow-auto px-3 py-2 m-0">{codeTab === 'jsx' ? pageJsx : animCss}</pre>
          </section>
        </main>

        {/* ---------- right panel: layers + properties ---------- */}
        <aside className="panel border-l p-3 overflow-y-auto" style={{ width: 280 }}>
          <div className="font-semibold text-sm mb-2">Layers <span className="muted" style={{ fontSize: 11 }}>(top = front)</span></div>
          <div className="flex flex-col gap-1 mb-3" style={{ maxHeight: 190, overflowY: 'auto' }}>
            {[...scene.elements].reverse().map((el) => (
              <div key={el.id} className="flex items-center gap-1 panel-2" style={{ borderRadius: 6, padding: '3px 6px', fontSize: 11, border: selectedIds.includes(el.id) ? '1px solid #7c3aed' : '1px solid transparent' }}>
                <button
                  style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', padding: 0 }}
                  title={`${el.type}: ${el.text}`}
                  onClick={(ev) => {
                    if (ev.shiftKey) setSelectedIds((ids) => (ids.includes(el.id) ? ids.filter((i) => i !== el.id) : [...ids, el.id]));
                    else if (el.groupId) setSelectedIds(scene.elements.filter((e) => e.groupId === el.groupId).map((e) => e.id));
                    else setSelectedIds([el.id]);
                  }}
                >
                  <span className="capitalize">{el.type}</span> · {el.text.slice(0, 18)}
                  {el.groupId ? ' ⛓' : ''}
                </button>
                <button className="btn" style={{ padding: '1px 6px' }} title={el.locked ? 'Unlock' : 'Lock (locked elements can only be selected here)'}
                  onClick={() => updateElement(el.id, { locked: !el.locked })}>
                  {el.locked ? '🔒' : '🔓'}
                </button>
              </div>
            ))}
            {scene.elements.length === 0 && <div className="muted" style={{ fontSize: 11 }}>No elements yet.</div>}
          </div>
          <p className="muted" style={{ fontSize: 11, marginTop: 0 }}>
            Shift+click selects multiple. Shortcuts: Ctrl/⌘+D duplicate, C/V copy/paste, Z undo, arrows nudge (Shift = 5%).
          </p>

          <hr style={{ borderColor: 'var(--border)', width: '100%' }} />

          {!primary ? (
            <p className="muted text-sm">Select an element on the canvas (or in Layers) to edit it, resize/rotate it, and add scroll keyframes.</p>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <div className="font-semibold text-sm capitalize">
                  {primary.type}
                  {selectedIds.length > 1 && <span className="muted" style={{ fontSize: 11 }}> · {selectedIds.length} selected</span>}
                </div>
                <div className="flex gap-1">
                  <button className="btn" onClick={duplicateSelected} title="Ctrl/Cmd+D">Duplicate</button>
                  <button className="btn" onClick={deleteSelected} title="Delete key">Delete</button>
                </div>
              </div>
              {selectedIds.length > 1 && (
                <p className="muted" style={{ fontSize: 11, margin: 0 }}>
                  Panel below edits “{primary.text.slice(0, 20)}”. Duplicate / delete / flip / align / arrow-keys apply to all {selectedIds.length} selected.
                </p>
              )}

              <div>
                <label className="lbl">Text{primary.type === 'image' ? ' (alt / label)' : ''}</label>
                <textarea className="input" rows={2} value={primary.text} onChange={(e) => updateElement(primary.id, { text: e.target.value })} />
              </div>

              {primary.type !== 'image' && (
                <div>
                  <label className="lbl">Font</label>
                  <div className="flex gap-1 mb-1">
                    <select className="input" style={{ flex: 1 }} value={primary.fontFamily}
                      onChange={(e) => updateElement(primary.id, { fontFamily: e.target.value })}>
                      {FONTS.map((f) => (<option key={f} value={f}>{f === 'inherit' ? 'Default font' : f}</option>))}
                    </select>
                    <button className="btn" style={toggleBtn(primary.bold)} title="Bold" onClick={() => updateElement(primary.id, { bold: !primary.bold })}>B</button>
                    <button className="btn" style={{ ...toggleBtn(primary.italic), fontStyle: 'italic' }} title="Italic" onClick={() => updateElement(primary.id, { italic: !primary.italic })}>I</button>
                    <button className="btn" style={{ ...toggleBtn(primary.underline), textDecoration: 'underline' }} title="Underline" onClick={() => updateElement(primary.id, { underline: !primary.underline })}>U</button>
                  </div>
                  <div className="flex gap-1 mb-1">
                    {(['left', 'center', 'right'] as const).map((al) => (
                      <button key={al} className="btn" style={{ flex: 1, ...toggleBtn(primary.textAlign === al) }}
                        onClick={() => updateElement(primary.id, { textAlign: al })}>
                        {al === 'left' ? '⬅' : al === 'center' ? '⬌' : '➡'}
                      </button>
                    ))}
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="lbl">Line height</label>
                      <input type="number" min={0.8} max={3} step={0.05} value={primary.lineHeight} className="input"
                        onChange={(e) => updateElement(primary.id, { lineHeight: Number(e.target.value) || 1.4 })} />
                    </div>
                    <div>
                      <label className="lbl">Letter spacing (px)</label>
                      <input type="number" min={-2} max={20} step={0.5} value={primary.letterSpacing} className="input"
                        onChange={(e) => updateElement(primary.id, { letterSpacing: Number(e.target.value) || 0 })} />
                    </div>
                  </div>
                </div>
              )}

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="lbl">Text colour</label>
                  <input type="color" value={primary.color} onChange={(e) => updateElement(primary.id, { color: e.target.value })} className="w-full" />
                </div>
                <div>
                  <label className="lbl">Background</label>
                  <input type="color" value={primary.bg} onChange={(e) => updateElement(primary.id, { bg: e.target.value })} className="w-full" />
                </div>
                <div>
                  <label className="lbl">Font size (px)</label>
                  <input type="number" min={8} max={96} value={primary.fontSize} onChange={(e) => updateElement(primary.id, { fontSize: Number(e.target.value) || 16 })} className="input" />
                </div>
                <div>
                  <label className="lbl">Corner radius</label>
                  <input type="number" min={0} max={999} value={primary.radius} onChange={(e) => updateElement(primary.id, { radius: Number(e.target.value) || 0 })} className="input" />
                </div>
              </div>

              <div>
                <label className="lbl">Size & position (% of stage)</label>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="lbl">Width %</label>
                    <input type="number" min={5} max={100} value={primary.widthPercent} className="input"
                      onChange={(e) => updateElement(primary.id, { widthPercent: Math.min(100, Math.max(5, Number(e.target.value) || 30)) })} />
                  </div>
                  <div>
                    <label className="lbl">Height %</label>
                    <input type="number" min={3} max={100} value={primary.heightPercent ?? ''} placeholder="Auto" className="input"
                      onChange={(e) => updateElement(primary.id, { heightPercent: e.target.value === '' ? null : Math.min(100, Math.max(3, Number(e.target.value) || 30)) })} />
                  </div>
                  <div>
                    <label className="lbl">X %</label>
                    <input type="number" min={0} max={100} step={0.5} value={primary.xPercent} className="input"
                      onChange={(e) => updateElement(primary.id, { xPercent: clampPct(Number(e.target.value) || 0) })} />
                  </div>
                  <div>
                    <label className="lbl">Y %</label>
                    <input type="number" min={0} max={100} step={0.5} value={primary.yPercent} className="input"
                      onChange={(e) => updateElement(primary.id, { yPercent: clampPct(Number(e.target.value) || 0) })} />
                  </div>
                </div>
                <label className="muted text-xs flex items-center gap-1 mt-1">
                  <input type="checkbox" className="accent-violet-600"
                    checked={primary.heightPercent == null}
                    onChange={(e) => updateElement(primary.id, { heightPercent: e.target.checked ? null : (measureBox(primary.id)?.H ? r1(measureBox(primary.id)!.H) : 30) })} />
                  Auto height{primary.type === 'image' ? ' (keeps 4/3 frame)' : ''}
                </label>
                <input type="range" min={5} max={95} step={1} value={primary.widthPercent}
                  onChange={(e) => updateElement(primary.id, { widthPercent: Number(e.target.value) })} className="w-full accent-violet-600 mt-1" />
                <p className="muted" style={{ fontSize: 11, margin: 0 }}>Tip: drag the corner handles on the canvas to resize.</p>
              </div>

              <div>
                <label className="lbl">Anchor — which point of the element sits at its position (exported as % offsets, never px)</label>
                <div className="grid grid-cols-3 gap-1" style={{ width: 96 }}>
                  {ANCHORS.map((a) => (
                    <button key={a} title={a} className="btn" style={{ height: 26, padding: 0, background: primary.anchor === a ? '#7c3aed' : undefined, color: primary.anchor === a ? '#fff' : undefined }}
                      onClick={() => updateElement(primary.id, { anchor: a })}>•</button>
                  ))}
                </div>
                <div className="muted" style={{ fontSize: 11 }}>
                  {primary.anchor} · x {primary.xPercent}% · y {primary.yPercent}%
                </div>
              </div>

              <div>
                <label className="lbl">Arrange</label>
                <div className="flex gap-1 flex-wrap mb-1">
                  <button className="btn" onClick={() => updateElements(selectedIds, { flipH: !primary.flipH })} style={toggleBtn(primary.flipH)} title="Flip horizontal">⇋ Flip H</button>
                  <button className="btn" onClick={() => updateElements(selectedIds, { flipV: !primary.flipV })} style={toggleBtn(primary.flipV)} title="Flip vertical">⇅ Flip V</button>
                  <button className="btn" onClick={() => updateElement(primary.id, { locked: !primary.locked })} style={toggleBtn(primary.locked)} title="Lock element">
                    {primary.locked ? '🔒 Locked' : '🔓 Lock'}
                  </button>
                </div>
                <div className="flex items-center gap-2 mb-1">
                  <label className="lbl" style={{ margin: 0 }}>Rotate (deg)</label>
                  <input type="number" min={-180} max={180} step={1} value={primary.baseRotate} className="input" style={{ width: 80 }}
                    onChange={(e) => updateElement(primary.id, { baseRotate: Math.max(-180, Math.min(180, Number(e.target.value) || 0)) })} />
                  <span className="muted" style={{ fontSize: 11 }}>merges into rotate keyframes</span>
                </div>
                <div className="flex gap-1 flex-wrap mb-1">
                  <button className="btn" onClick={() => reorder(primary.id, 'front')} title="Bring to front">⤒ Front</button>
                  <button className="btn" onClick={() => reorder(primary.id, 'forward')} title="Bring forward">↑ Fwd</button>
                  <button className="btn" onClick={() => reorder(primary.id, 'backward')} title="Send backward">↓ Back</button>
                  <button className="btn" onClick={() => reorder(primary.id, 'back')} title="Send to back">⤓ Back</button>
                </div>
                <div className="flex gap-1 flex-wrap">
                  <button className="btn" onClick={groupSelected} disabled={selectedIds.length < 2} title="Group selected elements">Group</button>
                  <button className="btn" onClick={ungroupPrimary} disabled={!primary.groupId} title="Ungroup">Ungroup</button>
                  {primary.groupId && <span className="muted" style={{ fontSize: 11, alignSelf: 'center' }}>in a group ⛓</span>}
                </div>
              </div>

              <div>
                <label className="lbl">Align{selectedIds.length > 1 ? ' (to each other)' : ' (to stage)'}</label>
                <div className="flex gap-1 flex-wrap mb-1">
                  <button className="btn" onClick={() => alignSelected('left')}>Left</button>
                  <button className="btn" onClick={() => alignSelected('hcenter')}>Center H</button>
                  <button className="btn" onClick={() => alignSelected('right')}>Right</button>
                  <button className="btn" onClick={() => alignSelected('top')}>Top</button>
                  <button className="btn" onClick={() => alignSelected('vmiddle')}>Middle V</button>
                  <button className="btn" onClick={() => alignSelected('bottom')}>Bottom</button>
                </div>
                <div className="flex gap-1 flex-wrap">
                  <button className="btn" onClick={() => distributeSelected('h')} disabled={selectedIds.length < 3}>Distribute H</button>
                  <button className="btn" onClick={() => distributeSelected('v')} disabled={selectedIds.length < 3}>Distribute V</button>
                </div>
              </div>

              <div>
                <label className="lbl">Style</label>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="lbl">Border width (px)</label>
                    <input type="number" min={0} max={20} value={primary.borderWidth} className="input"
                      onChange={(e) => updateElement(primary.id, { borderWidth: Math.max(0, Number(e.target.value) || 0) })} />
                  </div>
                  <div>
                    <label className="lbl">Border colour</label>
                    <input type="color" value={primary.borderColor} className="w-full"
                      onChange={(e) => updateElement(primary.id, { borderColor: e.target.value })} />
                  </div>
                </div>
                <label className="lbl" style={{ marginTop: 6 }}>Shadow</label>
                <div className="flex gap-1">
                  {(['none', 'sm', 'md', 'lg'] as const).map((sh) => (
                    <button key={sh} className="btn" style={{ flex: 1, ...toggleBtn(primary.shadow === sh) }}
                      onClick={() => updateElement(primary.id, { shadow: sh })}>{sh}</button>
                  ))}
                </div>
                <label className="lbl" style={{ marginTop: 6 }}>Base opacity: {primary.opacity}</label>
                <input type="range" min={0} max={1} step={0.05} value={primary.opacity}
                  onChange={(e) => updateElement(primary.id, { opacity: Number(e.target.value) })} className="w-full accent-violet-600" />
              </div>

              {primary.type === 'image' && (
                <div>
                  <label className="lbl">Crop — image inside its frame</label>
                  <div>
                    <label className="lbl">Image URL (blank = placeholder)</label>
                    <input className="input" value={primary.imageSrc} placeholder="https://…"
                      onChange={(e) => updateElement(primary.id, { imageSrc: e.target.value })} />
                  </div>
                  <div>
                    <label className="lbl">Position X: {primary.cropX}%</label>
                    <input type="range" min={0} max={100} step={1} value={primary.cropX}
                      onChange={(e) => updateElement(primary.id, { cropX: Number(e.target.value) })} className="w-full accent-violet-600" />
                  </div>
                  <div>
                    <label className="lbl">Position Y: {primary.cropY}%</label>
                    <input type="range" min={0} max={100} step={1} value={primary.cropY}
                      onChange={(e) => updateElement(primary.id, { cropY: Number(e.target.value) })} className="w-full accent-violet-600" />
                  </div>
                  <div>
                    <label className="lbl">Zoom inside frame: {primary.cropZoom}×</label>
                    <input type="range" min={1} max={3} step={0.05} value={primary.cropZoom}
                      onChange={(e) => updateElement(primary.id, { cropZoom: Number(e.target.value) })} className="w-full accent-violet-600" />
                  </div>
                  <p className="muted" style={{ fontSize: 11, margin: 0 }}>
                    Crop works by framing: resize the frame (handles / height) and slide the image inside it. Exports as object-fit: cover + object-position — identical to this preview.
                  </p>
                </div>
              )}

              <hr style={{ borderColor: 'var(--border)', width: '100%' }} />
              <div className="font-semibold text-sm">Motion at scroll {Math.round(scrollPct)}%</div>
              <p className="muted" style={{ fontSize: 11, margin: 0 }}>
                Set the look at this scroll position, then add a keyframe. Scrub to another %, change it, add another — the element moves as the user scrolls. (Rotate here is the keyframe track; the static Rotate in Arrange is added on top in the export.)
              </p>
              {motionField('Move X (px)', 'translateX', -400, 400, 1)}
              {motionField('Move Y (px)', 'translateY', -400, 400, 1)}
              {motionField('Scale', 'scale', 0, 3, 0.05)}
              {motionField('Rotate (deg)', 'rotate', -180, 180, 1)}
              {motionField('Opacity', 'opacity', 0, 1, 0.05)}
              <button className="btn btn-accent" onClick={addKeyframe}>◆ Add keyframe at {Math.round(scrollPct)}%</button>

              <div>
                <label className="lbl">Keyframes</label>
                {collectOffsets(primary).length === 0 && <div className="muted" style={{ fontSize: 11 }}>None yet.</div>}
                <div className="flex flex-col gap-1">
                  {collectOffsets(primary).map((off) => (
                    <div key={off} className="flex items-center justify-between panel-2" style={{ borderRadius: 6, padding: '3px 8px', fontSize: 11 }}>
                      <button style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer' }} onClick={() => setScrollPct(off)}>◆ scroll {off}%</button>
                      <button className="btn" style={{ padding: '1px 7px' }} onClick={() => deleteKeyframe(off)}>✕</button>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </aside>
      </div>

      {/* ---------- v0.3 import modal ---------- */}
      {showImport && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onPointerDown={() => { if (!importBusy) setShowImport(false); }}
        >
          <div
            className="panel"
            style={{ width: 660, maxWidth: '94vw', maxHeight: '90vh', overflowY: 'auto', borderRadius: 12, padding: 18 }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-2">
              <div className="font-semibold">Import an existing landing page</div>
              <button className="btn" disabled={importBusy} onClick={() => setShowImport(false)}>✕</button>
            </div>
            <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
              Paste HTML or React JSX, or upload a file, a whole folder, or a .zip. The page is rendered
              off-screen, measured, and converted into normal Scenetics elements you can drag, resize,
              keyframe and export. Best with static, markup-based landing pages.
            </p>

            <label className="lbl">Paste code (HTML or JSX)</label>
            <textarea
              className="input"
              rows={8}
              value={importText}
              placeholder={'<section class="hero">…</section>  —  or a React component with className / style={{…}}'}
              onChange={(e) => {
                setImportText(e.target.value);
                bundleRef.current = null;
                setImportSourceLabel('');
                setImportNote('');
              }}
              style={{ fontFamily: 'monospace', fontSize: 12 }}
            />

            <div className="flex gap-2 flex-wrap mt-3">
              <label className="btn" style={{ cursor: 'pointer' }}>
                Upload file (.html / .jsx / .tsx)
                <input type="file" accept=".html,.htm,.jsx,.tsx,.txt" style={{ display: 'none' }} onChange={onImportFile} />
              </label>
              <label className="btn" style={{ cursor: 'pointer' }}>
                Upload folder
                <input
                  type="file"
                  multiple
                  style={{ display: 'none' }}
                  onChange={onImportFolder}
                  ref={(el) => {
                    if (el) {
                      el.setAttribute('webkitdirectory', '');
                      el.setAttribute('directory', '');
                    }
                  }}
                />
              </label>
              <label className="btn" style={{ cursor: 'pointer' }}>
                Upload .zip
                <input type="file" accept=".zip,application/zip" style={{ display: 'none' }} onChange={onImportZip} />
              </label>
            </div>
            {importSourceLabel && (
              <p style={{ fontSize: 12, color: '#a78bfa', marginBottom: 0 }}>Source: {importSourceLabel}</p>
            )}
            {importNote && <p className="muted" style={{ fontSize: 12 }}>{importNote}</p>}

            <div className="flex gap-2 mt-3">
              <button className="btn btn-accent" style={{ flex: 1 }} disabled={importBusy} onClick={() => runImport('replace')}>
                {importBusy ? 'Converting…' : 'Import — replace current page'}
              </button>
              <button className="btn" style={{ flex: 1 }} disabled={importBusy} onClick={() => runImport('append')}>
                {importBusy ? 'Converting…' : 'Import — add to current page'}
              </button>
            </div>
            <p className="muted" style={{ fontSize: 11, marginBottom: 0 }}>
              Limits: at most {IMPORT_CAP} elements per import; scripts, SVG, canvas, video and iframes can't be
              converted and are skipped (you'll get a count). Imported layout is proportional — positions and
              sizes are % of the rendered page. One Ctrl+Z undoes the whole import.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
