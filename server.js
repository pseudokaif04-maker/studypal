const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || 'gemini-flash-lite-latest';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX, 10) || 30;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const MAX_NOTES_CHARS = 50000;
const MAX_PDF_BYTES = 20 * 1024 * 1024;

const PUBLIC_DIR = path.join(__dirname, 'public');

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const CHAT_PROMPT = [
  'You are StudyPal, a friendly study assistant made for college students.',
  'You explain concepts clearly and simply, building up from the basics.',
  'When answering, use these steps when they help:',
  '1. Give a short plain-English answer first.',
  '2. Explain why it works (the intuition behind it).',
  '3. Give one concrete example.',
  '4. End with a quick question to check the student understands.',
  'If a student asks to be quizzed, ask questions one at a time and gently correct wrong answers.',
  'Keep responses focused. Do not be overly long.',
].join('\n');

const SUMMARY_PROMPT = [
  'You are StudyPal, a study assistant. Turn the student\'s raw notes into clear study notes.',
  'Use short headings and bullet points. Include: key ideas, definitions, and one concrete example where useful.',
  'Keep it organized and skimmable. Do not invent facts that are not in the notes.',
].join('\n');

const FLASHCARDS_PROMPT = [
  'You are StudyPal, a study assistant. Turn the student\'s notes into exactly 6 to 10 high-quality flashcards.',
  'Respond with ONLY a JSON array and no other text. Each element must be an object with exactly:',
  '"front" (a short question, term, or prompt) and "back" (the concise answer or definition).',
  'Cover the most important ideas from the notes.',
].join('\n');

const QUIZ_PROMPT = [
  'You are StudyPal, a study assistant. Create a quiz of 5 questions from the student\'s notes.',
  'Respond with ONLY a JSON array and no other text. Each element must be an object with exactly:',
  '"question" (the question text), "options" (an array of exactly 4 strings),',
  '"answerIndex" (the index of the correct option, 0-3), and "explanation" (a one-sentence explanation).',
  'Mix recall questions with questions that test understanding.',
].join('\n');

const NOTES_CONFIGS = {
  summary: { prompt: SUMMARY_PROMPT, json: false, maxTokens: 2048 },
  flashcards: { prompt: FLASHCARDS_PROMPT, json: true, maxTokens: 2048 },
  quiz: { prompt: QUIZ_PROMPT, json: true, maxTokens: 2048 },
};

const rateLimit = new Map();

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimit.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimit.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return { allowed: true, remaining: RATE_LIMIT_MAX - 1 };
  }
  entry.count += 1;
  if (entry.count > RATE_LIMIT_MAX) {
    return { allowed: false, remaining: 0 };
  }
  return { allowed: true, remaining: RATE_LIMIT_MAX - entry.count };
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function serveStatic(res, pathname) {
  const filePath = pathname === '/' ? path.join(PUBLIC_DIR, 'index.html') : path.join(PUBLIC_DIR, pathname);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': CONTENT_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  return forwarded ? String(forwarded).split(',')[0].trim() : req.socket.remoteAddress || 'unknown';
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 200000) reject(new Error('Body too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function fetchGemini({ systemPrompt, contents, temperature, maxTokens, json, pdfBase64 }) {
  const response = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: pdfBase64
        ? [{ role: 'user', parts: [{ inlineData: { mimeType: 'application/pdf', data: pdfBase64 } }] }]
        : contents,
      generationConfig: {
        temperature: temperature ?? 0.7,
        maxOutputTokens: maxTokens ?? 1024,
        ...(json ? { responseMimeType: 'application/json' } : {}),
      },
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    const err = new Error(data.error?.message || `Gemini error ${response.status}`);
    err.status = response.status;
    throw err;
  }

  return data.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
}

function parseJsonArray(text) {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    const candidate = fenced ? fenced[1].trim() : trimmed;
    try {
      return JSON.parse(candidate);
    } catch {
      const start = candidate.indexOf('[');
      const end = candidate.lastIndexOf(']');
      if (start !== -1 && end > start) {
        return JSON.parse(candidate.slice(start, end + 1));
      }
      throw new Error('Could not parse JSON response');
    }
  }
}

