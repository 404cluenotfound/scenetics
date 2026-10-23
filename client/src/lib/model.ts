import type { Anchor, ElementType, Scene, SceneElement } from '../types';

let counter = 0;
export function uid(prefix = 'el'): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

const DEFAULTS: Record<ElementType, Partial<SceneElement>> = {
  heading: { text: 'Big Heading', color: '#ffffff', bg: '#7c3aed', fontSize: 40, radius: 0, widthPercent: 60, bold: true, textAlign: 'center', lineHeight: 1.25 },
  text: { text: 'Some supporting text goes here.', color: '#e5e5e5', bg: '#262626', fontSize: 16, radius: 0, widthPercent: 45, textAlign: 'center', lineHeight: 1.625 },
  button: { text: 'Get Started', color: '#ffffff', bg: '#7c3aed', fontSize: 16, radius: 999, widthPercent: 22, bold: true, textAlign: 'center' },
  card: { text: 'Card title — edit me', color: '#f5f5f5', bg: '#1f1f23', fontSize: 18, radius: 16, widthPercent: 28, shadow: 'lg', textAlign: 'left' },
  image: { text: 'Image', color: '#a78bfa', bg: '#2e1065', fontSize: 14, radius: 12, widthPercent: 30, textAlign: 'center' },
};

export function createElement(
  type: ElementType,
  overrides: Partial<SceneElement> = {}
): SceneElement {
  const d = DEFAULTS[type];
  return {
    id: uid(),
    type,
    text: d.text ?? 'Text',
    color: d.color ?? '#ffffff',
    bg: d.bg ?? '#7c3aed',
    fontSize: d.fontSize ?? 16,
    radius: d.radius ?? 0,
    opacity: 1,
    widthPercent: d.widthPercent ?? 30,
    heightPercent: null,
    anchor: 'center',
    xPercent: 50,
    yPercent: 50,
    tracks: {},
    // v0.2 editor-tool fields (defaults keep old scenes / AI output valid)
    baseRotate: 0,
    flipH: false,
    flipV: false,
    cropX: 50,
    cropY: 50,
    cropZoom: 1,
    imageSrc: '',
    locked: false,
    groupId: null,
    fontFamily: 'inherit',
    bold: d.bold ?? false,
    italic: false,
    underline: false,
    textAlign: d.textAlign ?? 'left',
    lineHeight: d.lineHeight ?? 1.4,
    letterSpacing: 0,
    borderWidth: 0,
    borderColor: '#ffffff',
    shadow: d.shadow ?? 'none',
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/* Migration — scenes saved before v0.2 (localStorage) lack the new    */
/* fields. Fill defaults underneath whatever the saved scene has so    */
/* nothing crashes and old projects keep working unchanged.            */
/* ------------------------------------------------------------------ */

export function migrateElement(raw: unknown): SceneElement | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const type = VALID_TYPES.includes(r.type as ElementType) ? (r.type as ElementType) : 'card';
  const base = createElement(type);
  const merged = { ...base, ...(r as Partial<SceneElement>) };
  if (!VALID_ANCHORS.includes(merged.anchor)) merged.anchor = 'center';
  if (!merged.tracks || typeof merged.tracks !== 'object') merged.tracks = {};
  if (typeof merged.heightPercent !== 'number') merged.heightPercent = null;
  if (typeof merged.baseRotate !== 'number') merged.baseRotate = 0;
  if (typeof merged.cropX !== 'number') merged.cropX = 50;
  if (typeof merged.cropY !== 'number') merged.cropY = 50;
  if (typeof merged.cropZoom !== 'number') merged.cropZoom = 1;
  return merged;
}

export function migrateScene(raw: unknown): Scene | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.elements)) return null;
  const elements = r.elements
    .map((e) => migrateElement(e))
    .filter((e): e is SceneElement => e !== null);
  return {
    id: typeof r.id === 'string' ? r.id : uid('scene'),
    name: typeof r.name === 'string' ? r.name : 'My Landing Page',
    scrollLengthVh: typeof r.scrollLengthVh === 'number' ? r.scrollLengthVh : 300,
    elements,
  };
}

export function createDefaultScene(): Scene {
  const heading = createElement('heading', {
    text: 'Scenes that move',
    anchor: 'center',
    xPercent: 50,
    yPercent: 38,
    tracks: {
      translateY: [
        { offset: 0, value: 40 },
        { offset: 100, value: 0 },
      ],
      opacity: [
        { offset: 0, value: 0 },
        { offset: 100, value: 1 },
      ],
    },
  });
  const button = createElement('button', {
    anchor: 'center',
    xPercent: 50,
    yPercent: 58,
    tracks: {
      scale: [
        { offset: 0, value: 0.8 },
        { offset: 100, value: 1 },
      ],
      opacity: [
        { offset: 0, value: 0 },
        { offset: 60, value: 1 },
        { offset: 100, value: 1 },
      ],
    },
  });
  return {
    id: uid('scene'),
    name: 'My Landing Page',
    scrollLengthVh: 300,
    elements: [heading, button],
  };
}

/* ------------------------------------------------------------------ */
/* Frames — curated ready-made sections, converted into NATIVE         */
/* editable elements (not locked blocks), per the product decisions.   */
/* ------------------------------------------------------------------ */

export interface Frame {
  name: string;
  description: string;
  build: () => SceneElement[];
}

