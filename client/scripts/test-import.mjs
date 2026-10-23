/**
 * Scenetics v0.3 importer tests — plain Node, no framework.
 * Run: node scripts/test-import.mjs   (also wired into `npm test`)
 *
 * Tests the PURE half of the import pipeline (lib/importer.js): JSX->HTML
 * preprocessing, colour/style mapping, candidate -> element-spec mapping,
 * entry-file picking, asset resolution, and the minimal zip reader.
 * The DOM-measurement half (hidden iframe in App.tsx) is exercised here
 * indirectly: the candidate objects below are exactly what the iframe
 * walker produces for the sample pages quoted in the comments.
 */
import assert from 'node:assert';
import zlib from 'node:zlib';
import {
  IMPORT_CAP,
  candidatesToSpecs,
  colorToHex,
  detectFormat,
  jsxToHtml,
  mapCandidate,
  parseRadiusPx,
  pickEntryFile,
  readZipEntries,
  resolveAssetSrc,
  styleObjectToCss,
} from '../src/lib/importer.js';

/* ------------------------------------------------------------------ */
/* colour helpers                                                      */
/* ------------------------------------------------------------------ */
assert.equal(colorToHex('rgb(124, 58, 237)'), '#7c3aed');
assert.equal(colorToHex('rgba(124, 58, 237, 1)'), '#7c3aed');
assert.equal(colorToHex('rgba(0, 0, 0, 0)'), null, 'fully transparent => null');
assert.equal(colorToHex('transparent'), null);
assert.equal(colorToHex('#abc'), '#aabbcc');
assert.equal(colorToHex('#7C3AED'), '#7c3aed');
assert.equal(colorToHex('not-a-colour'), null);

/* ------------------------------------------------------------------ */
/* JSX -> HTML preprocessing                                           */
/*                                                                     */
/* Sample JSX (a typical static landing-page component):               */
/* ------------------------------------------------------------------ */
const sampleJsx = `
import React from 'react';
import './hero.css';

export default function Hero() {
  return (
    <section className="hero-wrap" style={{ backgroundColor: '#111827', padding: 24, opacity: 0.95 }}>
      <h1 className="title">{"Build faster"}</h1>
      <button className="cta" onClick={handleClick}>Start now</button>
      <img src={"https://example.com/x.png"} alt="Shot" />
      <p className="sub">Made by {name} today</p>
    </section>
  );
}
`;
const html = jsxToHtml(sampleJsx);
assert.ok(!html.includes('className'), 'className must be converted');
assert.ok(html.includes('class="hero-wrap"'), 'class attribute kept');
assert.ok(html.includes('background-color: #111827'), 'style object camelCase -> kebab');
assert.ok(html.includes('padding: 24px'), 'numeric style values gain px');
assert.ok(html.includes('opacity: 0.95'), 'unitless style values stay unitless');
assert.ok(html.includes('Build faster'), '{"string"} expressions become text');
assert.ok(!html.includes('onClick'), 'event handler props dropped');
assert.ok(!html.includes('{') && !html.includes('}'), 'no JSX braces survive');
assert.ok(html.includes('src="https://example.com/x.png"'), 'src={"..."} becomes src="..."');
assert.ok(html.includes('Start now'), 'button text kept');
assert.ok(!html.includes('import'), 'imports stripped');
assert.ok(!html.includes('export'), 'exports stripped');

assert.equal(
  styleObjectToCss("fontWeight: 700, marginTop: 12, color: '#fff'"),
  'font-weight: 700; margin-top: 12px; color: #fff'
);

/* format detection */
assert.equal(detectFormat(sampleJsx), 'jsx');
assert.equal(detectFormat('<!doctype html><html><body><h1>x</h1></body></html>'), 'html');
assert.equal(detectFormat('<div class="a">hi</div>'), 'html');
assert.equal(detectFormat('whatever', 'Page.tsx'), 'jsx');
assert.equal(detectFormat('whatever', 'page.html'), 'html');

/* ------------------------------------------------------------------ */
/* Candidate -> element mapping                                        */
/*                                                                     */
/* Sample HTML page the candidates below were measured from:           */
/*   <section style="background:#111">                                 */
/*     <h1 style="font-size:40px;font-weight:700">Welcome</h1>         */
/*     <a style="background:rgb(124,58,237)" href="#">Buy now</a>      */
/*     <img src="https://example.com/hero.png" alt="Hero">             */
/*     <div style="background:rgb(31,31,35)"><p>Plan card</p></div>    */
/*   </section>                                                        */
/* Page rendered at 1000 x 2000; editor stage is half as wide, so      */
/* fontScale = 0.5.                                                    */
/* ------------------------------------------------------------------ */
const page = { width: 1000, height: 2000, fontScale: 0.5 };
const baseStyle = {
  color: 'rgb(255, 255, 255)',
  backgroundColor: 'rgba(0, 0, 0, 0)',
  fontSizePx: 16,
  fontWeight: '400',
  fontStyle: 'normal',
  textAlign: 'left',
  borderRadius: '0px',
  opacity: 1,
  fontFamily: 'sans-serif',
  lineHeightPx: 24,
};

