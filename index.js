require('dotenv').config();
const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const multer = require('multer');
const cors = require('cors');

const app = express();
const upload = multer({ limits: { fileSize: 25 * 1024 * 1024 } }); // 25MB limit

app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

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

// Health check for Docker/Portainer
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'fivemanage-proxy' }));

/**
 * 1. FIVEING/TGiann COMPATIBILITY: Presigned URL Generation
 */
app.get('/api/v2/presigned-url', (req, res) => {
  return res.json({ status: 'ok', data: { presignedUrl: `${CONFIG.PUBLIC_URL}/api/v2/upload` } });
});
app.get('/api/v3/presigned-url', (req, res) => {
  return res.json({ status: 'ok', data: { presignedUrl: `${CONFIG.PUBLIC_URL}/api/v2/upload` } });
});

/**
 * 2. FIVEING/TGiann COMPATIBILITY: Upload Endpoint for Presigned URLs
 */
app.post('/api/v2/upload', upload.any(), async (req, res) => {
  try {
    const file = req.file || (req.files && req.files[0]);
    const form = new FormData();

    if (file) {
      form.append('file', file.buffer, {
        filename: file.originalname || 'screenshot.png',
        contentType: file.mimetype || 'image/png',
      });
    } else if (req.body.image || req.body.base64) {
      const rawBase64 = req.body.image || req.body.base64;
      const cleanBase64 = rawBase64.replace(/^data:image\/\w+;base64,/, '');
      const buffer = Buffer.from(cleanBase64, 'base64');
      form.append('file', buffer, { filename: 'screenshot.png', contentType: 'image/png' });
    } else {
      return res.status(400).json({ status: 'error', message: 'No file payload found' });
    }

    const ziplineRes = await axios.post(`${CONFIG.ZIPLINE_URL}/api/upload`, form, {
      headers: { ...form.getHeaders(), Authorization: CONFIG.ZIPLINE_TOKEN },
    });

    const { url, id } = parseZiplineResponse(ziplineRes.data.files);
    return res.json({ status: 'ok', data: { url, id } });
  } catch (err) {
    const errorMsg = err.response?.data?.error || err.message;
    console.error('[Proxy Error] Presigned Upload:', errorMsg);
    return res.status(500).json({ status: 'error', message: `Zipline error: ${errorMsg}` });
  }
});
app.post('/api/v3/upload', upload.any(), async (req, res) => {
  try {
    const file = req.file || (req.files && req.files[0]);
    const form = new FormData();

    if (file) {
      form.append('file', file.buffer, {
        filename: file.originalname || 'screenshot.png',
        contentType: file.mimetype || 'image/png',
      });
    } else if (req.body.image || req.body.base64) {
      const rawBase64 = req.body.image || req.body.base64;
      const cleanBase64 = rawBase64.replace(/^data:image\/\w+;base64,/, '');
      const buffer = Buffer.from(cleanBase64, 'base64');
      form.append('file', buffer, { filename: 'screenshot.png', contentType: 'image/png' });
    } else {
      return res.status(400).json({ status: 'error', message: 'No file payload found' });
    }

    const ziplineRes = await axios.post(`${CONFIG.ZIPLINE_URL}/api/upload`, form, {
      headers: { ...form.getHeaders(), Authorization: CONFIG.ZIPLINE_TOKEN },
    });

    const { url, id } = parseZiplineResponse(ziplineRes.data.files);
    return res.json({ status: 'ok', data: { url, id } });
  } catch (err) {
    const errorMsg = err.response?.data?.error || err.message;
    console.error('[Proxy Error] Presigned Upload:', errorMsg);
    return res.status(500).json({ status: 'error', message: `Zipline error: ${errorMsg}` });
  }
});

/**
 * 3. LEGACY BASE64 UPLOAD -> ZIPLINE
 */
app.post('/api/v3/file/base64', async (req, res) => {
  try {
    const { base64, image, filename = 'screenshot.png' } = req.body;
    const targetBase64 = base64 || image;
    
    if (!targetBase64) return res.status(400).json({ status: 'error', message: 'Missing base64 payload' });

    const cleanBase64 = targetBase64.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(cleanBase64, 'base64');
    
    const form = new FormData();
    form.append('file', buffer, { filename, contentType: 'image/png' });

    const ziplineRes = await axios.post(`${CONFIG.ZIPLINE_URL}/api/upload`, form, {
      headers: { ...form.getHeaders(), Authorization: CONFIG.ZIPLINE_TOKEN },
    });

    const { url, id } = parseZiplineResponse(ziplineRes.data.files);
    return res.json({ status: 'ok', data: { id, url } });
  } catch (err) {
    const errorMsg = err.response?.data?.error || err.message;
    console.error('[Proxy Error] Base64:', errorMsg);
    return res.status(500).json({ status: 'error', message: `Zipline error: ${errorMsg}` });
  }
});

