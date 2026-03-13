/**
 * Bose SoundTouch Web Controller - Backend Proxy
 * Node.js / Express
 *
 * The SoundTouch API runs on each speaker at http://<speaker-ip>:8090
 * WebSocket notifications arrive on ws://<speaker-ip>:8080
 *
 * This server:
 *  1. Proxies REST calls to avoid browser CORS issues
 *  2. Maintains persistent WebSocket connections to each speaker
 *  3. Broadcasts real-time events to browser clients via Server-Sent Events (SSE)
 *  4. Stores the speaker list in speakers.json
 *  5. Provides group volume control and play-everywhere across all zoned speakers
 */

const express = require('express');
const axios   = require('axios');
const xml2js  = require('xml2js');
const WebSocket = require('ws');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Speaker Registry ─────────────────────────────────────────────────────────

const SPEAKERS_FILE = path.join(__dirname, 'speakers.json');

function loadSpeakers() {
  if (!fs.existsSync(SPEAKERS_FILE)) {
    const defaults = [
      { id: 'speaker1', name: 'Living Room', ip: '192.168.1.100' },
      { id: 'speaker2', name: 'Kitchen',     ip: '192.168.1.101' }
    ];
    fs.writeFileSync(SPEAKERS_FILE, JSON.stringify(defaults, null, 2));
    return defaults;
  }
  return JSON.parse(fs.readFileSync(SPEAKERS_FILE));
}

function saveSpeakers(list) {
  fs.writeFileSync(SPEAKERS_FILE, JSON.stringify(list, null, 2));
}

let speakers = loadSpeakers();

// ─── XML Helpers ──────────────────────────────────────────────────────────────

const parser = new xml2js.Parser({ explicitArray: false, ignoreAttrs: false });

async function parseXML(xml) {
  return parser.parseStringPromise(xml);
}

function buildXML(obj) {
  const builder = new xml2js.Builder({ headless: true, renderOpts: { pretty: false } });
  return builder.buildObject(obj);
}

// ─── Speaker HTTP Proxy ───────────────────────────────────────────────────────

function speakerUrl(ip, endpoint) {
  return `http://${ip}:8090${endpoint}`;
}

async function speakerGET(ip, endpoint) {
  const res = await axios.get(speakerUrl(ip, endpoint), { timeout: 5000 });
  return parseXML(res.data);
}

async function speakerPOST(ip, endpoint, xmlBody) {
  const res = await axios.post(speakerUrl(ip, endpoint), xmlBody, {
    headers: { 'Content-Type': 'application/xml' },
    timeout: 5000
  });
  return parseXML(res.data);
}

// ─── SSE Broadcast ────────────────────────────────────────────────────────────

const sseClients = new Set();

function broadcast(eventName, data) {
  const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try { client.write(payload); } catch (_) { sseClients.delete(client); }
  }
}

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  sseClients.add(res);
  res.write(': connected\n\n');

  // Immediately tell the browser which speakers are already connected
  speakers.forEach(s => {
    if (speakerWSMap.has(s.id)) {
      res.write(`event: speakerOnline\ndata: ${JSON.stringify({ speakerId: s.id })}\n\n`);
    }
  });

  req.on('close', () => sseClients.delete(res));
});

// ─── WebSocket Connections to Speakers ───────────────────────────────────────

const speakerWSMap      = new Map(); // speakerId -> WebSocket
const speakerReconnectMap = new Map(); // speakerId -> reconnect timer

