/**
 * Scenetics codegen tests — plain Node, no test framework needed.
 * Run: npm test   (in client/)
 * Asserts the ARCHITECTURE_CONSTRAINTS on the generated export code.
 */
import assert from 'node:assert';
import {
  generatePageJsx,
  generateAnimationsCss,
  collectOffsets,
  sampleElementAt,
  sampleTracksAt,
} from '../src/lib/codegen.js';

// An element whose tracks deliberately use DIFFERENT offsets per property,
// to prove the exporter merges them at unified offsets (constraint 3).
const el = {
  id: 'card-1',
  type: 'card',
  text: 'Hello',
  color: '#ffffff',
  bg: '#7c3aed',
  fontSize: 20,
  radius: 16,
  opacity: 1,
  widthPercent: 30,
  anchor: 'bottom-right',
  xPercent: 82.5,
  yPercent: 77,
  tracks: {
    translateX: [
      { offset: 0, value: -120 },
      { offset: 50, value: 0 },
    ],
    translateY: [
      { offset: 25, value: 60 },
      { offset: 100, value: 0 },
    ],
    scale: [
      { offset: 0, value: 0.5 },
      { offset: 100, value: 1.5 },
    ],
    rotate: [{ offset: 75, value: 12 }],
    opacity: [
      { offset: 0, value: 0 },
      { offset: 100, value: 1 },
    ],
  },
};

const scene = { id: 'scene-1', name: 'Test', scrollLengthVh: 300, elements: [el] };
const css = generateAnimationsCss(scene);
const jsx = generatePageJsx(scene);

// Sanity: unified offsets = union of all track offsets.
assert.deepEqual(collectOffsets(el), [0, 25, 50, 75, 100]);

