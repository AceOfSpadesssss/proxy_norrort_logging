require('dotenv').config();
const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const multer = require('multer');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
const upload = multer({ limits: { fileSize: 25 * 1024 * 1024 } }); // 25MB limit

// Accept ALL payload types (JSON, Form Data, Text, and Raw Binary Blobs)
app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));
app.use(express.text({ limit: '25mb' }));
app.use(express.raw({ limit: '25mb', type: ['image/*', 'application/octet-stream'] }));

const CONFIG = {
  ZIPLINE_URL: process.env.ZIPLINE_URL || 'http://localhost:3000', // Internal Docker URL
  ZIPLINE_TOKEN: (process.env.ZIPLINE_TOKEN || '').trim(), // Sanitized Zipline token
  ZIPLINE_PUBLIC_URL: process.env.ZIPLINE_PUBLIC_URL || 'http://192.168.8.6:3000', // External Zipline URL
  LOKI_URL: process.env.LOKI_URL || 'http://localhost:3100',
  PORT: process.env.PORT || 8080,
  PUBLIC_URL: process.env.PUBLIC_URL || 'http://192.168.8.6:8080'
};

// Map to store valid single-use upload tokens (Token -> Expiration Timestamp)
const validTokens = new Map();

// Automatically purge expired tokens every 60 seconds
setInterval(() => {
  const now = Date.now();
  for (const [token, expiresAt] of validTokens.entries()) {
    if (now > expiresAt) validTokens.delete(token);
  }
}, 60000);

// Helper to safely parse Zipline responses and convert internal Docker URLs to public URLs
function parseZiplineResponse(filesArray) {
  if (!filesArray || filesArray.length === 0) throw new Error("No file returned from Zipline");
  const fileData = filesArray[0];
  
  const rawUrl = typeof fileData === 'string' ? fileData : fileData.url;
  const id = typeof fileData === 'string' ? rawUrl.split('/').pop() : fileData.id;

  // Replace internal Docker container host with public Zipline URL
  const publicUrl = rawUrl.replace(CONFIG.ZIPLINE_URL, CONFIG.ZIPLINE_PUBLIC_URL);

  return { url: publicUrl, id };
}

// ---------------------------------------------------------
// MIDDLEWARE
// ---------------------------------------------------------

// One-time token validator for presigned uploads
function validateOneTimeToken(req, res, next) {
  const token = req.query.token;

  if (token) {
    if (!validTokens.has(token)) {
      return res.status(403).json({ status: 'error', message: 'Invalid or already used presigned URL token' });
    }

    const expiresAt = validTokens.get(token);
    validTokens.delete(token); // Burn token immediately after single use

    if (Date.now() > expiresAt) {
      return res.status(403).json({ status: 'error', message: 'Presigned URL token has expired' });
    }
  } else if (req.path.includes('/upload')) {
    // Enforcement: /api/v*/upload endpoints MUST supply a valid presigned token
    return res.status(403).json({ status: 'error', message: 'Missing presigned URL token' });
  }

  next();
}

// ---------------------------------------------------------
// HANDLERS
// ---------------------------------------------------------

// Universal Upload Handler
async function handleUniversalUpload(req, res) {
  try {
    const form = new FormData();
    const body = req.body || {};
    const file = req.file || (req.files && req.files[0]);

    if (file) {
      form.append('file', file.buffer, {
        filename: file.originalname || 'screenshot.webp',
        contentType: file.mimetype || 'image/webp',
      });
    } else if (Buffer.isBuffer(body)) {
      form.append('file', body, { filename: 'screenshot.webp', contentType: 'image/webp' });
    } else if (typeof body === 'string') {
      const cleanBase64 = body.replace(/^data:image\/\w+;base64,/, '');
      const buffer = Buffer.from(cleanBase64, 'base64');
      form.append('file', buffer, { filename: 'screenshot.webp', contentType: 'image/webp' });
    } else if (body.base64 || body.image) {
      const rawBase64 = body.base64 || body.image;
      const cleanBase64 = rawBase64.replace(/^data:image\/\w+;base64,/, '');
      const buffer = Buffer.from(cleanBase64, 'base64');
      form.append('file', buffer, { filename: body.filename || 'screenshot.webp', contentType: 'image/webp' });
    } else {
      return res.status(400).json({ status: 'error', message: 'No valid file, base64, or blob payload found' });
    }

    const ziplineRes = await axios.post(`${CONFIG.ZIPLINE_URL}/api/upload`, form, {
      headers: { ...form.getHeaders(), Authorization: CONFIG.ZIPLINE_TOKEN },
    });

    const { url, id } = parseZiplineResponse(ziplineRes.data.files);
    return res.json({ status: 'ok', data: { url, id } });
  } catch (err) {
    const errorMsg = err.response?.data?.error || err.message;
    console.error('[Proxy Error] Upload Failed:', errorMsg);
    return res.status(500).json({ status: 'error', message: `Zipline error: ${errorMsg}` });
  }
}