export const FRAMES: Frame[] = [
  {
    name: 'Hero',
    description: 'Heading + subtext + CTA button',
    build: () => [
      createElement('heading', { text: 'Build something great', xPercent: 50, yPercent: 32, anchor: 'center' }),
      createElement('text', { text: 'The fastest way to launch your next idea, beautifully.', xPercent: 50, yPercent: 50, anchor: 'center' }),
      createElement('button', { text: 'Start Free', xPercent: 50, yPercent: 66, anchor: 'center' }),
    ],
  },
  {
    name: 'Pricing Cards',
    description: 'Three pricing tiers side by side',
    build: () => [
      createElement('card', { text: 'Starter — $9/mo', xPercent: 20, yPercent: 50, anchor: 'center', bg: '#1f1f23' }),
      createElement('card', { text: 'Pro — $29/mo', xPercent: 50, yPercent: 50, anchor: 'center', bg: '#7c3aed', color: '#ffffff' }),
      createElement('card', { text: 'Team — $79/mo', xPercent: 80, yPercent: 50, anchor: 'center', bg: '#1f1f23' }),
    ],
  },
  {
    name: 'Features',
    description: 'Heading + three feature cards',
    build: () => [
      createElement('heading', { text: 'Why us?', fontSize: 30, xPercent: 50, yPercent: 18, anchor: 'center' }),
      createElement('card', { text: 'Fast — ships in days', xPercent: 20, yPercent: 58, anchor: 'center' }),
      createElement('card', { text: 'Simple — no learning curve', xPercent: 50, yPercent: 58, anchor: 'center' }),
      createElement('card', { text: 'Yours — export the code', xPercent: 80, yPercent: 58, anchor: 'center' }),
    ],
  },
  {
    name: 'CTA Banner',
    description: 'Wide card with a call-to-action button',
    build: () => [
      createElement('card', { text: 'Ready to start?', fontSize: 22, widthPercent: 70, xPercent: 50, yPercent: 42, anchor: 'center', bg: '#4c1d95' }),
      createElement('button', { text: 'Get Started Now', xPercent: 50, yPercent: 64, anchor: 'center', bg: '#ffffff', color: '#4c1d95' }),
    ],
  },
];

/* ------------------------------------------------------------------ */
/* Validation / normalisation of AI-returned component JSON.           */
/* The server (Grok) and the local fallback both return element-ish    */
/* objects; nothing enters the scene without passing through here.     */
/* ------------------------------------------------------------------ */

const VALID_TYPES: ElementType[] = ['heading', 'text', 'button', 'card', 'image'];
const VALID_ANCHORS: Anchor[] = [
  'top-left', 'top-center', 'top-right',
  'center-left', 'center', 'center-right',
  'bottom-left', 'bottom-center', 'bottom-right',
];

function num(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  return Math.min(max, Math.max(min, n));
}

export function normaliseElement(raw: unknown, index = 0): SceneElement | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const type = VALID_TYPES.includes(r.type as ElementType) ? (r.type as ElementType) : 'card';
  const el = createElement(type, {
    text: typeof r.text === 'string' && r.text.trim() ? r.text.slice(0, 200) : undefined,
    color: typeof r.color === 'string' ? r.color : undefined,
    bg: typeof r.bg === 'string' ? r.bg : undefined,
    fontSize: num(r.fontSize, 16, 8, 96),
    radius: num(r.radius, 12, 0, 999),
    widthPercent: num(r.widthPercent, 30, 5, 95),
    anchor: VALID_ANCHORS.includes(r.anchor as Anchor) ? (r.anchor as Anchor) : 'center',
    // Stagger inserted elements so they don't stack exactly on top of each other.
    xPercent: num(r.xPercent, 50, 0, 100),
    yPercent: num(r.yPercent, 40 + index * 14, 0, 100),
  });
  return el;
}

export function normaliseElements(raw: unknown): SceneElement[] {
  const arr = Array.isArray(raw) ? raw : [];
  return arr.map((r, i) => normaliseElement(r, i)).filter((e): e is SceneElement => e !== null);
}

/* ------------------------------------------------------------------ */
/* Local fallback AI generator — keyword-based, used when the server   */
/* is unreachable or returns 501 (no Grok key configured). This keeps  */
/* the AI feature demonstrably working standalone.                      */
/* ------------------------------------------------------------------ */

export function localGenerate(prompt: string): SceneElement[] {
  const p = prompt.toLowerCase();
  if (p.includes('pricing') || p.includes('price') || p.includes('plan')) {
    return FRAMES[1].build();
  }
  if (p.includes('hero') || p.includes('banner') || p.includes('header')) {
    return FRAMES[0].build();
  }
  if (p.includes('feature')) {
    return FRAMES[2].build();
  }
  if (p.includes('cta') || p.includes('call to action') || p.includes('signup') || p.includes('sign up')) {
    return FRAMES[3].build();
  }
  if (p.includes('button')) {
    return [createElement('button', { text: prompt.slice(0, 40) || 'Click Me' })];
  }
  if (p.includes('heading') || p.includes('title')) {
    return [createElement('heading', { text: prompt.slice(0, 60) || 'Heading' })];
  }
  if (p.includes('image') || p.includes('photo') || p.includes('picture')) {
    return [createElement('image', {})];
  }
  // Default: a single card carrying the prompt as its text.
  return [createElement('card', { text: prompt.slice(0, 80) || 'New Card' })];
}
