/**
 * Scenetics importer — converts existing landing-page code (HTML or React
 * JSX) into NATIVE Scenetics scene elements.
 *
 * This module holds the PURE parts of the pipeline (no DOM access), so it
 * can be unit-tested in plain Node:
 *   - jsxToHtml()          pragmatic JSX -> HTML preprocessing
 *   - detectFormat()       'html' | 'jsx'
 *   - colorToHex()         CSS rgb()/rgba()/#hex -> #rrggbb (null = transparent)
 *   - classifyCandidate()  DOM-ish candidate -> Scenetics element type
 *   - candidatesToSpecs()  measured candidates -> element field specs
 *   - pickEntryFile()      choose the entry page inside an uploaded folder/zip
 *   - resolveAssetSrc()    map a relative <img src> to an uploaded asset URL
 *   - readZipEntries()     minimal .zip reader (stored + deflate via
 *                          DecompressionStream; no external packages)
 *
 * The DOM-measurement half (hidden sandboxed iframe, getComputedStyle,
 * getBoundingClientRect) lives in App.tsx; it produces the plain candidate
 * objects consumed here. Imported elements are ordinary scene elements, so
 * every editor tool, keyframes and the code generator work on them exactly
 * like hand-built ones.
 */

/** Hard cap on imported elements per import (keeps the editor usable). */
export const IMPORT_CAP = 60;

/* ------------------------------------------------------------------ */
/* Colour helpers                                                      */
/* ------------------------------------------------------------------ */

/**
 * Convert a CSS colour (as returned by getComputedStyle: rgb()/rgba())
 * to #rrggbb. Returns null for fully transparent colours ("no colour"),
 * which callers treat as "leave the model field unset".
 */
export function colorToHex(cssColor) {
  if (typeof cssColor !== 'string') return null;
  const s = cssColor.trim().toLowerCase();
  if (!s || s === 'transparent') return null;
  if (s.startsWith('#')) {
    if (/^#[0-9a-f]{6}$/.test(s)) return s;
    if (/^#[0-9a-f]{3}$/.test(s)) {
      return '#' + s.slice(1).split('').map((c) => c + c).join('');
    }
    return null;
  }
  const m = s.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)$/);
  if (!m) return null;
  const alpha = m[4] === undefined ? 1 : m[4].endsWith('%') ? Number(m[4].slice(0, -1)) / 100 : Number(m[4]);
  if (!(alpha > 0)) return null; // fully transparent
  const hex = (v) => Math.max(0, Math.min(255, Math.round(Number(v)))).toString(16).padStart(2, '0');
  return `#${hex(m[1])}${hex(m[2])}${hex(m[3])}`;
}

/* ------------------------------------------------------------------ */
/* JSX -> HTML preprocessing                                           */
/* ------------------------------------------------------------------ */

const UNITLESS_CSS = new Set([
  'opacity', 'z-index', 'font-weight', 'line-height', 'flex', 'flex-grow',
  'flex-shrink', 'order', 'zoom',
]);

const camelToKebab = (k) => k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());

