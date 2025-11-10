// api/recommend.js
// Robust serverless endpoint for /api/recommend
// Place at <repo root>/api/recommend.js for Vercel.
// NOTE: remove verbose debug responses in production.

const fs = require('fs');

function tryReadFileSync(path) {
  try {
    const s = fs.readFileSync(path, 'utf8').trim();
    if (s) return s;
  } catch (e) { /* ignore */ }
  return null;
}

async function getApiKey() {
  if (process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim()) return process.env.OPENAI_API_KEY.trim();
  if (process.env.OPEN_AI_KEY && process.env.OPEN_AI_KEY.trim()) return process.env.OPEN_AI_KEY.trim();
  if (process.env.OPEN_AI_KEY_FILE) {
    const fromFile = tryReadFileSync(process.env.OPEN_AI_KEY_FILE);
    if (fromFile) return fromFile;
  }
  const fromLocal = tryReadFileSync('./OPEN_AI_KEY');
  if (fromLocal) return fromLocal;
  const fromRunSecrets = tryReadFileSync('/run/secrets/OPEN_AI_KEY');
  if (fromRunSecrets) return fromRunSecrets;
  return null;
}

async function getFetch() {
  if (typeof globalThis.fetch === 'function') return globalThis.fetch;
  // fallback to node-fetch if fetch isn't present
  try {
    const { default: nodeFetch } = await import('node-fetch');
    return nodeFetch;
  } catch (err) {
    throw new Error('No fetch available and node-fetch failed to import: ' + String(err));
  }
}

async function readJsonBody(req) {
  if (req.body && Object.keys(req.body).length) return req.body;
  return await new Promise((resolve) => {
    let d = '';
    req.on('data', c => d += c);
    req.on('end', () => {
      try { resolve(JSON.parse(d || '{}')); }
      catch (e) { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  let body = await readJsonBody(req);
  const answers = body.answers || {};

  // get API key
  const OPENAI_KEY = await getApiKey();

  // If no key, return the deterministic fallback so you can test without a key.
  if (!OPENAI_KEY) {
    console.warn('No OpenAI key found; returning fallback recommendation for debugging.');
    const dests = Array.isArray(answers.destinations) ? answers.destinations : (answers.destinations ? [answers.destinations] : []);
    const relocation = answers.relocationType || '';
    let pick = 'Costa Rica';
    if (dests.includes('panama')) pick = 'Panama';
    else if (dests.includes('belize')) pick = 'Belize';
    else if (relocation && relocation.includes('work')) pick = 'Panama';
    const fallback = {
      country: pick,
      score: 75,
      reasons: [
        `Based on your selections, ${pick} aligns best with your priorities.`,
        'Good balance of lifestyle, services, and accessibility for your needs.'
      ],
      cities: [
        { name: pick === 'Costa Rica' ? 'San José' : pick === 'Panama' ? 'Panama City' : 'Belize City', reason: 'Main hub with services' },
        { name: pick === 'Costa Rica' ? 'Guanacaste' : pick === 'Panama' ? 'Boquete' : 'San Pedro', reason: 'Popular expat/retirement spot' },
        { name: pick === 'Costa Rica' ? 'La Fortuna' : pick === 'Panama' ? 'David' : 'Caye Caulker', reason: 'Leisure and nature options' }
      ]
    };
    return res.status(200).json(fallback);
  }

  // Build the prompt
  const system = `You are a concise relocation advisor expert for Costa Rica, Panama, and Belize.
Given a user's structured answers, pick the single best country (Costa Rica, Panama, or Belize),
explain why in 2-4 short bullet reasons, and list 3 cities with a brief reason for each. Put a disclaimer that this is only a suggestion and that speaking with a representative is important.
Return a strict JSON object ONLY (no extra commentary).`;

  const user = `User answers (JSON): ${JSON.stringify(answers)}.
Return JSON with keys:
- country: string (one of "Costa Rica","Panama","Belize")
- score: integer 0-100 (confidence)
- reasons: array of short strings (2-4)
- cities: array of { name: string, reason: string } (3 entries)
Keep outputs short and concise.`;

  try {
    const fetchFn = await getFetch();
    const resp = await fetchFn('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-3.5-turbo',
        temperature: 0.35,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ],
        max_tokens: 400
      })
    });

    if (!resp.ok) {
      const txt = await resp.text();
      console.error('OpenAI API error:', resp.status, txt);
      return res.status(502).json({ error: 'OpenAI API error', status: resp.status, body: txt });
    }

    const j = await resp.json();
    const assistant = j.choices?.[0]?.message?.content || '';

    try {
      const start = assistant.indexOf('{');
      const jsonText = start >= 0 ? assistant.slice(start) : assistant;
      const parsed = JSON.parse(jsonText);
      return res.status(200).json(parsed);
    } catch (err) {
      // parsing failed -> return assistant text so frontend can show it
      console.warn('Failed to parse assistant JSON; returning text. Assistant output:', assistant);
      return res.status(200).json({ text: assistant });
    }
  } catch (err) {
    console.error('Server error in recommend function:', err && err.stack ? err.stack : String(err));
    return res.status(500).json({ error: 'Server error', message: String(err) });
  }
};
