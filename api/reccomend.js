// Serverless endpoint that reads the OpenAI key from an env var OR from a secret file.
// It looks for, in order:
// 1) process.env.OPENAI_API_KEY
// 2) process.env.OPEN_AI_KEY
// 3) a filepath in process.env.OPEN_AI_KEY_FILE
// 4) a file at ./OPEN_AI_KEY (useful for mounting a secret file in deployments)
// 5) a Docker/Swarm style secret at /run/secrets/OPEN_AI_KEY
//
// Usage:
// - Preferred: set OPENAI_API_KEY in your host/environment (Vercel/Netlify/Cloud Run).
// - If you keep a secret file named OPEN_AI_KEY in a secrets repo, mount or copy that file
//   into the runtime (for example into the function container) and set OPEN_AI_KEY_FILE to its path
//   or leave it at ./OPEN_AI_KEY so this function will pick it up.
//
// NOTE: Do NOT commit secret files to a public repo. Use environment variables or provider secrets.
const fs = require('fs');

const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

function tryReadFileSync(path) {
  try {
    const s = fs.readFileSync(path, 'utf8').trim();
    if (s) return s;
  } catch (e) {
    // ignore
  }
  return null;
}

async function getApiKey() {
  // 1. explicit env var
  if (process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim()) {
    return process.env.OPENAI_API_KEY.trim();
  }
  // 2. alternate env var name (your secret file name value could be injected as an env var)
  if (process.env.OPEN_AI_KEY && process.env.OPEN_AI_KEY.trim()) {
    return process.env.OPEN_AI_KEY.trim();
  }
  // 3. file path provided via env
  if (process.env.OPEN_AI_KEY_FILE) {
    const fromFile = tryReadFileSync(process.env.OPEN_AI_KEY_FILE);
    if (fromFile) return fromFile;
  }
  // 4. default local file name (useful if you mount the secret file at runtime)
  const fromLocal = tryReadFileSync('./OPEN_AI_KEY');
  if (fromLocal) return fromLocal;
  // 5. docker secret location
  const fromRunSecrets = tryReadFileSync('/run/secrets/OPEN_AI_KEY');
  if (fromRunSecrets) return fromRunSecrets;

  return null;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).send('Method not allowed');

  // read JSON body (works for many serverless platforms; fallback to manual parsing)
  let body = req.body;
  if (!body || Object.keys(body).length === 0) {
    body = await new Promise((resolve) => {
      let d = '';
      req.on('data', c => d += c);
      req.on('end', () => {
        try { resolve(JSON.parse(d || '{}')); } catch(e) { resolve({}); }
      });
      req.on('error', () => resolve({}));
    });
  }

  const answers = body.answers || {};

  const OPENAI_KEY = await getApiKey();

  // fallback deterministic heuristic if no key provided (safe for local testing)
  if (!OPENAI_KEY) {
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
explain why in 2-4 short bullet reasons, and list 3 cities with a brief reason for each.
Return a strict JSON object ONLY (no extra commentary).`;

  const user = `User answers (JSON): ${JSON.stringify(answers)}.
Return JSON with keys:
- country: string (one of "Costa Rica","Panama","Belize")
- score: integer 0-100 (confidence)
- reasons: array of short strings (2-4)
- cities: array of { name: string, reason: string } (3 entries)
Keep outputs short and concise.`;

  try {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
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
      console.error('OpenAI error:', txt);
      return res.status(502).send('OpenAI API error');
    }

    const j = await resp.json();
    const assistant = j.choices?.[0]?.message?.content || '';

    // Try parse JSON substring
    try {
      const start = assistant.indexOf('{');
      const jsonText = start >= 0 ? assistant.slice(start) : assistant;
      const parsed = JSON.parse(jsonText);
      return res.status(200).json(parsed);
    } catch (err) {
      // If parsing fails, return raw assistant content so the frontend can display it
      return res.status(200).json({ text: assistant });
    }
  } catch (err) {
    console.error('Server error:', err);
    return res.status(500).send('Server error');
  }
};