/* container with a background -> card behind its children */
{
  const { spec } = mapCandidate(
    {
      tag: 'section', text: '', container: true,
      rect: { left: 0, top: 0, width: 1000, height: 600 },
      style: { ...baseStyle, backgroundColor: 'rgb(17, 17, 17)' },
    },
    page
  );
  assert.equal(spec.type, 'card');
  assert.equal(spec.fields.bg, '#111111');
  assert.equal(spec.fields.anchor, 'top-left', 'imported elements anchor top-left');
  assert.equal(spec.fields.xPercent, 0);
  assert.equal(spec.fields.yPercent, 0);
  assert.equal(spec.fields.widthPercent, 100);
  assert.equal(spec.fields.heightPercent, 30, 'cards keep an explicit % height (600/2000)');
}

/* heading: position %, scaled font size, bold, alignment, colour */
{
  const { spec } = mapCandidate(
    {
      tag: 'h1', text: 'Welcome',
      rect: { left: 250, top: 100, width: 500, height: 60 },
      style: { ...baseStyle, fontSizePx: 40, fontWeight: '700', textAlign: 'center' },
    },
    page
  );
  assert.equal(spec.type, 'heading');
  assert.equal(spec.fields.xPercent, 25);
  assert.equal(spec.fields.yPercent, 5);
  assert.equal(spec.fields.widthPercent, 50);
  assert.equal(spec.fields.fontSize, 20, 'font size scaled by fontScale (40 * 0.5)');
  assert.equal(spec.fields.bold, true);
  assert.equal(spec.fields.textAlign, 'center');
  assert.equal(spec.fields.color, '#ffffff');
  assert.ok(!('heightPercent' in spec.fields), 'text-ish elements keep auto height (no clipping on reflow)');
  assert.ok(!('fontFamily' in spec.fields), 'generic font families are omitted, not undefined');
}

/* link with a background -> button, background mapped */
{
  const { spec } = mapCandidate(
    {
      tag: 'a', text: 'Buy now',
      rect: { left: 400, top: 900, width: 200, height: 50 },
      style: { ...baseStyle, backgroundColor: 'rgb(124, 58, 237)', borderRadius: '999px' },
    },
    page
  );
  assert.equal(spec.type, 'button');
  assert.equal(spec.fields.bg, '#7c3aed');
  assert.equal(spec.fields.radius, 999);
}

/* plain link (no background) -> text */
{
  const { spec } = mapCandidate(
    { tag: 'a', text: 'Read more', rect: { left: 0, top: 0, width: 100, height: 20 }, style: { ...baseStyle } },
    page
  );
  assert.equal(spec.type, 'text');
}

/* image: absolute src kept, frame height explicit, alt becomes label */
{
  const { spec } = mapCandidate(
    {
      tag: 'img', text: 'Hero', src: 'https://example.com/hero.png',
      rect: { left: 100, top: 400, width: 800, height: 400 },
      style: { ...baseStyle, borderRadius: '16px' },
    },
    page
  );
  assert.equal(spec.type, 'image');
  assert.equal(spec.fields.imageSrc, 'https://example.com/hero.png');
  assert.equal(spec.fields.heightPercent, 20, 'images keep an explicit % frame height');
  assert.equal(spec.fields.radius, 16);
  assert.equal(spec.fields.text, 'Hero');
}

/* image with an unresolvable relative src: imported, but no imageSrc
   (the editor/export falls back to the placeholder instead of a 404) */
{
  const { spec } = mapCandidate(
    {
      tag: 'img', text: '', src: './local.png',
      rect: { left: 0, top: 0, width: 300, height: 200 },
      style: { ...baseStyle },
    },
    page
  );
  assert.equal(spec.type, 'image');
  assert.ok(!('imageSrc' in spec.fields), 'bare relative src must not be kept');
  assert.equal(spec.fields.text, 'Image');
}

/* style mapping details: italic, opacity, font family, line height */
{
  const { spec } = mapCandidate(
    {
      tag: 'p', text: 'Fancy',
      rect: { left: 0, top: 0, width: 200, height: 30 },
      style: {
        ...baseStyle, fontStyle: 'italic', opacity: 0.6,
        fontFamily: '"Playfair Display", serif', fontSizePx: 20, lineHeightPx: 30,
      },
    },
    page
  );
  assert.equal(spec.fields.italic, true);
  assert.equal(spec.fields.opacity, 0.6);
  assert.equal(spec.fields.fontFamily, 'Playfair Display');
  assert.equal(spec.fields.lineHeight, 1.5);
}