/**
 * 4. LEGACY MULTIPART UPLOAD -> ZIPLINE (screenshot-basic)
 */
app.post('/api/v3/file', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ status: 'error', message: 'No file uploaded' });

    const form = new FormData();
    form.append('file', req.file.buffer, {
      filename: req.file.originalname || 'upload.png',
      contentType: req.file.mimetype,
    });

    const ziplineRes = await axios.post(`${CONFIG.ZIPLINE_URL}/api/upload`, form, {
      headers: { ...form.getHeaders(), Authorization: CONFIG.ZIPLINE_TOKEN },
    });

    const { url, id } = parseZiplineResponse(ziplineRes.data.files);
    return res.json({ status: 'ok', data: { id, url } });
  } catch (err) {
    const errorMsg = err.response?.data?.error || err.message;
    console.error('[Proxy Error] Multipart:', errorMsg);
    return res.status(500).json({ status: 'error', message: `Zipline error: ${errorMsg}` });
  }
});
app.post('/api/v2/file', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ status: 'error', message: 'No file uploaded' });

    const form = new FormData();
    form.append('file', req.file.buffer, {
      filename: req.file.originalname || 'upload.png',
      contentType: req.file.mimetype,
    });

    const ziplineRes = await axios.post(`${CONFIG.ZIPLINE_URL}/api/upload`, form, {
      headers: { ...form.getHeaders(), Authorization: CONFIG.ZIPLINE_TOKEN },
    });

    const { url, id } = parseZiplineResponse(ziplineRes.data.files);
    return res.json({ status: 'ok', data: { id, url } });
  } catch (err) {
    const errorMsg = err.response?.data?.error || err.message;
    console.error('[Proxy Error] Multipart:', errorMsg);
    return res.status(500).json({ status: 'error', message: `Zipline error: ${errorMsg}` });
  }
});

/**
 * 5. LOGGING -> GRAFANA LOKI
 */
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

/**
 * 6. EXTRA: Retrieve File Metadata (Mock/Compatibility)
 */
app.get('/api/v3/file/:id', async (req, res) => {
  try {
    const fileId = req.params.id;
    return res.json({
      status: 'ok',
      data: {
        id: fileId,
        url: `${CONFIG.ZIPLINE_URL}/u/${fileId}` // Zipline usually uses /u/ or /r/ depending on config
      }
    });
  } catch (err) {
    return res.status(404).json({ status: 'error', message: 'File not found' });
  }
});
app.get('/api/v2/file/:id', async (req, res) => {
  try {
    const fileId = req.params.id;
    return res.json({
      status: 'ok',
      data: {
        id: fileId,
        url: `${CONFIG.ZIPLINE_URL}/u/${fileId}` // Zipline usually uses /u/ or /r/ depending on config
      }
    });
  } catch (err) {
    return res.status(404).json({ status: 'error', message: 'File not found' });
  }
});

/**
 * 7. EXTRA: Delete File (Mock/Compatibility)
 */
app.delete('/api/v3/file/:id', async (req, res) => {
  try {
    await axios.delete(`${CONFIG.ZIPLINE_URL}/api/user/files/${req.params.id}`, {
      headers: { Authorization: CONFIG.ZIPLINE_TOKEN }
    });
    return res.json({ status: 'ok', message: 'File deleted' });
  } catch (err) {
    return res.status(500).json({ status: 'error', message: 'Failed to delete file' });
  }
});
app.delete('/api/v2/file/:id', async (req, res) => {
  try {
    await axios.delete(`${CONFIG.ZIPLINE_URL}/api/user/files/${req.params.id}`, {
      headers: { Authorization: CONFIG.ZIPLINE_TOKEN }
    });
    return res.json({ status: 'ok', message: 'File deleted' });
  } catch (err) {
    return res.status(500).json({ status: 'error', message: 'Failed to delete file' });
  }
});

app.listen(CONFIG.PORT, () => console.log(`Proxy running on port ${CONFIG.PORT}`));