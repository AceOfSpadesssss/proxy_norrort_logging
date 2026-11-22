require('dotenv').config();
const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const multer = require('multer');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');

const app = express();
const upload = multer({ 
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedMimes = /jpeg|jpg|png|webp|gif/;
    const mimeOk = allowedMimes.test(file.mimetype);
    const extOk = allowedMimes.test(path.extname(file.originalname).toLowerCase());
    if (mimeOk && extOk) cb(null, true);
    else cb(new Error('Only image files are allowed'));
  }
});

const CONFIG = {
  ZIPLINE_URL: process.env.ZIPLINE_URL || 'http://localhost:3000',
  ZIPLINE_TOKEN: (process.env.ZIPLINE_TOKEN || '').trim(),
  ZIPLINE_PUBLIC_URL: process.env.ZIPLINE_PUBLIC_URL || 'http://192.168.8.6:3000',
  LOKI_URL: process.env.LOKI_URL || 'http://localhost:3100',
  PORT: process.env.PORT || 8080,
  PUBLIC_URL: process.env.PUBLIC_URL || 'http://192.168.8.6:8080',
  PROXY_API_KEY: process.env.PROXY_API_KEY || '',
  ALLOWED_ORIGINS: (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean)
};

const AXIOS_TIMEOUT = 10000;

const validTokens = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [token, expiresAt] of validTokens.entries()) {
    if (now > expiresAt) validTokens.delete(token);
  }
}, 60000);

app.use(helmet());
app.use(helmet.crossOriginEmbedderPolicy({ policy: 'require-corp' }));

const corsOptions = {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (CONFIG.ALLOWED_ORIGINS.length === 0 || CONFIG.ALLOWED_ORIGINS.includes(origin)) {
      return cb(null, true);
    }
    return cb(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'X-Requested-With'],
  maxAge: 86400
};
app.use(cors(corsOptions));

app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));
app.use(express.text({ limit: '25mb' }));
app.use(express.raw({ limit: '25mb', type: ['image/*', 'application/octet-stream'] }));

const ipKey = (req) => req.ip || req.connection.remoteAddress || 'unknown';

const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 100, keyGenerator: ipKey,
  standardHeaders: true, legacyHeaders: false,
  message: { status: 'error', message: 'Too many requests, please try again later.' }
});
const presignedLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10, keyGenerator: ipKey,
  standardHeaders: true, legacyHeaders: false,
  message: { status: 'error', message: 'Too many presigned URL requests.' }
});
const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 30, keyGenerator: ipKey,
  standardHeaders: true, legacyHeaders: false,
  message: { status: 'error', message: 'Too many upload requests.' }
});
const logsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 60, keyGenerator: ipKey,
  standardHeaders: true, legacyHeaders: false,
  message: { status: 'error', message: 'Too many log requests.' }
});
const webhookLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 60, keyGenerator: ipKey,
  standardHeaders: true, legacyHeaders: false,
  message: { status: 'error', message: 'Too many webhook requests.' }
});
const deleteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10, keyGenerator: ipKey,
  standardHeaders: true, legacyHeaders: false,
  message: { status: 'error', message: 'Too many delete requests.' }
});

app.use(generalLimiter);

function requireApiKey(req, res, next) {
  if (!CONFIG.PROXY_API_KEY) return next();
  const key = req.headers['x-api-key'] || req.headers['authorization'];
  if (key && key.replace(/^Bearer\s/i, '') === CONFIG.PROXY_API_KEY) {
    return next();
  }
  return res.status(401).json({ status: 'error', message: 'Unauthorized' });
}

function parseZiplineResponse(filesArray) {
  if (!filesArray || filesArray.length === 0) throw new Error('No file returned from Zipline');
  const fileData = filesArray[0];
  const rawUrl = typeof fileData === 'string' ? fileData : fileData.url;
  const id = typeof fileData === 'string' ? rawUrl.split('/').pop() : fileData.id;
  const publicUrl = rawUrl.replace(CONFIG.ZIPLINE_URL, CONFIG.ZIPLINE_PUBLIC_URL);
  return { url: publicUrl, id };
}

