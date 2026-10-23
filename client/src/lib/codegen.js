/**
 * Scenetics code generator — PURE functions, no DOM, no framework.
 *
 * Single source of truth = the scene JSON. This module is the deterministic
 * compiler from scene JSON -> exported React/Tailwind markup (Page.jsx) and
 * exported CSS (animations.css). No LLM is involved on this path.
 *
 * It enforces the binding ARCHITECTURE_CONSTRAINTS:
 *  1. No raw pixel positioning is exported — elements export with percentage
 *     offsets relative to a 9-point anchor, never `left: <px>` / `top: <px>`.
 *  2. Exported animation is scroll-driven via the native CSS Scroll-Driven
 *     Animations API (`animation-timeline`). There is NO JavaScript scroll
 *     listener in generated code. (The editor's JS scrub preview is separate
 *     and never reaches this module's output.)
 *  3. Transform tracks are merged: for every unique keyframe offset across
 *     all of an element's tracks, every property is sampled and emitted once,
 *     using the standalone CSS properties `translate`, `rotate`, `scale`
 *     plus `opacity` — never competing `transform:` declarations.
 *  4. A scene exports as a tall wrapper (height = scrollLengthVh) containing
 *     a `position: sticky; top: 0; height: 100vh` stage.
 *  5. Markup is flat and semantic (<main>, <section>, <article>, ...);
 *     all @keyframes live in the separate animations.css output.
 */

/** Animatable properties and their default (rest) values. */
export const TRACK_DEFAULTS = {
  translateX: 0,
  translateY: 0,
  scale: 1,
  rotate: 0,
  opacity: 1,
};

export const TRACK_PROPS = Object.keys(TRACK_DEFAULTS);

/** Escape text so it is safe inside JSX markup. */
export function escapeJsxText(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\{/g, '&#123;')
    .replace(/\}/g, '&#125;');
}

/** Sanitise an element id into a safe CSS class suffix. */
export function classSuffix(id) {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, '-');
}

/**
 * Sample one track (array of {offset, value}, offset = scroll %) at a given
 * scroll offset. Linear interpolation between neighbouring keyframes;
 * holds the first/last value outside the track's range.
 */
export function sampleTrack(track, offset, fallback) {
  if (!track || track.length === 0) return fallback;
  const sorted = [...track].sort((a, b) => a.offset - b.offset);
  if (offset <= sorted[0].offset) return sorted[0].value;
  if (offset >= sorted[sorted.length - 1].offset) return sorted[sorted.length - 1].value;
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (offset >= a.offset && offset <= b.offset) {
      const span = b.offset - a.offset || 1;
      const t = (offset - a.offset) / span;
      return a.value + (b.value - a.value) * t;
    }
  }
  return fallback;
}

/** Every unique keyframe offset across all of an element's tracks, sorted. */
export function collectOffsets(element) {
  const set = new Set();
  const tracks = element.tracks || {};
  for (const prop of TRACK_PROPS) {
    for (const kf of tracks[prop] || []) set.add(kf.offset);
  }
  return [...set].sort((a, b) => a - b);
}

/**
 * The merged state of an element at one scroll offset: every animatable
 * property sampled at that offset (constraint 3 — this is the merge step
 * shared by the editor preview AND the exporter, so they can never drift).
 */
export function sampleElementAt(element, offset) {
  const tracks = element.tracks || {};
  const out = {};
  for (const prop of TRACK_PROPS) {
    out[prop] = sampleTrack(tracks[prop], offset, TRACK_DEFAULTS[prop]);
  }
  return out;
}

/** Round to 3 decimals and trim, for stable generated output. */
function n(value) {
  const r = Math.round(Number(value) * 1000) / 1000;
  return Object.is(r, -0) ? 0 : r;
}

/**
 * Static anchor alignment: which point of the element sits on its
 * (xPercent, yPercent) position. Expressed as a CSS transform translate of
 * the element's own size. This is a *static* `transform` in the element's
 * class — animated motion uses the standalone properties, which compose
 * with (do not overwrite) this transform per CSS Transforms Level 2.
 */
export function anchorTranslate(anchor) {
  const x = anchor.includes('left') ? 0 : anchor.includes('right') ? -100 : -50;
  const y = anchor.startsWith('top') ? 0 : anchor.startsWith('bottom') ? -100 : -50;
  return { x, y };
}

/** Semantic tag per element type (constraint 5 — flat, semantic DOM). */
const TAG_BY_TYPE = {
  heading: 'h2',
  text: 'p',
  button: 'button',
  card: 'article',
  image: 'figure',
};

/** A few presentational Tailwind classes per type (padding etc.). */
const TAILWIND_BY_TYPE = {
  heading: 'font-bold leading-tight m-0',
  text: 'leading-relaxed m-0',
  button: 'px-5 py-2.5 font-semibold cursor-pointer border-0',
  card: 'p-5 shadow-lg',
  image: 'flex items-center justify-center m-0 overflow-hidden',
};

