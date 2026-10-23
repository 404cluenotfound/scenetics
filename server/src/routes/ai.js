import { Router } from 'express';

export const aiRouter = Router();

/**
 * POST /api/ai/generate  { prompt: string }
 * -> { elements: [ <element JSON in the client's internal schema> ] }
 *
 * Uses the Grok API (xAI) — OpenAI-compatible chat completions.
 * The API key lives ONLY on the server (never in the browser or exports).
 *
 * If XAI_API_KEY is not set, returns 501 — the client then falls back to
 * its built-in local generator, so the editor still works standalone.
 *
 * NOTE: XAI_MODEL comes from the environment. The placeholder default
 * below ('grok-beta') may not be a current model name — set XAI_MODEL in
 * server/.env to a current Grok model before relying on live AI.
 */
const SYSTEM_PROMPT = `You are Scenetics' component generator. Reply with ONLY valid JSON, no markdown, no commentary.
Shape: {"elements": [ELEMENT, ...]} — generate 1 to 4 elements.
ELEMENT fields:
- "type": one of "heading" | "text" | "button" | "card" | "image"
- "text": string (the visible text)
- "color": hex text colour, e.g. "#ffffff"
- "bg": hex background colour, e.g. "#7c3aed"
- "fontSize": number 8..96
- "radius": number 0..999 (border radius px)
- "widthPercent": number 5..95
- "anchor": one of "top-left","top-center","top-right","center-left","center","center-right","bottom-left","bottom-center","bottom-right"
- "xPercent": number 0..100, "yPercent": number 0..100 (position as % of the stage)
Use a purple-accent dark theme unless the user asks otherwise.`;

function extractJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { return JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
    }
    return null;
  }
}

aiRouter.post('/generate', async (req, res) => {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) {
    return res.status(501).json({ error: 'XAI_API_KEY not configured' });
  }
  const prompt = (req.body && req.body.prompt) || '';
  if (!prompt.trim()) return res.status(400).json({ error: 'prompt is required' });

  const model = process.env.XAI_MODEL || 'grok-beta'; // placeholder — set XAI_MODEL in .env
  try {
    const response = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
        temperature: 0.4,
      }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      return res.status(502).json({ error: `Grok API error (${response.status})`, detail: detail.slice(0, 300) });
    }
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '';
    const parsed = extractJson(content);
    if (!parsed || !Array.isArray(parsed.elements)) {
      return res.status(502).json({ error: 'Grok returned unparseable output' });
    }
    // The client re-validates/normalises every element before inserting it.
    return res.json({ elements: parsed.elements });
  } catch (err) {
    return res.status(502).json({ error: `Failed to reach Grok API: ${err.message}` });
  }
});