function safeError(err) {
  return err.response?.data?.error || err.message || 'Internal error';
}

function validateOneTimeToken(req, res, next) {
  const token = req.query.token;
  if (token) {
    if (!validTokens.has(token)) {
      return res.status(403).json({ status: 'error', message: 'Invalid or already used presigned URL token' });
    }
    const expiresAt = validTokens.get(token);
    validTokens.delete(token);
    if (Date.now() > expiresAt) {
      return res.status(403).json({ status: 'error', message: 'Presigned URL token has expired' });
    }
  } else if (req.path.includes('/upload')) {
    return res.status(403).json({ status: 'error', message: 'Missing presigned URL token' });
  }
  next();
}

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
      timeout: AXIOS_TIMEOUT,
    });

    const { url, id } = parseZiplineResponse(ziplineRes.data.files);
    return res.json({ status: 'ok', data: { url, id } });
  } catch (err) {
    console.error('[Proxy Error] Upload Failed:', safeError(err));
    return res.status(500).json({ status: 'error', message: 'Zipline upload failed' });
  }
}

async function handleLokiLogging(req, res) {
  try {
    const body = req.body || {};

    const script = String(body.script || 'norrort_logging');
    const message = String(body.message || 'No message provided');
    const event = String(body.event || 'ospecificerad');
    const type = String(body.type || 'normal');

    let level = 'info';
    if (type === 'important') level = 'warn';

    const player = body.player && typeof body.player === 'object' ? body.player : null;
    const args = body.args || null;
    const image = body.image || null;

    const nanoTimestamp = (BigInt(Date.now()) * 1000000n).toString();

    const logEntry = {
      message,
      script,
      event,
      type,
      level,
      ...(player ? { player } : {}),
      ...(args ? { args } : {}),
      ...(image ? { image } : {}),
    };

    const lokiPayload = {
      streams: [{
        stream: {
          app: 'fivem',
          script,
          event,
          type,
          level,
        },
        values: [[nanoTimestamp, JSON.stringify(logEntry)]]
      }]
    };

    await axios.post(`${CONFIG.LOKI_URL}/loki/api/v1/push`, lokiPayload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: AXIOS_TIMEOUT,
    });

    return res.json({ status: 'ok' });
  } catch (err) {
    const errorMsg = err.response?.data?.error || err.message;
    console.error('[Proxy Error] Loki Push Failed:', errorMsg);
    return res.status(500).json({ status: 'error', message: `Loki error: ${errorMsg}` });
  }
}