/**
 * Generate Page.jsx — React + Tailwind markup.
 * Elements are direct children of the sticky stage (flat). Positioning is
 * NOT in the markup: each element carries a generated class (el-<id>) whose
 * rules live in animations.css, using percentage offsets (constraint 1).
 */
export function generatePageJsx(scene) {
  const elements = scene.elements || [];
  const lines = [];
  lines.push(`import './animations.css';`);
  lines.push('');
  lines.push('export default function Page() {');
  lines.push('  return (');
  lines.push('    <main className="min-h-screen bg-neutral-950 text-white">');
  lines.push('      {/* Scene: tall scroll wrapper + sticky stage (see animations.css) */}');
  lines.push('      <section className="scenetics-scene" aria-label="Animated scene">');
  lines.push('        <div className="scenetics-stage">');
  for (const el of elements) {
    const tag = TAG_BY_TYPE[el.type] || 'div';
    const cls = `el-${classSuffix(el.id)}`;
    const styleParts = [
      `color: '${el.color}'`,
      `fontSize: '${n(el.fontSize / 16)}rem'`,
    ];
    if (el.type === 'card' || el.type === 'button' || el.type === 'image') {
      styleParts.push(`backgroundColor: '${el.bg}'`);
    }
    if (el.type === 'card' || el.type === 'button' || el.type === 'image') {
      styleParts.push(`borderRadius: '${n(el.radius)}px'`);
    }
    const hasTracks = collectOffsets(el).length > 0;
    if (!hasTracks) styleParts.push(`opacity: ${n(el.opacity)}`);
    const tw = TAILWIND_BY_TYPE[el.type] || '';
    const text = el.type === 'image' ? 'Image' : escapeJsxText(el.text);
    lines.push(
      `          <${tag} className="${cls} ${tw}" style={{ ${styleParts.join(', ')} }}>${text}</${tag}>`
    );
  }
  lines.push('        </div>');
  lines.push('      </section>');
  lines.push('    </main>');
  lines.push('  );');
  lines.push('}');
  lines.push('');
  return lines.join('\n');
}

/**
 * Generate animations.css — scene layout, per-element anchor positioning
 * (percentages only), and all merged @keyframes, isolated in this file.
 */
export function generateAnimationsCss(scene) {
  const elements = scene.elements || [];
  const out = [];
  out.push('/* Scenetics — generated animations & scene layout. Do not edit by hand. */');
  out.push('');
  out.push('/* Constraint 4: Scene = tall parent (scroll distance) + sticky stage. */');
  out.push('.scenetics-scene {');
  out.push(`  height: ${n(scene.scrollLengthVh)}vh;`);
  out.push('  position: relative;');
  out.push('}');
  out.push('.scenetics-stage {');
  out.push('  position: sticky;');
  out.push('  top: 0;');
  out.push('  height: 100vh;');
  out.push('  overflow: hidden;');
  out.push('}');
  out.push('');

  for (const el of elements) {
    const cls = `el-${classSuffix(el.id)}`;
    const { x, y } = anchorTranslate(el.anchor || 'center');
    out.push(`/* ${el.type}: anchored at ${el.anchor}, offset in % (constraint 1 — no px positioning) */`);
    out.push(`.${cls} {`);
    out.push('  position: absolute;');
    out.push(`  left: ${n(el.xPercent)}%;`);
    out.push(`  top: ${n(el.yPercent)}%;`);
    out.push(`  width: ${n(el.widthPercent)}%;`);
    if (el.type === 'image') out.push('  aspect-ratio: 4 / 3;');
    if (el.type === 'card') out.push('  min-height: 18%;');
    // Static anchor alignment only. Animated motion below uses the standalone
    // translate/rotate/scale properties, which compose with this transform.
    out.push(`  transform: translate(${x}%, ${y}%);`);
    out.push('}');

    const offsets = collectOffsets(el);
    if (offsets.length > 0) {
      const animName = `kf-${classSuffix(el.id)}`;
      out.push('');
      out.push(`/* Constraint 3: tracks merged — every property sampled at every unique offset. */`);
      out.push(`@keyframes ${animName} {`);
      for (const offset of offsets) {
        const s = sampleElementAt(el, offset);
        out.push(`  ${n(offset)}% {`);
        out.push(`    translate: ${n(s.translateX)}px ${n(s.translateY)}px;`);
        out.push(`    rotate: ${n(s.rotate)}deg;`);
        out.push(`    scale: ${n(s.scale)};`);
        out.push(`    opacity: ${n(s.opacity)};`);
        out.push('  }');
      }
      out.push('}');
      out.push('');
      out.push('/* Constraint 2: scroll-driven on the compositor — no JS scroll listener. */');
      out.push('@media (prefers-reduced-motion: no-preference) {');
      out.push(`  .${cls} {`);
      out.push(`    animation: ${animName} linear both;`);
      out.push('    animation-timeline: scroll(root);');
      out.push('  }');
      out.push('}');
      out.push('@media (prefers-reduced-motion: reduce) {');
      out.push(`  .${cls} { animation: none; }`);
      out.push('}');
    }
    out.push('');
  }
  return out.join('\n');
}