// Grafana Loki Logging Handler
// Enhanced Grafana Loki Logging Handler to support custom Lua payloads
async function handleLokiLogging(req, res) {
  try {
    const body = req.body || {};

    // 1. Extract core fields from Lua payload
    const script = body.script || body.source || 'unknown_script';
    const message = body.message || 'No message provided';
    const event = body.event || 'ospecificerad';
    
    // Map custom FiveM log types ('normal' / 'important') to standard log levels
    let level = body.level || body.type || 'info';
    if (level === 'normal') level = 'info';
    if (level === 'important') level = 'warn';

    // 2. Extract player, args, and image data
    const player = body.player || null;
    const args = body.args || null;
    const image = body.image || null;

    // Generate nanosecond timestamp for Loki
    const nanoTimestamp = (BigInt(Date.now()) * 1000000n).toString();

    // 3. Construct Loki Stream Payload
    const lokiPayload = {
      streams: [{
        stream: {
          app: 'fivem',
          script: String(script),
          event: String(event),
          level: String(level)
        },
        values: [[
          nanoTimestamp,
          JSON.stringify({
            message,
            script,
            event,
            level,
            ...(player ? { player } : {}),
            ...(args ? { args } : {}),
            ...(image ? { image } : {}),
            ...(body.metadata || {})
          })
        ]]
      }]
    };

    // 4. Push to Grafana Loki
    await axios.post(`${CONFIG.LOKI_URL}/loki/api/v1/push`, lokiPayload, {
      headers: { 'Content-Type': 'application/json' },
    });

    // Returns { status: 'ok' } as expected by your Lua script
    return res.json({ status: 'ok' });
  } catch (err) {
    const errorMsg = err.response?.data?.error || err.message;
    console.error('[Proxy Error] Loki Push Failed:', errorMsg);
    return res.status(500).json({ status: 'error', message: `Loki error: ${errorMsg}` });
  }
}

// ---------------------------------------------------------
// ROUTE MAPPING
// ---------------------------------------------------------

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'fivemanage-proxy' }));

// Presigned URL Generation (Issues 60-second single-use token)
app.get([
  '/api/v2/presigned-url', '/api/v3/presigned-url',
  '/api/v2/file/presigned-url', '/api/v3/file/presigned-url'
], (req, res) => {
  const token = crypto.randomBytes(16).toString('hex');
  const version = req.path.includes('/v3') ? 'v3' : 'v2';

  // Store token valid for 60 seconds (60,000 ms)
  validTokens.set(token, Date.now() + 60000);

  return res.json({
    status: 'ok',
    data: { presignedUrl: `${CONFIG.PUBLIC_URL}/api/${version}/upload?token=${token}` }
  });
});

// Upload Routes (Protected by token validator)
app.post([
  '/api/v2/upload', '/api/v3/upload',
  '/api/v2/file', '/api/v3/file',
  '/api/v2/file/base64', '/api/v3/file/base64'
], upload.any(), validateOneTimeToken, handleUniversalUpload);

// Logging Routes
app.post(['/api/v2/logs', '/api/v3/logs'], handleLokiLogging);

// Metadata & Deletion Routes
app.get(['/api/v2/file/:id', '/api/v3/file/:id'], async (req, res) => {
  return res.json({ status: 'ok', data: { id: req.params.id, url: `${CONFIG.ZIPLINE_PUBLIC_URL}/u/${req.params.id}` } });
});

app.delete(['/api/v2/file/:id', '/api/v3/file/:id'], async (req, res) => {
  try {
    await axios.delete(`${CONFIG.ZIPLINE_URL}/api/user/files/${req.params.id}`, { 
      headers: { Authorization: CONFIG.ZIPLINE_TOKEN } 
    });
    return res.json({ status: 'ok', message: 'File deleted' });
  } catch (err) {
    return res.status(500).json({ status: 'error', message: 'Failed to delete file' });
  }
});

app.get('/u/:id', async (req, res) => {
  try {
    const imageRes = await axios.get(`${CONFIG.ZIPLINE_URL}/u/${req.params.id}`, {
      responseType: 'stream'
    });
    res.setHeader('Content-Type', imageRes.headers['content-type'] || 'image/webp');
    imageRes.data.pipe(res);
  } catch (err) {
    res.status(404).send('Image not found');
  }
});

app.listen(CONFIG.PORT, () => console.log(`Proxy running on port ${CONFIG.PORT}`));