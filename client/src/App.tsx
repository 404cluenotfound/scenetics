import { useEffect, useMemo, useRef, useState } from 'react';
import type { Anchor, ElementType, MotionState, Scene, SceneElement, TrackProp } from './types';
import { generateAnimationsCss, generatePageJsx, sampleElementAt, collectOffsets, anchorTranslate, TRACK_DEFAULTS } from './lib/codegen.js';
import { createDefaultScene, createElement, FRAMES, localGenerate, normaliseElements, uid } from './lib/model';

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

export default function App() {
  const [scene, setScene] = useState<Scene>(() => {
    try {
      const raw = localStorage.getItem(LS_SCENE);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.elements)) return parsed as Scene;
      }
    } catch { /* fall through to default */ }
    return createDefaultScene();
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [scrollPct, setScrollPct] = useState(0);
  const [theme, setTheme] = useState<string>(() => localStorage.getItem(LS_THEME) || 'dark');
  const [codeTab, setCodeTab] = useState<'jsx' | 'css'>('jsx');
  const [motionDraft, setMotionDraft] = useState<MotionState>({ ...TRACK_DEFAULTS } as MotionState);
  const [aiPrompt, setAiPrompt] = useState('');
  const [status, setStatus] = useState('');
  const stageRef = useRef<HTMLDivElement>(null);

  const selected = scene.elements.find((e) => e.id === selectedId) || null;

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(LS_THEME, theme);
  }, [theme]);

  // When the selection or the scrub position changes, show the element's
  // sampled (interpolated) motion state in the Motion panel.
  useEffect(() => {
    if (selected) setMotionDraft(sampleElementAt(selected, scrollPct));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, scrollPct]);

  const pageJsx = useMemo(() => generatePageJsx(scene), [scene]);
  const animCss = useMemo(() => generateAnimationsCss(scene), [scene]);

  /* ---------------- scene mutation helpers ---------------- */
  const updateElement = (id: string, patch: Partial<SceneElement>) =>
    setScene((s) => ({ ...s, elements: s.elements.map((e) => (e.id === id ? { ...e, ...patch } : e)) }));

  const addElement = (el: SceneElement) => {
    setScene((s) => ({ ...s, elements: [...s.elements, el] }));
    setSelectedId(el.id);
  };

  const addFromPalette = (type: ElementType) => addElement(createElement(type));

  const addFrame = (build: () => SceneElement[]) => {
    const els = build();
    setScene((s) => ({ ...s, elements: [...s.elements, ...els] }));
    if (els[0]) setSelectedId(els[0].id);
    setStatus(`Frame added: ${els.length} editable elements.`);
  };

  /* ---------------- dragging (editor only) ----------------
     The model stores anchor + percent offsets (constraint 1).
     Pointer deltas in the stage are converted to percentages of the
     stage size before touching the model — raw px never gets stored. */
  const startDrag = (ev: React.PointerEvent, el: SceneElement) => {
    ev.preventDefault();
    ev.stopPropagation();
    setSelectedId(el.id);
    const stage = stageRef.current;
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    const startX = ev.clientX;
    const startY = ev.clientY;
    const origX = el.xPercent;
    const origY = el.yPercent;
    const onMove = (mv: PointerEvent) => {
      const dxPct = ((mv.clientX - startX) / rect.width) * 100;
      const dyPct = ((mv.clientY - startY) / rect.height) * 100;
      updateElement(el.id, {
        xPercent: Math.round(Math.min(100, Math.max(0, origX + dxPct)) * 10) / 10,
        yPercent: Math.round(Math.min(100, Math.max(0, origY + dyPct)) * 10) / 10,
      });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  /* ---------------- scroll keyframes ---------------- */
  const addKeyframe = () => {
    if (!selected) return;
    const offset = Math.round(scrollPct);
    const tracks = { ...(selected.tracks || {}) } as SceneElement['tracks'];
    for (const prop of TRACK_PROPS) {
      const list = (tracks[prop] || []).filter((k) => k.offset !== offset);
      list.push({ offset, value: Math.round(motionDraft[prop] * 1000) / 1000 });
      list.sort((a, b) => a.offset - b.offset);
      tracks[prop] = list;
    }
    updateElement(selected.id, { tracks });
    setStatus(`Keyframe added at scroll ${offset}% for “${selected.text.slice(0, 24)}”.`);
  };

  const deleteKeyframe = (offset: number) => {
    if (!selected) return;
    const tracks = { ...(selected.tracks || {}) } as SceneElement['tracks'];
    for (const prop of TRACK_PROPS) {
      tracks[prop] = (tracks[prop] || []).filter((k) => k.offset !== offset);
      if (tracks[prop]!.length === 0) delete tracks[prop];
    }
    updateElement(selected.id, { tracks });
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
        setScene(JSON.parse(raw));
        setStatus('Loaded from local storage.');
      } else setStatus('Nothing saved locally yet.');
    } catch { setStatus('Local save was corrupted — keeping current scene.'); }
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
    const m = hasTracks
      ? sampleElementAt(el, scrollPct)
      : { translateX: 0, translateY: 0, scale: 1, rotate: 0, opacity: el.opacity };
    const a = anchorTranslate(el.anchor);
    const isSel = el.id === selectedId;
    const style: React.CSSProperties = {
      position: 'absolute',
      left: `${el.xPercent}%`,
      top: `${el.yPercent}%`,
      width: `${el.widthPercent}%`,
      transform: `translate(${a.x}%, ${a.y}%) translate(${m.translateX}px, ${m.translateY}px) rotate(${m.rotate}deg) scale(${m.scale})`,
      opacity: m.opacity,
      color: el.color,
      backgroundColor: el.type === 'card' || el.type === 'button' || el.type === 'image' ? el.bg : 'transparent',
      fontSize: el.fontSize,
      borderRadius: el.radius,
      padding: el.type === 'card' ? 20 : el.type === 'button' ? '10px 20px' : 0,
      cursor: 'grab',
      userSelect: 'none',
      outline: isSel ? '2px solid #7c3aed' : 'none',
      outlineOffset: 2,
      textAlign: el.type === 'heading' || el.type === 'text' ? 'center' as const : undefined,
      margin: 0,
      boxSizing: 'border-box',
    };
    if (el.type === 'image') {
      return (
        <figure key={el.id} style={{ ...style, aspectRatio: '4 / 3', display: 'flex', alignItems: 'center', justifyContent: 'center', border: '2px dashed #7c3aed' }}
          onPointerDown={(e) => startDrag(e, el)}>
          🖼 {el.text}
        </figure>
      );
    }
    const Tag = (el.type === 'heading' ? 'h2' : el.type === 'text' ? 'p' : el.type === 'button' ? 'button' : 'article') as any;
    return (
      <Tag key={el.id} style={style} onPointerDown={(e: React.PointerEvent) => startDrag(e, el)}>
        {el.text}
      </Tag>
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

  return (
    <div className="flex flex-col h-full">
      {/* ---------- top bar ---------- */}
      <header className="panel flex items-center gap-3 px-4 py-2 border-b flex-wrap">
        <div className="font-bold text-lg" style={{ color: '#a78bfa' }}>Scenetics</div>
        <span className="muted text-xs hidden md:inline">Scenes that move — drag, scroll-animate, export real code.</span>
        <div className="flex-1" />
        <label className="lbl" style={{ margin: 0 }}>Scene scroll length (vh)</label>
        <input type="number" min={100} max={1000} step={50} value={scene.scrollLengthVh}
          onChange={(e) => setScene((s) => ({ ...s, scrollLengthVh: Number(e.target.value) || 300 }))}
          className="input" style={{ width: 90 }} />
        <button className="btn" onClick={save}>Save</button>
        <button className="btn" onClick={loadLocal}>Load</button>
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
          <div className="panel border-b px-4 py-2 flex items-center gap-3">
            <label className="lbl" style={{ margin: 0, whiteSpace: 'nowrap' }}>↕ Scroll scrub — {Math.round(scrollPct)}%</label>
            <input type="range" min={0} max={100} step={0.5} value={scrollPct}
              onChange={(e) => setScrollPct(Number(e.target.value))}
              className="flex-1 accent-violet-600" />
            <span className="muted text-xs">Editor preview only — exported code uses native CSS scroll timelines, no JS.</span>
          </div>
          <div className="flex-1 p-4 overflow-auto" style={{ background: 'var(--bg)' }}>
            <div ref={stageRef} onPointerDown={() => setSelectedId(null)}
              style={{ position: 'relative', width: '100%', height: '100%', minHeight: 420, background: 'var(--stage-bg)', borderRadius: 12, overflow: 'hidden' }}>
              {scene.elements.map(renderElement)}
              {scene.elements.length === 0 && (
                <p className="muted" style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  Add a component or a frame to start.
                </p>
              )}
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

        {/* ---------- right panel: properties ---------- */}
        <aside className="panel border-l p-3 overflow-y-auto" style={{ width: 260 }}>
          {!selected ? (
            <p className="muted text-sm">Select an element on the canvas to edit it, move it, and add scroll keyframes.</p>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <div className="font-semibold text-sm capitalize">{selected.type}</div>
                <div className="flex gap-1">
                  <button className="btn" onClick={() => addElement({ ...selected, id: uid(), xPercent: Math.min(100, selected.xPercent + 4), yPercent: Math.min(100, selected.yPercent + 4) })}>Duplicate</button>
                  <button className="btn" onClick={() => { setScene((s) => ({ ...s, elements: s.elements.filter((e) => e.id !== selected.id) })); setSelectedId(null); }}>Delete</button>
                </div>
              </div>

              <div>
                <label className="lbl">Text</label>
                <textarea className="input" rows={2} value={selected.text} onChange={(e) => updateElement(selected.id, { text: e.target.value })} />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="lbl">Text colour</label>
                  <input type="color" value={selected.color} onChange={(e) => updateElement(selected.id, { color: e.target.value })} className="w-full" />
                </div>
                <div>
                  <label className="lbl">Background</label>
                  <input type="color" value={selected.bg} onChange={(e) => updateElement(selected.id, { bg: e.target.value })} className="w-full" />
                </div>
                <div>
                  <label className="lbl">Font size (px)</label>
                  <input type="number" min={8} max={96} value={selected.fontSize} onChange={(e) => updateElement(selected.id, { fontSize: Number(e.target.value) || 16 })} className="input" />
                </div>
                <div>
                  <label className="lbl">Corner radius</label>
                  <input type="number" min={0} max={999} value={selected.radius} onChange={(e) => updateElement(selected.id, { radius: Number(e.target.value) || 0 })} className="input" />
                </div>
              </div>
              <div>
                <label className="lbl">Base opacity: {selected.opacity}</label>
                <input type="range" min={0} max={1} step={0.05} value={selected.opacity}
                  onChange={(e) => updateElement(selected.id, { opacity: Number(e.target.value) })} className="w-full accent-violet-600" />
              </div>
              <div>
                <label className="lbl">Width (% of stage): {selected.widthPercent}</label>
                <input type="range" min={5} max={95} step={1} value={selected.widthPercent}
                  onChange={(e) => updateElement(selected.id, { widthPercent: Number(e.target.value) })} className="w-full accent-violet-600" />
              </div>

              <div>
                <label className="lbl">Anchor — which point of the element sits at its position (exported as % offsets, never px)</label>
                <div className="grid grid-cols-3 gap-1" style={{ width: 96 }}>
                  {ANCHORS.map((a) => (
                    <button key={a} title={a} className="btn" style={{ height: 26, padding: 0, background: selected.anchor === a ? '#7c3aed' : undefined, color: selected.anchor === a ? '#fff' : undefined }}
                      onClick={() => updateElement(selected.id, { anchor: a })}>•</button>
                  ))}
                </div>
                <div className="muted" style={{ fontSize: 11 }}>
                  {selected.anchor} · x {selected.xPercent}% · y {selected.yPercent}%
                </div>
              </div>

              <hr style={{ borderColor: 'var(--border)', width: '100%' }} />
              <div className="font-semibold text-sm">Motion at scroll {Math.round(scrollPct)}%</div>
              <p className="muted" style={{ fontSize: 11, margin: 0 }}>
                Set the look at this scroll position, then add a keyframe. Scrub to another %, change it, add another — the element moves as the user scrolls.
              </p>
              {motionField('Move X (px)', 'translateX', -400, 400, 1)}
              {motionField('Move Y (px)', 'translateY', -400, 400, 1)}
              {motionField('Scale', 'scale', 0, 3, 0.05)}
              {motionField('Rotate (deg)', 'rotate', -180, 180, 1)}
              {motionField('Opacity', 'opacity', 0, 1, 0.05)}
              <button className="btn btn-accent" onClick={addKeyframe}>◆ Add keyframe at {Math.round(scrollPct)}%</button>

              <div>
                <label className="lbl">Keyframes</label>
                {collectOffsets(selected).length === 0 && <div className="muted" style={{ fontSize: 11 }}>None yet.</div>}
                <div className="flex flex-col gap-1">
                  {collectOffsets(selected).map((off) => (
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
    </div>
  );
}