async function handleChat(req, res, ip) {
  if (!GEMINI_API_KEY) {
    return sendJson(res, 500, { error: 'Server is not configured yet. Add GEMINI_API_KEY to .env' });
  }

  const limit = checkRateLimit(ip);
  if (!limit.allowed) {
    return sendJson(res, 429, { error: 'You reached the free hourly limit. Please try again in about an hour.' });
  }

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: 'Invalid request body' });
  }

  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!message) return sendJson(res, 400, { error: 'Message cannot be empty' });

  const history = Array.isArray(body.history) ? body.history : [];
  const messages = history.slice(-20).map((h) => ({
    role: h.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: String(h.text) }],
  }));
  messages.push({ role: 'user', parts: [{ text: message }] });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const params = new URLSearchParams({ key: GEMINI_API_KEY, alt: 'sse' });
  const streamUrl = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:streamGenerateContent?${params}`;

  try {
    const upstream = await fetch(streamUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: CHAT_PROMPT }] },
        contents: messages,
        generationConfig: { temperature: 0.7, maxOutputTokens: 1024 },
      }),
    });

    if (!upstream.ok || !upstream.body) {
      const data = await upstream.json().catch(() => ({}));
      res.write(`event: error\ndata: ${JSON.stringify({ error: data.error?.message || 'AI service error' })}\n\n`);
      return res.end();
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullReply = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data);
          const text = parsed.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
          if (text) {
            fullReply += text;
            res.write(`data: ${JSON.stringify({ text })}\n\n`);
          }
        } catch {
          // ignore malformed chunks
        }
      }
    }

    res.write(`event: done\ndata: ${JSON.stringify({ reply: fullReply, remaining: limit.remaining })}\n\n`);
    res.end();
  } catch (err) {
    console.error('Chat stream error:', err.message);
    if (!res.writableEnded) {
      res.write(`event: error\ndata: ${JSON.stringify({ error: 'AI service unavailable. Please try again.' })}\n\n`);
      res.end();
    }
  }
}

async function handleNotes(req, res, ip) {
  if (!GEMINI_API_KEY) {
    return sendJson(res, 500, { error: 'Server is not configured yet. Add GEMINI_API_KEY to .env' });
  }

  const limit = checkRateLimit(ip);
  if (!limit.allowed) {
    return sendJson(res, 429, { error: 'You reached the free hourly limit. Please try again in about an hour.' });
  }

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: 'Invalid request body' });
  }

  const text = typeof body.text === 'string' ? body.text.trim() : '';
  const action = typeof body.action === 'string' ? body.action : '';

  if (!text) return sendJson(res, 400, { error: 'Notes cannot be empty' });
  if (text.length > MAX_NOTES_CHARS) {
    return sendJson(res, 400, { error: 'Notes are too long. Please keep them under 50,000 characters.' });
  }

  const config = NOTES_CONFIGS[action];
  if (!config) return sendJson(res, 400, { error: 'Unknown action' });

  try {
    const raw = await fetchGemini({
      systemPrompt: config.prompt,
      contents: [{ role: 'user', parts: [{ text }] }],
      temperature: 0.4,
      maxTokens: config.maxTokens,
      json: config.json,
    });

    const payload = config.json ? parseJsonArray(raw) : raw;
    sendJson(res, 200, { result: payload, remaining: limit.remaining });
  } catch (err) {
    console.error('Notes error:', err.message);
    sendJson(res, 502, { error: 'Could not generate that. Please try again in a moment.' });
  }
}

async function handleNotesPdf(req, res, ip) {
  if (!GEMINI_API_KEY) {
    return sendJson(res, 500, { error: 'Server is not configured yet. Add GEMINI_API_KEY to .env' });
  }

  const limit = checkRateLimit(ip);
  if (!limit.allowed) {
    return sendJson(res, 429, { error: 'You reached the free hourly limit. Please try again in about an hour.' });
  }

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: 'Invalid request body' });
  }

  const data = typeof body.data === 'string' ? body.data : '';
  const action = typeof body.action === 'string' ? body.action : '';

  if (!data) return sendJson(res, 400, { error: 'No PDF received' });

  const pdfBytes = Buffer.byteLength(data, 'base64');
  if (pdfBytes > MAX_PDF_BYTES) {
    return sendJson(res, 400, { error: 'PDF is too large. Please use a PDF under 20MB.' });
  }

  const config = NOTES_CONFIGS[action];
  if (!config) return sendJson(res, 400, { error: 'Unknown action' });

  try {
    const raw = await fetchGemini({
      systemPrompt: config.prompt,
      pdfBase64: data,
      temperature: 0.4,
      maxTokens: config.maxTokens,
      json: config.json,
    });

    const payload = config.json ? parseJsonArray(raw) : raw;
    sendJson(res, 200, { result: payload, remaining: limit.remaining });
  } catch (err) {
    console.error('PDF notes error:', err.message);
    sendJson(res, 502, { error: 'Could not read that PDF. Make sure it is real PDF file with text (not scanned images).' });
  }
}

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);
  const ip = getClientIp(req);

  if (req.method === 'POST' && pathname === '/api/chat') {
    return handleChat(req, res, ip);
  }
  if (req.method === 'POST' && pathname === '/api/notes') {
    return handleNotes(req, res, ip);
  }
  if (req.method === 'POST' && pathname === '/api/notes-pdf') {
    return handleNotesPdf(req, res, ip);
  }
  if (req.method === 'GET') {
    return serveStatic(res, pathname);
  }
  res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Method not allowed');
});

server.listen(PORT, () => {
  console.log(`StudyPal is running at http://localhost:${PORT}`);
});