/** Convert the inside of a JSX style={{ ... }} object to a CSS string. */
export function styleObjectToCss(body) {
  const out = [];
  const pairRe = /['"]?([a-zA-Z-]+)['"]?\s*:\s*('[^']*'|"[^"]*"|-?[\d.]+|[a-zA-Z#][\w#.-]*)/g;
  let m;
  while ((m = pairRe.exec(body)) !== null) {
    const prop = camelToKebab(m[1]);
    let val = m[2];
    if ((val.startsWith("'") && val.endsWith("'")) || (val.startsWith('"') && val.endsWith('"'))) {
      val = val.slice(1, -1);
    } else if (/^-?[\d.]+$/.test(val)) {
      val = UNITLESS_CSS.has(prop) ? val : `${val}px`;
    }
    if (val) out.push(`${prop}: ${val}`);
  }
  return out.join('; ');
}

/**
 * Pragmatic JSX -> HTML conversion for mostly-static landing-page markup.
 * Handles: import/export stripping, return(...) extraction, className,
 * htmlFor, style={{...}} objects, {"string"} expressions, self-closing
 * void tags, fragments, and removal of unresolvable bits (event handlers,
 * {identifier} expressions, custom <Component> tags — their children are
 * kept). It is NOT a JSX parser; dynamic/data-driven JSX is out of scope
 * (documented in the README).
 */
export function jsxToHtml(input) {
  let src = String(input ?? '');

  // Strip module plumbing first so the return-extraction below is stable.
  src = src.replace(/^\s*import[\s\S]*?from\s+['"][^'"]*['"];?\s*$/gm, '');
  src = src.replace(/^\s*import\s+['"][^'"]*['"];?\s*$/gm, '');
  src = src.replace(/^\s*export\s+default\s+/gm, '');
  src = src.replace(/^\s*export\s+(?=(const|function|class)\s)/gm, '');

  // Extract the returned markup, if this is a component.
  const retIdx = src.search(/\breturn\s*\(/);
  const arrowIdx = src.search(/=>\s*\(/);
  const openIdx = retIdx >= 0 ? src.indexOf('(', retIdx) : arrowIdx >= 0 ? src.indexOf('(', arrowIdx) : -1;
  if (openIdx >= 0) {
    const closeIdx = src.lastIndexOf(')');
    if (closeIdx > openIdx) src = src.slice(openIdx + 1, closeIdx);
  }

  // Comments: JSX {/* ... */} and stray block comments.
  src = src.replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
  src = src.replace(/\/\*[\s\S]*?\*\//g, '');

  // style={{ ... }} objects BEFORE generic {expression} handling.
  src = src.replace(/style\s*=\s*\{\{([\s\S]*?)\}\}/g, (_m, body) => `style="${styleObjectToCss(body)}"`);

  // attr={"literal"} / attr={123} -> plain HTML attributes.
  src = src.replace(/([a-zA-Z-]+)\s*=\s*\{\s*(['"])((?:(?!\2).)*)\2\s*\}/g, '$1=$2$3$2');
  src = src.replace(/([a-zA-Z-]+)\s*=\s*\{\s*(-?[\d.]+)\s*\}/g, '$1="$3"');
  // Any remaining attr={...} (identifiers, calls, template strings) cannot
  // be resolved statically — drop the attribute, keep the element.
  src = src.replace(/\s+[a-zA-Z_:][-a-zA-Z0-9_:.]*\s*=\s*\{[^{}]*\}/g, '');

  // {"text"} in children -> the text; {anythingElse} -> removed.
  src = src.replace(/\{\s*(['"])((?:(?!\1)[\s\S])*?)\1\s*\}/g, '$2');
  src = src.replace(/\{[^{}]*\}/g, '');

  // Fragments <>...</> -> nothing (children stay).
  src = src.replace(/<\/?>/g, '');

  // Custom components <Foo ... /> / <Foo>...</Foo> cannot be resolved —
  // drop the tags, keep any children.
  src = src.replace(/<\/?[A-Z][A-Za-z0-9.]*(\s[^<>]*?)?\/?>/g, '');

  // React attribute names -> HTML.
  src = src.replace(/\bclassName\s*=/g, 'class=');
  src = src.replace(/\bhtmlFor\s*=/g, 'for=');

  // Inline handler attributes written as strings (onclick="fn()") would
  // throw in the sandbox — strip them.
  src = src.replace(/\s+on[a-zA-Z]+\s*=\s*"[^"]*"/g, '');
  src = src.replace(/\s+on[a-zA-Z]+\s*=\s*'[^']*'/g, '');

  return src.trim();
}

/** Sniff whether a markup string / file is JSX rather than plain HTML. */
export function detectFormat(src, filename = '') {
  const ext = String(filename).toLowerCase().split('.').pop();
  if (ext === 'jsx' || ext === 'tsx') return 'jsx';
  if (ext === 'html' || ext === 'htm') return 'html';
  const s = String(src ?? '');
  if (/^\s*<!doctype/i.test(s) || /^\s*<html[\s>]/i.test(s)) return 'html';
  if (/\bclassName\s*=/.test(s)) return 'jsx';
  if (/^\s*(import|export)\s/m.test(s)) return 'jsx';
  if (/\breturn\s*\(\s*</.test(s)) return 'jsx';
  if (/=>\s*\(\s*</.test(s)) return 'jsx';
  return 'html';
}

/* ------------------------------------------------------------------ */
/* Candidate -> element mapping                                        */
/* ------------------------------------------------------------------ */

/**
 * Classify a measured candidate into a Scenetics element type, or null
 * when it should be skipped. Candidate shape (produced by the iframe
 * walker in App.tsx):
 * {
 *   tag, text, src?, container?, hasBgImage?,
 *   rect: { left, top, width, height },           // px, page-root relative
 *   style: { color, backgroundColor, fontSizePx, fontWeight, fontStyle,
 *            textAlign, borderRadius, opacity, fontFamily, lineHeightPx }
 * }
 */
export function classifyCandidate(c) {
  if (!c || typeof c !== 'object') return null;
  const tag = String(c.tag || '').toLowerCase();
  if (tag === 'img') return 'image';
  if (c.container) return 'card';
  if (/^h[1-6]$/.test(tag)) return 'heading';
  if (tag === 'button' || tag === 'input') return 'button';
  const bgVisible = colorToHex(c.style?.backgroundColor) !== null || !!c.hasBgImage;
  if (tag === 'a') return bgVisible ? 'button' : 'text';
  if (bgVisible && tag === 'span') return 'button'; // badge / pill
  if (bgVisible) return 'card'; // leaf block with its own background = callout card
  return 'text';
}

const GENERIC_FONTS = new Set([
  'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui',
  'ui-serif', 'ui-sans-serif', 'ui-monospace', 'inherit', 'initial', 'unset',
]);

/** Parse a computed border-radius string ("16px", "50%", "12px 12px 0 0"). */
export function parseRadiusPx(borderRadius, widthPx) {
  if (typeof borderRadius !== 'string' || !borderRadius.trim()) return null;
  const first = borderRadius.trim().split(/\s+/)[0];
  if (first.endsWith('%')) {
    const pct = Number(first.slice(0, -1));
    if (!Number.isFinite(pct)) return null;
    if (pct >= 50) return 999; // pill
    return Math.round(((pct / 100) * (widthPx || 0)) || 0);
  }
  const px = parseFloat(first);
  return Number.isFinite(px) ? Math.round(px) : null;
}

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const r1 = (v) => Math.round(v * 10) / 10;

/**
 * Map one candidate to an element spec { type, fields } where fields is a
 * Partial<SceneElement> suitable for createElement(type, fields) — keys
 * with unusable values are OMITTED (never undefined), so model defaults
 * survive. Returns null (with a reason) for candidates that must be
 * skipped. Positions use the model's anchor + % system (constraint 1):
 * every imported element anchors 'top-left' at its measured % position,
 * with width/height as % of the rendered page.
 */
export function mapCandidate(c, page) {
  const type = classifyCandidate(c);
  if (!type) return { spec: null, reason: 'unmappable element' };
  const rect = c.rect || { left: 0, top: 0, width: 0, height: 0 };
  if (!(page.width > 0) || !(page.height > 0)) return { spec: null, reason: 'page has no size' };
  if (rect.width < 2 || rect.height < 2) return { spec: null, reason: 'invisible or zero-size' };

  const st = c.style || {};
  const opacity = typeof st.opacity === 'number' ? st.opacity : 1;
  if (opacity <= 0.02) return { spec: null, reason: 'fully transparent' };

  const text = String(c.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (type !== 'image' && type !== 'card' && !text) return { spec: null, reason: 'no text content' };

  const fontScale = typeof page.fontScale === 'number' && page.fontScale > 0 ? page.fontScale : 1;
  const fields = {
    anchor: 'top-left',
    xPercent: r1(clamp((rect.left / page.width) * 100, 0, 100)),
    yPercent: r1(clamp((rect.top / page.height) * 100, 0, 100)),
    widthPercent: r1(clamp((rect.width / page.width) * 100, 2, 100)),
    text,
  };

  // Explicit heights only where auto height would break the layout:
  // cards (background blocks) and images (frames). Text-ish elements keep
  // auto height so reflow at a different stage width cannot clip them.
  if (type === 'card' || type === 'image') {
    fields.heightPercent = r1(clamp((rect.height / page.height) * 100, 1, 100));
  }

  const color = colorToHex(st.color);
  if (color) fields.color = color;
  const bg = colorToHex(st.backgroundColor);
  if (bg) fields.bg = bg;

  if (typeof st.fontSizePx === 'number' && st.fontSizePx > 0) {
    fields.fontSize = clamp(Math.round(st.fontSizePx * fontScale), 8, 96);
  }
  const weight = st.fontWeight;
  const bold =
    weight === 'bold' || weight === 'bolder' ||
    (typeof weight === 'number' && weight >= 600) ||
    (typeof weight === 'string' && /^\d+$/.test(weight) && Number(weight) >= 600);
  if (bold) fields.bold = true;
  if (st.fontStyle === 'italic' || st.fontStyle === 'oblique') fields.italic = true;
  if (st.textAlign === 'left' || st.textAlign === 'center' || st.textAlign === 'right') {
    fields.textAlign = st.textAlign;
  } else if (st.textAlign === 'start') fields.textAlign = 'left';
  else if (st.textAlign === 'end') fields.textAlign = 'right';

  const radius = parseRadiusPx(st.borderRadius, rect.width);
  if (radius !== null) fields.radius = clamp(radius, 0, 999);
  if (opacity < 1) fields.opacity = Math.round(opacity * 100) / 100;

  if (typeof st.fontFamily === 'string' && st.fontFamily.trim()) {
    const first = st.fontFamily.split(',')[0].trim().replace(/^['"]|['"]$/g, '');
    if (first && !GENERIC_FONTS.has(first.toLowerCase())) fields.fontFamily = first;
  }
  if (
    typeof st.lineHeightPx === 'number' && st.lineHeightPx > 0 &&
    typeof st.fontSizePx === 'number' && st.fontSizePx > 0
  ) {
    fields.lineHeight = clamp(Math.round((st.lineHeightPx / st.fontSizePx) * 100) / 100, 0.8, 3);
  }

  if (type === 'image') {
    // src was already resolved by the caller (folder assets -> data URLs);
    // keep only self-contained or absolute sources — a bare relative path
    // cannot load in the editor/export, so fall back to the placeholder.
    const src = typeof c.src === 'string' ? c.src : '';
    if (/^(https?:|data:|blob:)/i.test(src)) fields.imageSrc = src;
    fields.text = text || 'Image';
  }

  return { spec: { type, fields }, reason: null };
}

/**
 * Convert a list of measured candidates into element specs, capped at
 * IMPORT_CAP. Returns { specs, skipped, truncated } — skipped counts both
 * unmappable candidates and overflow past the cap.
 */
export function candidatesToSpecs(candidates, page) {
  const specs = [];
  let skipped = 0;
  let truncated = false;
  for (const c of Array.isArray(candidates) ? candidates : []) {
    if (specs.length >= IMPORT_CAP) {
      skipped += 1;
      truncated = true;
      continue;
    }
    const { spec } = mapCandidate(c, page || { width: 1, height: 1 });
    if (spec) specs.push(spec);
    else skipped += 1;
  }
  return { specs, skipped, truncated };
}

/* ------------------------------------------------------------------ */
/* Folder / zip helpers                                                */
/* ------------------------------------------------------------------ */

/**
 * Pick the entry page from a list of file paths (folder upload or zip).
 * Preference: index.html (shallowest) > other .html (shallowest) >
 * App.jsx/tsx > page/Home/Landing/index component > any other component
 * (excluding main.* entry shims, tests and .d.ts). Returns null if none.
 */
export function pickEntryFile(names) {
  const list = (Array.isArray(names) ? names : [])
    .map((n) => String(n).replace(/^\.\//, ''))
    .filter((n) => n && !n.endsWith('/'));
  const depth = (n) => n.split('/').length;
  const byShallow = (a, b) => depth(a) - depth(b) || a.localeCompare(b);

  const htmls = list.filter((n) => /\.html?$/i.test(n)).sort(byShallow);
  const indexHtml = htmls.filter((n) => /(^|\/)index\.html?$/i.test(n)).sort(byShallow)[0];
  if (indexHtml) return indexHtml;
  if (htmls[0]) return htmls[0];

  const comps = list.filter((n) => /\.(jsx|tsx)$/i.test(n) && !/\.d\.ts$/i.test(n) && !/\.(test|spec)\./i.test(n));
  const app = comps.filter((n) => /(^|\/)app\.(jsx|tsx)$/i.test(n)).sort(byShallow)[0];
  if (app) return app;
  const named = comps
    .filter((n) => /(^|\/)(page|home|landing|landingpage|index)\.(jsx|tsx)$/i.test(n) && !/(^|\/)main\.(jsx|tsx)$/i.test(n))
    .sort(byShallow)[0];
  if (named) return named;
  const rest = comps.filter((n) => !/(^|\/)main\.(jsx|tsx)$/i.test(n)).sort(byShallow);
  return rest[0] || comps.sort(byShallow)[0] || null;
}

/**
 * Resolve an <img src> from imported markup against uploaded assets
 * (folder/zip images already converted to data URLs). Absolute http(s)/
 * data/blob sources pass through; relative sources match by exact path,
 * normalised path, or basename. Returns '' when unresolvable.
 */
export function resolveAssetSrc(src, assets) {
  if (typeof src !== 'string' || !src.trim()) return '';
  const raw = src.trim();
  if (/^(https?:|data:|blob:)/i.test(raw)) return raw;
  const map = assets || {};
  const norm = raw.replace(/^\.\//, '').replace(/^\//, '');
  let decoded = norm;
  try { decoded = decodeURIComponent(norm); } catch { /* keep raw */ }
  for (const key of [raw, norm, decoded]) {
    if (key && typeof map[key] === 'string') return map[key];
  }
  const base = decoded.split('/').pop();
  for (const [k, v] of Object.entries(map)) {
    if (k.split('/').pop() === base && typeof v === 'string') return v;
  }
  return '';
}

/* ------------------------------------------------------------------ */
/* Minimal .zip reader (stored + deflate, no external packages)        */
/* ------------------------------------------------------------------ */

function zipError(msg) {
  const e = new Error(msg);
  e.name = 'ZipError';
  return e;
}

async function inflateRaw(bytes) {
  if (typeof DecompressionStream === 'undefined') {
    throw zipError('This browser cannot unzip deflated entries (no DecompressionStream). Folder upload works instead.');
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

/**
 * Read a .zip file's entries: [{ name, data: Uint8Array }].
 * Supports method 0 (stored) and method 8 (deflate). CRCs are not
 * verified — this is a convenience importer for the user's own files,
 * not a security boundary. The archive itself never executes.
 */
export async function readZipEntries(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Find the End Of Central Directory record (scan the tail backwards).
  let eocd = -1;
  const tailStart = Math.max(0, bytes.length - 65557);
  for (let i = bytes.length - 22; i >= tailStart; i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw zipError('Not a valid .zip file (no end-of-directory record).');
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true); // central directory offset

  const entries = [];
  for (let i = 0; i < count; i++) {
    if (p + 46 > bytes.length || view.getUint32(p, true) !== 0x02014b50) break;
    const method = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    // Local header: skip its name + extra to reach the data.
    if (localOffset + 30 > bytes.length || view.getUint32(localOffset, true) !== 0x04034b50) continue;
    const lNameLen = view.getUint16(localOffset + 26, true);
    const lExtraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const raw = bytes.subarray(dataStart, dataStart + compSize);
    if (method === 0) entries.push({ name, data: new Uint8Array(raw) });
    else if (method === 8) entries.push({ name, data: await inflateRaw(raw) });
    else throw zipError(`Unsupported zip compression method ${method} for "${name}".`);
  }
  return entries;
}
