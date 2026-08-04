require('dotenv').config();
const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const multer = require('multer');
const cors = require('cors');

const app = express();
const upload = multer({ limits: { fileSize: 25 * 1024 * 1024 } }); // 25MB limit

// Accept ALL payload types (JSON, Form Data, Text, and Raw Binary Blobs)
app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));
app.use(express.text({ limit: '25mb' }));
app.use(express.raw({ limit: '25mb', type: ['image/*', 'application/octet-stream'] }));

const CONFIG = {
  ZIPLINE_URL: process.env.ZIPLINE_URL || 'http://localhost:3000',
  ZIPLINE_TOKEN: process.env.ZIPLINE_TOKEN,
  LOKI_URL: process.env.LOKI_URL || 'http://localhost:3100',
  PORT: process.env.PORT || 8080,
  PUBLIC_URL: process.env.PUBLIC_URL || 'http://localhost:8080'
};

// Helper to safely parse Zipline v3 (string) and v4 (object) responses
function parseZiplineResponse(filesArray) {
  if (!filesArray || filesArray.length === 0) throw new Error("No file returned from Zipline");
  const fileData = filesArray[0];
  const url = typeof fileData === 'string' ? fileData : fileData.url;
  const id = typeof fileData === 'string' ? url.split('/').pop() : fileData.id;
  return { url, id };
}

// ---------------------------------------------------------
// UNIVERSAL UPLOAD HANDLER
// Detects whatever chaotic format FiveM sends and fixes it
// ---------------------------------------------------------
async function handleUniversalUpload(req, res) {
  try {
    const form = new FormData();
    const body = req.body || {};
    const file = req.file || (req.files && req.files[0]);

    if (file) {
      // 1. Handled Multipart Form-Data (what 'blob' usually sends)
      form.append('file', file.buffer, {
        filename: file.originalname || 'screenshot.webp',
        contentType: file.mimetype || 'image/webp',
      });
    } else if (Buffer.isBuffer(body)) {
      // 2. Handled Raw Binary Data
      form.append('file', body, { filename: 'screenshot.webp', contentType: 'image/webp' });
    } else if (typeof body === 'string') {
      // 3. Handled Raw Base64 String
      const cleanBase64 = body.replace(/^data:image\/\w+;base64,/, '');
      const buffer = Buffer.from(cleanBase64, 'base64');
      form.append('file', buffer, { filename: 'screenshot.webp', contentType: 'image/webp' });
    } else if (body.base64 || body.image) {
      // 4. Handled JSON Payload
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

// ---------------------------------------------------------
// ROUTES
// ---------------------------------------------------------
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'fivemanage-proxy' }));
app.get('/api/v2/presigned-url', (req, res) => {
  return res.json({ status: 'ok', data: { presignedUrl: `${CONFIG.PUBLIC_URL}/api/v2/upload` } });
});
app.get('/api/v3/presigned-url', (req, res) => {
  return res.json({ status: 'ok', data: { presignedUrl: `${CONFIG.PUBLIC_URL}/api/v3/upload` } });
});
// All upload routes now point to the universal handler!
app.post('/api/v3/upload', upload.any(), handleUniversalUpload);
app.post('/api/v3/file/base64', upload.any(), handleUniversalUpload);
app.post('/api/v3/file', upload.any(), handleUniversalUpload);
app.post('/api/v2/upload', upload.any(), handleUniversalUpload);
app.post('/api/v2/file/base64', upload.any(), handleUniversalUpload);
app.post('/api/v2/file', upload.any(), handleUniversalUpload);

// Logging
app.post('/api/v3/logs', async (req, res) => {
  try {
    const { level = 'info', message, metadata = {}, source = 'fivem' } = req.body;
    const nanoTimestamp = (BigInt(Date.now()) * 1000000n).toString();

    const lokiPayload = {
      streams: [{
        stream: {
          app: 'fivem',
          level: String(level),
          source: String(source),
          ...(metadata.resource ? { resource: String(metadata.resource) } : {})
        },
        values: [[
          nanoTimestamp,
          JSON.stringify(typeof message === 'object' ? { message, ...metadata } : { message, ...metadata })
        ]]
      }]
    };

    await axios.post(`${CONFIG.LOKI_URL}/loki/api/v1/push`, lokiPayload, {
      headers: { 'Content-Type': 'application/json' },
    });

    return res.json({ status: 'ok' });
  } catch (err) {
    const errorMsg = err.response?.data?.error || err.message;
    console.error('[Proxy Error] Loki:', errorMsg);
    return res.status(500).json({ status: 'error', message: 'Loki push failed' });
  }
});

app.post('/api/v2/logs', async (req, res) => {
  try {
    const { level = 'info', message, metadata = {}, source = 'fivem' } = req.body;
    const nanoTimestamp = (BigInt(Date.now()) * 1000000n).toString();

    const lokiPayload = {
      streams: [{
        stream: {
          app: 'fivem',
          level: String(level),
          source: String(source),
          ...(metadata.resource ? { resource: String(metadata.resource) } : {})
        },
        values: [[
          nanoTimestamp,
          JSON.stringify(typeof message === 'object' ? { message, ...metadata } : { message, ...metadata })
        ]]
      }]
    };

    await axios.post(`${CONFIG.LOKI_URL}/loki/api/v1/push`, lokiPayload, {
      headers: { 'Content-Type': 'application/json' },
    });

    return res.json({ status: 'ok' });
  } catch (err) {
    const errorMsg = err.response?.data?.error || err.message;
    console.error('[Proxy Error] Loki:', errorMsg);
    return res.status(500).json({ status: 'error', message: 'Loki push failed' });
  }
});

// Extras
app.get('/api/v3/file/:id', async (req, res) => {
  try {
    return res.json({ status: 'ok', data: { id: req.params.id, url: `${CONFIG.ZIPLINE_URL}/u/${req.params.id}` } });
  } catch (err) {
    return res.status(404).json({ status: 'error', message: 'File not found' });
  }
});

app.delete('/api/v3/file/:id', async (req, res) => {
  try {
    await axios.delete(`${CONFIG.ZIPLINE_URL}/api/user/files/${req.params.id}`, { headers: { Authorization: CONFIG.ZIPLINE_TOKEN } });
    return res.json({ status: 'ok', message: 'File deleted' });
  } catch (err) {
    return res.status(500).json({ status: 'error', message: 'Failed to delete file' });
  }
});

app.get('/api/v2/file/:id', async (req, res) => {
  try {
    return res.json({ status: 'ok', data: { id: req.params.id, url: `${CONFIG.ZIPLINE_URL}/u/${req.params.id}` } });
  } catch (err) {
    return res.status(404).json({ status: 'error', message: 'File not found' });
  }
});

app.delete('/api/v2/file/:id', async (req, res) => {
  try {
    await axios.delete(`${CONFIG.ZIPLINE_URL}/api/user/files/${req.params.id}`, { headers: { Authorization: CONFIG.ZIPLINE_TOKEN } });
    return res.json({ status: 'ok', message: 'File deleted' });
  } catch (err) {
    return res.status(500).json({ status: 'error', message: 'Failed to delete file' });
  }
});

app.listen(CONFIG.PORT, () => console.log(`Proxy running on port ${CONFIG.PORT}`));