/* skips: zero-size, fully transparent, empty text */
assert.equal(mapCandidate({ tag: 'p', text: 'x', rect: { left: 0, top: 0, width: 1, height: 1 }, style: { ...baseStyle } }, page).spec, null);
assert.equal(mapCandidate({ tag: 'p', text: 'x', rect: { left: 0, top: 0, width: 50, height: 20 }, style: { ...baseStyle, opacity: 0 } }, page).spec, null);
assert.equal(mapCandidate({ tag: 'p', text: '   ', rect: { left: 0, top: 0, width: 50, height: 20 }, style: { ...baseStyle } }, page).spec, null);

/* radius parsing */
assert.equal(parseRadiusPx('50%', 200), 999, '>=50% radius is a pill');
assert.equal(parseRadiusPx('16px', 200), 16);
assert.equal(parseRadiusPx('12px 12px 0px 0px', 200), 12, 'first corner wins');
assert.equal(parseRadiusPx('', 200), null);

/* whole conversion: counts, skipped, cap */
{
  const cands = [
    { tag: 'h1', text: 'T', rect: { left: 0, top: 0, width: 100, height: 20 }, style: { ...baseStyle } },
    { tag: 'p', text: '', rect: { left: 0, top: 0, width: 100, height: 20 }, style: { ...baseStyle } }, // skipped
  ];
  const out = candidatesToSpecs(cands, page);
  assert.equal(out.specs.length, 1);
  assert.equal(out.skipped, 1);
  assert.equal(out.truncated, false);
}
{
  const many = Array.from({ length: IMPORT_CAP + 10 }, (_, i) => ({
    tag: 'p', text: `Item ${i}`,
    rect: { left: 0, top: i * 10, width: 100, height: 10 },
    style: { ...baseStyle },
  }));
  const out = candidatesToSpecs(many, page);
  assert.equal(out.specs.length, IMPORT_CAP, 'import is capped');
  assert.equal(out.truncated, true);
  assert.equal(out.skipped, 10, 'overflow counts as skipped');
}

/* ------------------------------------------------------------------ */
/* entry-file picking + asset resolution                               */
/* ------------------------------------------------------------------ */
assert.equal(pickEntryFile(['site/index.html', 'site/style.css', 'site/hero.png']), 'site/index.html');
assert.equal(pickEntryFile(['a/b/page.html', 'x.html']), 'x.html', 'shallowest html wins');
assert.equal(pickEntryFile(['src/main.tsx', 'src/App.tsx', 'src/index.css']), 'src/App.tsx');
assert.equal(pickEntryFile(['src/main.tsx', 'src/pages/Home.jsx']), 'src/pages/Home.jsx');
assert.equal(pickEntryFile(['readme.md', 'photo.png']), null);

const assets = { 'img/hero.png': 'data:image/png;base64,AAA', 'style.css': 'x' };
assert.equal(resolveAssetSrc('./img/hero.png', assets), 'data:image/png;base64,AAA');
assert.equal(resolveAssetSrc('/img/hero.png', assets), 'data:image/png;base64,AAA');
assert.equal(resolveAssetSrc('hero.png', assets), 'data:image/png;base64,AAA', 'basename match');
assert.equal(resolveAssetSrc('missing.png', assets), '');
assert.equal(resolveAssetSrc('https://cdn.example.com/a.png', assets), 'https://cdn.example.com/a.png');

/* ------------------------------------------------------------------ */
/* zip reader: stored + deflated entries round-trip                    */
/* ------------------------------------------------------------------ */
function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name);
    const comp = e.method === 8 ? zlib.deflateRawSync(e.data) : e.data;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(e.method, 8);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, comp);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(e.method, 10);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

{
  const zip = buildZip([
    { name: 'site/index.html', data: Buffer.from('<h1>From zip</h1>'), method: 0 },
    { name: 'site/style.css', data: Buffer.from('h1 { color: red; }'), method: 8 },
    { name: 'site/img/', data: Buffer.alloc(0), method: 0 },
  ]);
  const entries = await readZipEntries(new Uint8Array(zip));
  assert.equal(entries.length, 2, 'directory entries are skipped');
  const byName = Object.fromEntries(entries.map((e) => [e.name, new TextDecoder().decode(e.data)]));
  assert.equal(byName['site/index.html'], '<h1>From zip</h1>', 'stored entry round-trips');
  assert.equal(byName['site/style.css'], 'h1 { color: red; }', 'deflated entry round-trips');
  assert.equal(pickEntryFile(entries.map((e) => e.name)), 'site/index.html');
  await assert.rejects(() => readZipEntries(new Uint8Array([1, 2, 3])), /Not a valid .zip/);
}

console.log('PASS: all Scenetics importer tests passed.');
console.log(' - JSX -> HTML: className, style objects, {"text"} expressions, handlers/imports stripped');
console.log(' - mapping: heading/button/image/card classification, anchor+% positions, style -> model fields');
console.log(' - skips (zero-size / transparent / empty), 60-element cap with truncation flag');
console.log(' - entry-file picking (index.html, App.tsx), relative image asset resolution');
console.log(' - zip reader: stored + deflate entries round-trip, invalid zip rejected');