async function handleDiscordWebhook(req, res) {
  try {
    let payload;
    const files = req.files || [];

    if (req.headers['content-type'] && req.headers['content-type'].includes('multipart/form-data')) {
      const payloadJson = req.body.payload_json || req.body.payload;
      payload = typeof payloadJson === 'string' ? JSON.parse(payloadJson) : (payloadJson || {});
    } else {
      payload = req.body || {};
    }

    const { content, embeds, username, avatar_url } = payload;

    const logEntry = {
      source: 'discord_webhook',
      webhookId: req.params.webhookId,
      username: username || 'Unknown',
      avatar_url: avatar_url || null,
      content: content || '',
      embeds: embeds || [],
      timestamp: new Date().toISOString()
    };

    let uploadedUrls = [];

    if (files && files.length > 0) {
      for (const file of files) {
        const form = new FormData();
        form.append('file', file.buffer, {
          filename: file.originalname || 'attachment',
          contentType: file.mimetype || 'application/octet-stream'
        });
        try {
          const ziplineRes = await axios.post(`${CONFIG.ZIPLINE_URL}/api/upload`, form, {
            headers: { ...form.getHeaders(), Authorization: CONFIG.ZIPLINE_TOKEN },
            timeout: AXIOS_TIMEOUT,
          });
          const { url } = parseZiplineResponse(ziplineRes.data.files);
          uploadedUrls.push({ filename: file.originalname, url });
        } catch (err) {
          console.error('[Discord Webhook] Zipline upload failed:', safeError(err));
        }
      }
    }

    if (uploadedUrls.length > 0) {
      logEntry.attachments = uploadedUrls;
    }

    const nanoTimestamp = (BigInt(Date.now()) * 1000000n).toString();
    const lokiPayload = {
      streams: [{
        stream: { app: 'fivem', script: 'discord_webhook', event: 'webhook', type: 'normal', level: 'info' },
        values: [[nanoTimestamp, JSON.stringify(logEntry)]]
      }]
    };

    try {
      await axios.post(`${CONFIG.LOKI_URL}/loki/api/v1/push`, lokiPayload, {
        headers: { 'Content-Type': 'application/json' },
        timeout: AXIOS_TIMEOUT,
      });
    } catch (err) {
      console.error('[Discord Webhook] Loki push failed:', safeError(err));
    }

    return res.status(200).json({
      id: crypto.randomBytes(8).toString('hex'),
      content: content || '',
      channel_id: null,
      author: { username: username || 'Webhook', avatar_url: avatar_url || null },
      embeds: embeds || [],
      attachments: uploadedUrls.map(u => ({ url: u.url, filename: u.filename }))
    });
  } catch (err) {
    console.error('[Discord Webhook] Error:', safeError(err));
    return res.status(400).json({ status: 'error', message: safeError(err) });
  }
}

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'fivemanage-proxy' }));

app.get([
  '/api/v2/presigned-url', '/api/v3/presigned-url',
  '/api/v2/file/presigned-url', '/api/v3/file/presigned-url'
], presignedLimiter, (req, res) => {
  const token = crypto.randomBytes(16).toString('hex');
  const version = req.path.includes('/v3') ? 'v3' : 'v2';
  validTokens.set(token, Date.now() + 60000);
  return res.json({
    status: 'ok',
    data: { presignedUrl: `${CONFIG.PUBLIC_URL}/api/${version}/upload?token=${token}` }
  });
});

app.post([
  '/api/v2/upload', '/api/v3/upload',
  '/api/v2/file', '/api/v3/file',
  '/api/v2/file/base64', '/api/v3/file/base64'
], uploadLimiter, upload.any(), validateOneTimeToken, handleUniversalUpload);

app.post(['/api/v2/logs', '/api/v3/logs'], logsLimiter, requireApiKey, handleLokiLogging);

app.get(['/api/v2/file/:id', '/api/v3/file/:id'], async (req, res) => {
  return res.json({ status: 'ok', data: { id: req.params.id, url: `${CONFIG.ZIPLINE_PUBLIC_URL}/u/${req.params.id}` } });
});

app.delete(['/api/v2/file/:id', '/api/v3/file/:id'], deleteLimiter, requireApiKey, async (req, res) => {
  try {
    await axios.delete(`${CONFIG.ZIPLINE_URL}/api/user/files/${req.params.id}`, { 
      headers: { Authorization: CONFIG.ZIPLINE_TOKEN },
      timeout: AXIOS_TIMEOUT,
    });
    return res.json({ status: 'ok', message: 'File deleted' });
  } catch (err) {
    return res.status(500).json({ status: 'error', message: 'Failed to delete file' });
  }
});

app.get('/u/:id', async (req, res) => {
  try {
    const imageRes = await axios.get(`${CONFIG.ZIPLINE_URL}/u/${req.params.id}`, {
      responseType: 'stream',
      timeout: AXIOS_TIMEOUT,
    });
    res.setHeader('Content-Type', imageRes.headers['content-type'] || 'image/webp');
    imageRes.data.pipe(res);
  } catch (err) {
    res.status(404).send('Image not found');
  }
});

app.post('/api/webhooks/:webhookId/:webhookToken', webhookLimiter, upload.any(), handleDiscordWebhook);

app.listen(CONFIG.PORT, () => console.log(`Proxy running on port ${CONFIG.PORT}`));
