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

console.log('PASS: all Scenetics codegen constraint tests passed.');
console.log(' - merged keyframes at unified offsets [0,25,50,75,100], standalone translate/rotate/scale, no transform: in keyframes');
console.log(' - no raw px left/top positioning; anchor offsets exported as %');
console.log(' - scene wrapper: height 300vh + position: sticky stage at 100vh');
console.log(' - animation-timeline present, no scroll listener, prefers-reduced-motion guard');
console.log(' - flat semantic markup, @keyframes isolated in animations.css');
