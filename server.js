'use strict';
require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ── Store ──────────────────────────────────────────────────────────────────────
let store = {
  delivery: null,
  pickup: null,
  cancellations: null,
  notifications: [],
  lastProshipSync: null,
  settings: {
    breachThreshold: 10,
    notificationMode: 'both',
    slackWebhook: '',
    waTargetChatId: '',
    waTargetName: '',
    waConnected: false,
    proshipUsername: process.env.PROSHIP_USERNAME || '',
    proshipPassword: process.env.PROSHIP_PASSWORD || '',
    pollIntervalMinutes: 30
  }
};

const STORE_PATH = path.join(__dirname, 'data', 'store.json');

function loadStore() {
  try {
    if (fs.existsSync(STORE_PATH)) {
      const saved = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
      // Only restore data that came from the live API — discard old HTML-upload data
      const isApiData = d => d && d.meta && d.meta.source === 'Proship API';
      store.delivery = isApiData(saved.delivery) ? saved.delivery : null;
      store.pickup = isApiData(saved.pickup) ? saved.pickup : null;
      store.cancellations = isApiData(saved.cancellations) ? saved.cancellations : null;
      store.lastProshipSync = saved.lastProshipSync || null;
      store.settings = { ...store.settings, ...saved.settings };
      // Env credentials take precedence over stored ones if set
      if (process.env.PROSHIP_USERNAME) store.settings.proshipUsername = process.env.PROSHIP_USERNAME;
      if (process.env.PROSHIP_PASSWORD) store.settings.proshipPassword = process.env.PROSHIP_PASSWORD;
    }
  } catch (e) { console.error('Store load error:', e.message); }
}

function saveStore() {
  try {
    fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify({
      delivery: store.delivery,
      pickup: store.pickup,
      cancellations: store.cancellations,
      lastProshipSync: store.lastProshipSync,
      settings: store.settings
    }, null, 2));
  } catch (e) { console.error('Store save error:', e.message); }
}

loadStore();

// ── SSE ────────────────────────────────────────────────────────────────────────
const sseClients = [];

function sendSSE(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(res => { try { res.write(payload); } catch (e) {} });
}

function clientState() {
  return {
    hasDelivery: !!store.delivery,
    hasPickup: !!store.pickup,
    hasCancellations: !!store.cancellations,
    totalBreaches: store.cancellations?.kpis?.totalBreaches || 0,
    unreadNotifications: store.notifications.filter(n => !n.read).length,
    waConnected: store.settings.waConnected,
    waInitializing: waModule ? waModule.isInitializing() : false,
    proshipConnected: !!(store.settings.proshipUsername && store.settings.proshipPassword),
    lastProshipSync: store.lastProshipSync,
    settings: store.settings
  };
}