// (1) Merged keyframes: each keyframe block carries translate+rotate+scale,
//     sampled from ALL tracks, and NO `transform:` declaration inside any
//     @keyframes block (constraint 3).
const keyframesBlock = css.match(/@keyframes[^{]+\{([\s\S]*?)\n\}/);
assert.ok(keyframesBlock, 'expected a @keyframes block');
const keyBody = keyframesBlock[1];
assert.ok(!/transform\s*:/.test(keyBody), 'keyframe block must not contain transform: declarations');
for (const offset of ['0%', '25%', '50%', '75%', '100%']) {
  const re = new RegExp(`${offset} \\{([^}]*)\\}`);
  const m = keyBody.match(re);
  assert.ok(m, `missing merged keyframe at ${offset}`);
  assert.ok(m[1].includes('translate:'), `keyframe ${offset} missing merged translate`);
  assert.ok(m[1].includes('rotate:'), `keyframe ${offset} missing merged rotate`);
  assert.ok(m[1].includes('scale:'), `keyframe ${offset} missing merged scale`);
  assert.ok(m[1].includes('opacity:'), `keyframe ${offset} missing merged opacity`);
}
// Merging actually interpolates: scale at 50% is halfway 0.5 -> 1.5 = 1.
assert.equal(sampleElementAt(el, 50).scale, 1);
assert.equal(sampleElementAt(el, 0).translateX, -120);
assert.equal(sampleElementAt(el, 100).rotate, 12); // holds last value after 75%

// (2) No raw pixel left:/top: positioning anywhere in the export
//     (constraint 1 — percentage anchor offsets only).
assert.ok(!/\bleft:\s*-?[\d.]+px/.test(css), 'exported CSS must not use left: <px>');
assert.ok(!/\btop:\s*-?[\d.]+px/.test(css), 'exported CSS must not use top: <px>');
assert.ok(!/\bleft:\s*-?[\d.]+px/.test(jsx), 'exported JSX must not use left: <px>');
assert.ok(!/\btop:\s*-?[\d.]+px/.test(jsx), 'exported JSX must not use top: <px>');
assert.ok(css.includes('left: 82.5%;'), 'anchor offset should be exported as a percentage');

// (3) Scene wrapper: tall parent in vh + sticky stage (constraint 4).
assert.ok(css.includes('height: 300vh;'), 'scene wrapper must use scrollLengthVh');
assert.ok(/position:\s*sticky/.test(css), 'stage must be position: sticky');
assert.ok(css.includes('height: 100vh;'), 'sticky stage must be 100vh');

// (4) Scroll-driven animation, no JS scroll listener (constraint 2),
//     and a prefers-reduced-motion guard.
assert.ok(css.includes('animation-timeline:'), 'export must use animation-timeline');
assert.ok(!css.includes("addEventListener('scroll'"), 'export must not contain a scroll listener');
assert.ok(!jsx.includes("addEventListener('scroll'"), 'export must not contain a scroll listener');
assert.ok(!jsx.includes('addEventListener'), 'exported JSX must not add event listeners');
assert.ok(css.includes('prefers-reduced-motion'), 'export must guard prefers-reduced-motion');

// (5) Flat semantic markup: scene is a <section>, card is an <article>,
//     keyframes are NOT in the markup (they live in animations.css).
assert.ok(jsx.includes('<section'), 'scene should render as a semantic <section>');
assert.ok(jsx.includes('<article'), 'card should render as a semantic <article>');
assert.ok(!jsx.includes('@keyframes'), '@keyframes must live in animations.css, not markup');

/* ================================================================== */
/* v0.2 editor tools                                                   */
/* ================================================================== */

// An image with base rotation + a rotate track, horizontal flip + a scale
// track, an explicit height, a crop window and style tools set.
const el2 = {
  id: 'img-1',
  type: 'image',
  text: 'A photo',
  color: '#ffffff',
  bg: '#222222',
  fontSize: 14,
  radius: 12,
  opacity: 1,
  widthPercent: 40,
  heightPercent: 40,
  anchor: 'center',
  xPercent: 50,
  yPercent: 50,
  baseRotate: 30,
  flipH: true,
  flipV: false,
  cropX: 20,
  cropY: 80,
  cropZoom: 1.5,
  imageSrc: '',
  fontFamily: 'Georgia',
  bold: true,
  borderWidth: 3,
  borderColor: '#ff0000',
  shadow: 'md',
  tracks: {
    rotate: [
      { offset: 0, value: 0 },
      { offset: 100, value: 90 },
    ],
    scale: [
      { offset: 0, value: 1 },
      { offset: 100, value: 2 },
    ],
  },
};
const scene2 = { id: 'scene-2', name: 'Tools', scrollLengthVh: 300, elements: [el2] };
const css2 = generateAnimationsCss(scene2);
const jsx2 = generatePageJsx(scene2);

// (6) Base rotation MERGES into the rotate keyframe track (constraint 3):
//     keyframe values = track value + baseRotate (30): 0->30, 100->120.
assert.equal(sampleTracksAt(el2, 0).rotate, 0, 'raw track sampling must not include base rotation');
assert.equal(sampleElementAt(el2, 0).rotate, 30, 'merged rotate at 0% must include baseRotate');
assert.equal(sampleElementAt(el2, 100).rotate, 120, 'merged rotate at 100% must be 90 + 30');
const kf2 = css2.match(/@keyframes[^{]+\{([\s\S]*?)\n\}/)[1];
assert.ok(/0% \{[^}]*rotate: 30deg;/.test(kf2), 'keyframe 0% must carry merged rotate 30deg');
assert.ok(/100% \{[^}]*rotate: 120deg;/.test(kf2), 'keyframe 100% must carry merged rotate 120deg');
// ...and the base class must NOT also declare rotate (that would double it).
const baseClass2 = css2.match(/\.el-img-1 \{([^}]*)\}/)[1];
assert.ok(!/rotate\s*:/.test(baseClass2), 'with keyframes, base class must not declare rotate');
assert.ok(!/scale\s*:/.test(baseClass2), 'with keyframes, base class must not declare scale');

// (7) Flip MERGES into the scale keyframe track per axis:
//     flipH with track scale 1 -> "scale: -1 1", scale 2 -> "scale: -2 2".
assert.equal(sampleElementAt(el2, 0).scaleX, -1);
assert.equal(sampleElementAt(el2, 0).scaleY, 1);
assert.equal(sampleElementAt(el2, 100).scaleX, -2);
assert.ok(/0% \{[^}]*scale: -1 1;/.test(kf2), 'keyframe 0% must carry flipped scale -1 1');
assert.ok(/100% \{[^}]*scale: -2 2;/.test(kf2), 'keyframe 100% must carry flipped scale -2 2');
assert.ok(!/transform\s*:/.test(kf2), 'flipped keyframes must not use transform: either');

// (8) Height export: explicit height as % of stage, no px positioning.
assert.ok(css2.includes('height: 40%;'), 'explicit heightPercent must export as height: 40%');
assert.ok(!/\b(left|top):\s*-?[\d.]+px/.test(css2), 'v0.2 CSS must not use px left/top');
assert.ok(!/\b(left|top):\s*-?[\d.]+px/.test(jsx2), 'v0.2 JSX must not use px left/top');

// (9) Crop export: figure is an overflow-hidden frame, the img uses
//     object-fit: cover + object-position from the crop window + zoom.
assert.ok(baseClass2.includes('overflow: hidden'), 'image frame class must be overflow: hidden');
assert.ok(jsx2.includes("objectFit: 'cover'"), 'cropped image must export objectFit cover');
assert.ok(jsx2.includes("objectPosition: '20% 80%'"), 'crop window must export as objectPosition %');
assert.ok(jsx2.includes("transform: 'scale(1.5)'"), 'crop zoom must export on the inner img');

// (10) Border / shadow / text tools export.
assert.ok(jsx2.includes("border: '3px solid #ff0000'"), 'border must export from borderWidth/borderColor');
assert.ok(jsx2.includes('boxShadow:'), 'shadow preset must export as boxShadow');
assert.ok(jsx2.includes("fontFamily: 'Georgia'"), 'font family must export');
assert.ok(jsx2.includes('fontWeight: 700'), 'bold must export as fontWeight 700');

// (11) No keyframes: base rotation + flip export as standalone properties
//      on the element class (same properties the keyframes would use).
const el3 = {
  id: 'txt-1', type: 'text', text: 'Hi', color: '#fff', bg: '#000',
  fontSize: 16, radius: 0, opacity: 0.9, widthPercent: 30, heightPercent: null,
  anchor: 'center', xPercent: 50, yPercent: 50,
  baseRotate: 15, flipH: false, flipV: true, tracks: {},
};
const css3 = generateAnimationsCss({ id: 's3', name: 'T', scrollLengthVh: 200, elements: [el3] });
const baseClass3 = css3.match(/\.el-txt-1 \{([^}]*)\}/)[1];
assert.ok(baseClass3.includes('rotate: 15deg;'), 'no-track base rotation must export as standalone rotate');
assert.ok(baseClass3.includes('scale: 1 -1;'), 'no-track flip must export as standalone scale');
assert.ok(!css3.includes('@keyframes'), 'element without tracks must not emit keyframes');

console.log('PASS: all Scenetics codegen constraint tests passed.');
console.log(' - merged keyframes at unified offsets [0,25,50,75,100], standalone translate/rotate/scale, no transform: in keyframes');
console.log(' - no raw px left/top positioning; anchor offsets exported as %');
console.log(' - scene wrapper: height 300vh + position: sticky stage at 100vh');
console.log(' - animation-timeline present, no scroll listener, prefers-reduced-motion guard');
console.log(' - flat semantic markup, @keyframes isolated in animations.css');
console.log(' - v0.2: base rotation + flip merged into keyframe tracks; standalone when no tracks');
console.log(' - v0.2: height exported as % (no px), crop = overflow-hidden frame + object-fit/position');
console.log(' - v0.2: border, shadow presets, font tools exported');
