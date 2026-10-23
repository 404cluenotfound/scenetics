# Scenetics

**Scenes + Kinetics — scenes that move.**
Canva for frontend developers: drag, drop, and scroll-animate a landing page visually, then export real, clean React + Tailwind code.

> MVP / test version. Landing pages only.

## The idea

Most visual builders either lock you in or export messy code. And scroll
animations — the kind on premium product pages — are normally only reachable
by hand-writing GSAP ScrollTrigger numbers through trial and error, or by
prompting an AI, which is far too imprecise for precise movement ("a bit
more to the left, a bit slower…").

Scenetics' core feature is a **scroll-driven keyframe system**: pick any
card, image or element, set keyframes at different *scroll positions*, drag
the element into place at each one, and the exported code moves it as the
user scrolls. Scroll is the playhead — not time.

## Architecture

**Scene JSON is the single source of truth.** The canvas and the code panel
are two views of the same structured document:

```
scene JSON ──► canvas renderer   (what you drag)
          ──► deterministic code generator ──► Page.jsx + animations.css
```

There is **no LLM** in the drag → code path: live code is produced by a
pure, deterministic code generator (`client/src/lib/codegen.js`), so it is
instant, free, and always produces the same output for the same scene.
The LLM (Grok, via the server) is used only when the user explicitly asks
AI to *create* a component — and even then it returns structured element
JSON, which is validated before it enters the scene.

### The 5 binding constraints (see `ARCHITECTURE_CONSTRAINTS` in the project docs)

1. **No absolute-pixel exports.** Elements store a 9-point *anchor* plus
   percentage offsets. Exported positioning is always `%`, never `left: 420px`.
2. **No main-thread scroll jank.** Exports use the native CSS Scroll-Driven
   Animations API (`animation-timeline: scroll()`) on the compositor. No
   JavaScript scroll listener ever appears in generated code. The editor's
   scrub slider is a preview-only tool and is strictly separate.
3. **No transform collisions.** All of an element's motion tracks are
   merged: at every unique keyframe offset, every property is sampled and
   emitted once, using the standalone CSS properties `translate`, `rotate`,
   `scale` (plus `opacity`) — never competing `transform:` declarations.
4. **Scenes, not lone elements.** Multi-keyframe content lives in a Scene:
   a tall wrapper (`height: 300vh` — user-editable) with a
   `position: sticky; top: 0; height: 100vh` stage that stays in view while
   scrolling drives the keyframes.
5. **No div-soup.** Exported markup is flat and semantic (`<main>`,
   `<section>`, `<article>`, `<h2>`, `<p>`, `<button>`, `<figure>`), and all
   `@keyframes` live in one clean external `animations.css`. Exports also
   respect `prefers-reduced-motion`.

## Stack — MERN

| Part | Tech |
|---|---|
| Client | React + TypeScript + Vite + Tailwind CSS |
| Server | Node.js + Express |
| Database | MongoDB via Mongoose — the scene is stored as one native document |
| AI | Grok API (xAI), server-side only, OpenAI-compatible endpoint |
| Auth | Google OAuth (skeleton in MVP — see below) |

## Run it

```bash
# Client (editor)
cd client
npm install
npm run dev          # http://localhost:5173

# Server (API) — in a second terminal
cd server
cp .env.example .env # fill in what you have; everything degrades gracefully
npm install
npm start            # http://localhost:4000  — check GET /api/health
```

The client works **fully standalone** (local save + fallback AI generator)
if the server is not running.

### Tests

```bash
cd client
npm test             # codegen constraint tests (plain Node, no framework)
npm run build        # type-check + production build
```

## Environment variables (server/.env)

| Variable | Purpose |
|---|---|
| `PORT` | API port (default 4000) |
| `MONGODB_URI` | Mongo connection string. Server starts without it; `/api/projects` returns 503 until set. |
| `XAI_API_KEY` | Grok (xAI) key. Without it, `POST /api/ai/generate` returns 501 and the client uses its local fallback generator. |
| `XAI_MODEL` | Grok model name — default `grok-build-0.1` (xAI's coding model, cheapest; good fit for generating component JSON). Alternatives: `grok-4.7` (flagship), `grok-4.5`, `grok-4.20`, `grok-4.3`. Line-up checked Oct 2026. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google OAuth credentials. |
| `SESSION_SECRET` | Session signing secret (for when auth is fully wired). |
| `CLIENT_ORIGIN` | Client origin for CORS / redirects (default `http://localhost:5173`). |

## API

- `GET /api/health` — status incl. Mongo + AI configuration state
- `POST /api/projects` · `GET /api/projects` · `GET /api/projects/:id` · `PUT /api/projects/:id` · `DELETE /api/projects/:id`
- `POST /api/ai/generate` — `{ prompt }` → `{ elements: [...] }` (501 without `XAI_API_KEY`)
- `GET /auth/google`, `GET /auth/google/callback` — OAuth skeleton (501 until configured — honestly stubbed, not faked)

## What's MVP vs TODO

**Works in this MVP**
- 3-panel editor: palette + 4 native frames (Hero, Pricing, Features, CTA), drag-by-hand with anchor/% model, properties panel (text, colours, font size, radius, opacity, width, 9-point anchor)
- Scene with editable scroll length, scroll-scrub preview slider, per-element keyframe tracks (translateX/Y, scale, rotate, opacity) with add/list/delete
- Live Page.jsx + animations.css panel generated on every change, following all 5 constraints
- Dark **and** light themes (purple accent), persisted
- Save/load to localStorage + server save when reachable
- AI panel: Grok via server, with a working local fallback generator

**TODO / stubbed (labelled honestly)**
- Google login: routes exist, return 501 until OAuth credentials + code exchange are implemented; no per-user ownership enforcement on projects yet (auth middleware slot is ready in the projects router)
- Full-project zip download / GitHub push on export
- Layout compilation of positioned groups into Flex/Grid wrappers (constraint 1's advanced step) beyond percentage anchoring
- More export targets (plain HTML/CSS, Vue), multi-page sites, dashboards
- Domain/trademark check for the name "Scenetics" — preliminary web check 2026-10-23: no exact-match company or product found (only near-miss names like Synectics/Sentics/Scenics in unrelated industries). This is **not** a formal trademark clearance — get proper clearance before commercial launch.