function connectSpeakerWS(speaker) {
  const wsUrl = `ws://${speaker.ip}:8080`;

  function connect() {
    if (speakerReconnectMap.has(speaker.id)) {
      clearTimeout(speakerReconnectMap.get(speaker.id));
      speakerReconnectMap.delete(speaker.id);
    }

    const ws = new WebSocket(wsUrl, 'gabbo');

    ws.on('open', () => {
      console.log(`[WS] Connected to ${speaker.name} (${speaker.ip})`);
      speakerWSMap.set(speaker.id, ws);
      broadcast('speakerOnline', { speakerId: speaker.id });
    });

    ws.on('message', async (data) => {
      try {
        const parsed = await parseXML(data.toString());
        broadcast('speakerUpdate', { speakerId: speaker.id, data: parsed });
      } catch (_) {}
    });

    ws.on('close', () => {
      console.log(`[WS] Disconnected from ${speaker.name}, reconnecting in 5s...`);
      speakerWSMap.delete(speaker.id);
      broadcast('speakerOffline', { speakerId: speaker.id });
      if (speakers.find(s => s.id === speaker.id)) {
        const t = setTimeout(connect, 5000);
        speakerReconnectMap.set(speaker.id, t);
      }
    });

    ws.on('error', (err) => {
      console.error(`[WS] ${speaker.name}: ${err.message}`);
    });
  }

  connect();
}

speakers.forEach(connectSpeakerWS);

// ─── Speaker Management ───────────────────────────────────────────────────────

function getSpeaker(req, res) {
  const speaker = speakers.find(s => s.id === req.params.id);
  if (!speaker) { res.status(404).json({ error: 'Speaker not found' }); return null; }
  return speaker;
}

app.get('/api/speakers', (req, res) => res.json(speakers));

app.post('/api/speakers', (req, res) => {
  const { name, ip } = req.body;
  if (!name || !ip) return res.status(400).json({ error: 'name and ip required' });
  const newSpeaker = { id: `speaker_${Date.now()}`, name, ip };
  speakers.push(newSpeaker);
  saveSpeakers(speakers);
  connectSpeakerWS(newSpeaker);
  res.json(newSpeaker);
});

app.delete('/api/speakers/:id', (req, res) => {
  const { id } = req.params;
  if (speakerReconnectMap.has(id)) {
    clearTimeout(speakerReconnectMap.get(id));
    speakerReconnectMap.delete(id);
  }
  const ws = speakerWSMap.get(id);
  if (ws) { ws.terminate(); speakerWSMap.delete(id); }
  speakers = speakers.filter(s => s.id !== id);
  saveSpeakers(speakers);
  res.json({ ok: true });
});

// ─── Read Routes ──────────────────────────────────────────────────────────────