// ── HTML Parsers (kept for manual upload fallback) ────────────────────────────
function parseDeliveryReport(html) {
  const $ = cheerio.load(html);
  const scriptText = $('script').text();
  const jsVars = {};
  for (const m of scriptText.matchAll(/const\s+(\w+)\s*=\s*\[([^\]]+)\]/g)) {
    const vals = m[2].split(',').map(v => {
      const s = v.trim().replace(/['"*]/g, '');
      return isNaN(s) ? s : Number(s);
    });
    jsVars[m[1]] = vals;
  }
  const kpis = {};
  $('.kpi').each((_, el) => {
    const label = $(el).find('.kpi-label').text().trim().toLowerCase();
    const rawVal = $(el).find('.kpi-val').text().trim().replace(/[,%]/g, '').replace(/\s*days.*/i, '').trim();
    kpis[label] = parseFloat(rawVal) || 0;
  });
  const months = jsVars.months || [], volumes = jsVars.volumes || [], deliveryRates = jsVars.deliveryRates || [];
  const monthlyTrend = months.map((m, i) => ({ month: m, volume: volumes[i] || 0, deliveryRate: deliveryRates[i] || 0 }));
  const tatM = scriptText.match(/data:\s*\[1665[,\s\d]+\]/);
  const tatVals = tatM ? tatM[0].replace(/data:\s*\[/, '').replace(/\]/, '').split(',').map(Number) : [];
  const tatDistribution = ['1','2','3','4','5','6','7','8','9','10+'].map((d, i) => ({ days: d, count: tatVals[i] || 0 }));
  const statusM = scriptText.match(/data:\s*\[(15\d{3}[,\s\d]+)\]/);
  const statusVals = statusM ? statusM[1].split(',').map(Number) : [];
  const statusBreakdown = { delivered: statusVals[0]||0, rto: statusVals[1]||0, cancelled: statusVals[2]||0, lost: statusVals[3]||0, active: statusVals[4]||0 };
  const onTimeM = scriptText.match(/label:\s*['"]On-time %['"][^[]*\[([^\]]+)\]/);
  const onTimeVals = onTimeM ? onTimeM[1].split(',').map(Number) : [];
  const onTimeByMonth = months.map((m, i) => ({ month: m, onTimePct: onTimeVals[i] || 0 }));
  const courierPerformance = [];
  for (const m of scriptText.matchAll(/\['([^']+)',\s*([\d.]+),\s*([\d.]+),\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)\]/g)) {
    courierPerformance.push({ partner: m[1], shipments: Number(m[2]), deliveryPct: Number(m[3]), rtoPct: Number(m[4]), lost: Number(m[5]), avgTAT: Number(m[6]) });
  }
  return { type: 'delivery', meta: { lastUpdated: new Date().toISOString() }, kpis: { totalShipments: kpis['total shipments']||0, deliveryRate: kpis['delivery rate']||0, avgTAT: kpis['avg tat']||0, onTimeDelivery: kpis['on-time delivery']||0, deliveredCount: statusBreakdown.delivered }, monthlyTrend, tatDistribution, statusBreakdown, onTimeByMonth, courierPerformance };
}

function parsePickupReport(html) {
  const $ = cheerio.load(html);
  const kpiData = {};
  $('.kpi').each((_, el) => { const l = $(el).find('.kpi-label').text().trim().toLowerCase(); kpiData[l] = parseInt($(el).find('.kpi-val').text().trim()) || 0; });
  const statusBreakdown = [];
  $('table.t tbody tr').each((_, row) => {
    const cells = $(row).find('td');
    if (cells.length < 6) return;
    const w = $(cells[2]).text().trim(), b = $(cells[3]).text().trim();
    statusBreakdown.push({ status: $(cells[0]).text().trim(), total: parseInt($(cells[1]).text().trim())||0, withinSLA: w==='—'?0:(parseInt(w)||0), slaBreached: b==='—'?0:(parseInt(b)||0), description: $(cells[4]).text().trim(), slaRule: $(cells[5]).text().trim() });
  });
  return { type: 'pickup', meta: { lastUpdated: new Date().toISOString() }, kpis: { totalPending: kpiData['total pending']||0, slaBreached: kpiData['sla breached']||0, normalPipeline: kpiData['normal pipeline']||0 }, statusBreakdown };
}

function parseCancellationsReport(html) {
  const $ = cheerio.load(html);
  const kpiVals = [];
  $('.kpi-val').each((_, el) => { kpiVals.push(parseInt($(el).text().trim())||0); });
  const shipments = [];
  $('table.t tbody tr').each((_, row) => {
    const cells = $(row).find('td');
    if (cells.length < 7) return;
    const daysSpan = $(cells[5]).find('.days-red, .days-amber');
    const daysNum = parseInt((daysSpan.length ? daysSpan.text() : $(cells[5]).text()))||0;
    const badgeEl = $(cells[2]).find('.badge');
    const badgeClass = badgeEl.attr('class')||'';
    const pickupCell = $(cells[4]);
    const noteEl = pickupCell.find('.note');
    const rawPickup = (noteEl.length ? noteEl.text() : pickupCell.text()).trim();
    const orderDateM = rawPickup.match(/(\d+\s+\w+\s+\d{4})\s+order/);
    const isNoPickup = rawPickup.toLowerCase().includes('no pickup');
    shipments.push({ awb: $(cells[0]).text().trim(), status: $(cells[1]).text().trim(), breachType: badgeEl.text().trim(), severity: badgeClass.includes('badge-red')?'red':'amber', city: $(cells[3]).text().trim(), pickupDate: isNoPickup?(orderDateM?`No pickup — order ${orderDateM[1]}`:'No pickup'):rawPickup, isNoPickup, daysElapsed: daysNum, slaLimit: $(cells[6]).text().trim() });
  });
  return { type: 'cancellations', meta: { lastUpdated: new Date().toISOString() }, kpis: { totalBreaches: kpiVals[0]||0, deliveryBreaches: kpiVals[1]||0, rtoBreaches: kpiVals[2]||0, pickupCancellationBreaches: kpiVals[3]||0 }, shipments };
}

function detectType(html) {
  if (html.includes('courier-tbody') || html.includes('Monthly shipment volume') || html.includes('TAT distribution')) return 'delivery';
  if (html.includes('Normal pipeline') || html.includes('total_pending') || html.includes('normal pipeline')) return 'pickup';
  if (html.includes('days-red') || html.includes('Raise with Proship') || html.includes('Days elapsed')) return 'cancellations';
  return null;
}

// ── AI & Alerts ───────────────────────────────────────────────────────────────
const AI = require('./src/ai');
const Alerts = require('./src/alerts');

async function analyzeAndAlert() {
  try {
    const summary = await AI.analyze(store);
    if (summary) {
      Alerts.addNotification(store, summary, 'ai_analysis');
      sendSSE('aiInsight', { message: summary, timestamp: new Date().toISOString() });
    }
    await Alerts.checkAndNotify(store, sendSSE);
    saveStore();
    sendSSE('notificationsUpdated', { unread: store.notifications.filter(n => !n.read).length });
  } catch (e) {
    console.error('analyzeAndAlert error:', e.message);
  }
}

// ── WhatsApp module ───────────────────────────────────────────────────────────
let waModule = null;
function getWA() {
  if (!waModule) {
    try { waModule = require('./src/whatsapp'); } catch (e) { console.warn('WA module unavailable:', e.message); }
  }
  return waModule;
}

// ── Proship module ────────────────────────────────────────────────────────────
let proshipModule = null;
function getProship() {
  if (!proshipModule) {
    try { proshipModule = require('./src/proship'); } catch (e) { console.warn('Proship module unavailable:', e.message); }
  }
  return proshipModule;
}

// ── Routes ────────────────────────────────────────────────────────────────────

// SSE
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  sseClients.push(res);
  res.write(`event: init\ndata: ${JSON.stringify(clientState())}\n\n`);
  req.on('close', () => {
    const i = sseClients.indexOf(res);
    if (i > -1) sseClients.splice(i, 1);
  });
});

// Manual HTML upload (fallback)
app.post('/api/upload', upload.array('reports', 10), async (req, res) => {
  const results = [];
  for (const file of (req.files || [])) {
    const html = file.buffer.toString('utf8');
    const type = detectType(html);
    if (!type) { results.push({ name: file.originalname, error: 'Unrecognised report type' }); continue; }
    try {
      if (type === 'delivery') store.delivery = parseDeliveryReport(html);
      else if (type === 'pickup') store.pickup = parsePickupReport(html);
      else if (type === 'cancellations') store.cancellations = parseCancellationsReport(html);
      results.push({ name: file.originalname, type, ok: true });
    } catch (e) {
      results.push({ name: file.originalname, error: e.message });
    }
  }
  saveStore();
  sendSSE('dataUpdated', clientState());
  res.json({ results });
  if (store.delivery || store.pickup || store.cancellations) analyzeAndAlert();
});

// Proship API sync
app.post('/api/proship/sync', async (req, res) => {
  const ps = getProship();
  if (!ps) return res.status(503).json({ error: 'Proship module unavailable' });
  res.json({ ok: true, message: 'Sync started' });
  const result = await ps.sync(store, sendSSE, analyzeAndAlert);
  if (result.ok) saveStore();
  sendSSE('proshipSync', result);
});

app.post('/api/proship/test', async (req, res) => {
  const ps = getProship();
  if (!ps) return res.status(503).json({ error: 'Proship module unavailable' });
  const username = req.body.username || store.settings.proshipUsername;
  const password = req.body.password || store.settings.proshipPassword;
  if (!username || !password) return res.json({ ok: false, error: 'No credentials configured' });
  const result = await ps.testConnection(username, password);
  res.json(result);
});

app.get('/api/proship/status', (req, res) => {
  const configured = !!(store.settings.proshipUsername && store.settings.proshipPassword);
  res.json({
    connected: configured,
    lastSync: store.lastProshipSync,
    username: store.settings.proshipUsername ? store.settings.proshipUsername : null
  });
});

// Trigger AI analysis
app.post('/api/analyze', async (req, res) => {
  res.json({ ok: true });
  analyzeAndAlert();
});

// Get report data
app.get('/api/data/:report', (req, res) => {
  const d = store[req.params.report];
  if (!d) return res.json({ empty: true });
  res.json(d);
});

// Notifications
app.get('/api/notifications', (req, res) => res.json(store.notifications.slice(0, 50)));

app.post('/api/notifications/read-all', (req, res) => {
  store.notifications.forEach(n => (n.read = true));
  sendSSE('notificationsUpdated', { unread: 0 });
  res.json({ ok: true });
});

app.post('/api/notifications/:id/read', (req, res) => {
  const n = store.notifications.find(n => n.id === req.params.id);
  if (n) n.read = true;
  sendSSE('notificationsUpdated', { unread: store.notifications.filter(n => !n.read).length });
  res.json({ ok: true });
});

// Settings
app.get('/api/settings', (req, res) => res.json(store.settings));

app.post('/api/settings', (req, res) => {
  const allowed = ['breachThreshold', 'notificationMode', 'slackWebhook', 'waTargetChatId', 'waTargetName', 'proshipUsername', 'proshipPassword', 'pollIntervalMinutes'];
  allowed.forEach(k => { if (req.body[k] !== undefined) store.settings[k] = req.body[k]; });
  if (req.body.breachThreshold) store.settings.breachThreshold = parseInt(req.body.breachThreshold);
  if (req.body.pollIntervalMinutes) store.settings.pollIntervalMinutes = parseInt(req.body.pollIntervalMinutes);
  saveStore();
  sendSSE('settingsUpdated', store.settings);
  res.json({ ok: true });
});

// WhatsApp
app.post('/api/whatsapp/init', (req, res) => {
  const wa = getWA();
  if (!wa) return res.status(503).json({ error: 'whatsapp-web.js not installed. Run: npm install' });
  if (wa.isConnected()) return res.json({ connected: true });
  if (wa.isInitializing()) return res.json({ initializing: true });
  wa.init(store, sendSSE);
  res.json({ initializing: true });
});

app.get('/api/whatsapp/status', (req, res) => {
  const wa = getWA();
  res.json({
    connected: wa ? wa.isConnected() : false,
    initializing: wa ? wa.isInitializing() : false,
    qr: wa ? wa.getQRDataUrl() : null
  });
});

app.get('/api/whatsapp/chats', async (req, res) => {
  const wa = getWA();
  if (!wa || !wa.isConnected()) return res.json({ error: 'Not connected', chats: [] });
  try {
    const chats = await wa.getChats();
    res.json({ chats });
  } catch (e) {
    res.json({ error: e.message, chats: [] });
  }
});

app.post('/api/whatsapp/disconnect', async (req, res) => {
  const wa = getWA();
  if (wa) await wa.disconnect();
  store.settings.waConnected = false;
  store.settings.waTargetChatId = '';
  store.settings.waTargetName = '';
  saveStore();
  sendSSE('waStatus', { connected: false });
  res.json({ ok: true });
});

// Prozo webhook receiver
app.post('/api/webhook/prozo', (req, res) => {
  const payload = req.body;
  if (payload?.waybill && store.cancellations?.shipments) {
    const s = store.cancellations.shipments.find(x => x.awb === payload.waybill);
    if (s && payload.orderStatusDescription) {
      s.status = payload.orderStatusDescription;
      sendSSE('dataUpdated', clientState());
    }
  }
  console.log('Prozo webhook:', JSON.stringify(payload).slice(0, 200));
  res.json({ received: true });
});

// ── Cron jobs ─────────────────────────────────────────────────────────────────
// Daily digest at 9 AM IST
cron.schedule('0 9 * * *', () => {
  Alerts.sendDailyDigest(store).catch(e => console.error('Digest error:', e.message));
}, { timezone: 'Asia/Kolkata' });

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`\nProzoship MIS → http://localhost:${PORT}\n`);

  // Start Proship polling if credentials are configured
  const ps = getProship();
  if (ps && store.settings.proshipUsername && store.settings.proshipPassword) {
    console.log('[Proship] Credentials found — starting auto-sync…');
    ps.startPolling(store, sendSSE, analyzeAndAlert, store.settings.pollIntervalMinutes || 30);
  }
});