app.get('/api/:id/info', async (req, res) => {
  const s = getSpeaker(req, res); if (!s) return;
  try { res.json(await speakerGET(s.ip, '/info')); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

app.get('/api/:id/now_playing', async (req, res) => {
  const s = getSpeaker(req, res); if (!s) return;
  try { res.json(await speakerGET(s.ip, '/now_playing')); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

app.get('/api/:id/volume', async (req, res) => {
  const s = getSpeaker(req, res); if (!s) return;
  try { res.json(await speakerGET(s.ip, '/volume')); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

app.get('/api/:id/sources', async (req, res) => {
  const s = getSpeaker(req, res); if (!s) return;
  try { res.json(await speakerGET(s.ip, '/sources')); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

app.get('/api/:id/presets', async (req, res) => {
  const s = getSpeaker(req, res); if (!s) return;
  try { res.json(await speakerGET(s.ip, '/presets')); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

app.get('/api/:id/bass', async (req, res) => {
  const s = getSpeaker(req, res); if (!s) return;
  try { res.json(await speakerGET(s.ip, '/bass')); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

app.get('/api/:id/zone', async (req, res) => {
  const s = getSpeaker(req, res); if (!s) return;
  try { res.json(await speakerGET(s.ip, '/getZone')); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

// ─── Control Routes ───────────────────────────────────────────────────────────

// Key press
app.post('/api/:id/key', async (req, res) => {
  const s = getSpeaker(req, res); if (!s) return;
  const { key } = req.body;
  if (!key) return res.status(400).json({ error: 'key required' });
  try {
    const pressXML   = buildXML({ key: { $: { state: 'press',   sender: 'Gabbo' }, _: key } });
    const releaseXML = buildXML({ key: { $: { state: 'release', sender: 'Gabbo' }, _: key } });
    await speakerPOST(s.ip, '/key', pressXML);
    await speakerPOST(s.ip, '/key', releaseXML);
    res.json({ ok: true });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// Volume (single speaker)
app.post('/api/:id/volume', async (req, res) => {
  const s = getSpeaker(req, res); if (!s) return;
  const { volume } = req.body;
  if (volume === undefined) return res.status(400).json({ error: 'volume required' });
  try {
    res.json(await speakerPOST(s.ip, '/volume', buildXML({ volume: String(volume) })));
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// Group volume — POST /api/group-volume { ids: [...], volume: 50 }
// If ids is omitted or empty, applies to ALL speakers
app.post('/api/group-volume', async (req, res) => {
  const { ids, volume } = req.body;
  if (volume === undefined) return res.status(400).json({ error: 'volume required' });
  const targets = ids && ids.length ? speakers.filter(s => ids.includes(s.id)) : speakers;
  const xml = buildXML({ volume: String(volume) });
  const results = await Promise.allSettled(targets.map(s => speakerPOST(s.ip, '/volume', xml)));
  res.json({ ok: true, applied: targets.map(s => s.name), results: results.map(r => r.status) });
});

// Bass
app.post('/api/:id/bass', async (req, res) => {
  const s = getSpeaker(req, res); if (!s) return;
  const { bass } = req.body;
  if (bass === undefined) return res.status(400).json({ error: 'bass required' });
  try {
    res.json(await speakerPOST(s.ip, '/bass', buildXML({ bass: { targetBass: String(bass) } })));
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// Select content item (preset or source)
app.post('/api/:id/select', async (req, res) => {
  const s = getSpeaker(req, res); if (!s) return;
  const { ContentItem } = req.body;
  if (!ContentItem) return res.status(400).json({ error: 'ContentItem required' });
  try {
    res.json(await speakerPOST(s.ip, '/select', buildXML({ ContentItem })));
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// Zone management
app.post('/api/:id/setZone', async (req, res) => {
  const s = getSpeaker(req, res); if (!s) return;
  const { masterDeviceId, slaves } = req.body;
  try {
    const zoneObj = {
      zone: {
        $: { master: masterDeviceId },
        member: slaves.map(sl => ({ $: { ipaddress: sl.ip }, _: sl.deviceId }))
      }
    };
    res.json(await speakerPOST(s.ip, '/setZone', buildXML(zoneObj)));
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.post('/api/:id/removeZone', async (req, res) => {
  const s = getSpeaker(req, res); if (!s) return;
  const { masterDeviceId, slaves } = req.body;
  try {
    const zoneObj = {
      zone: {
        $: { master: masterDeviceId },
        member: slaves.map(sl => ({ $: { ipaddress: sl.ip }, _: sl.deviceId }))
      }
    };
    res.json(await speakerPOST(s.ip, '/removeZone', buildXML(zoneObj)));
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// Play everywhere — zones all speakers under this master
app.post('/api/:id/play-everywhere', async (req, res) => {
  const master = getSpeaker(req, res); if (!master) return;
  try {
    const infoData = await speakerGET(master.ip, '/info');
    const masterDeviceId = infoData.info?.$.deviceID || '';

    const slaves = await Promise.all(
      speakers
        .filter(s => s.id !== master.id)
        .map(async s => {
          const d = await speakerGET(s.ip, '/info');
          return { ip: s.ip, deviceId: d.info?.$.deviceID || '' };
        })
    );

    const zoneObj = {
      zone: {
        $: { master: masterDeviceId },
        member: [
          { $: { ipaddress: master.ip }, _: masterDeviceId },
          ...slaves.map(sl => ({ $: { ipaddress: sl.ip }, _: sl.deviceId }))
        ]
      }
    };

    await speakerPOST(master.ip, '/setZone', buildXML(zoneObj));
    res.json({ ok: true, master: master.name, slaveCount: slaves.length });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ─── Start Server ─────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n🔊 SoundTouch Web Controller running at http://localhost:${PORT}\n`);
  console.log(`   Managing ${speakers.length} speaker(s):`);
  speakers.forEach(s => console.log(`   • ${s.name} → ${s.ip}`));
  console.log('');
});
