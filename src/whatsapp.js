'use strict';
/**
 * WhatsApp bridge — privacy-first
 *
 * What this module DOES:
 *   - Authenticate via QR scan (whatsapp-web.js)
 *   - Fetch chat/group names so the user can pick a target (no message content ever read)
 *   - Send a message to one specific, user-selected chat/group
 *
 * What this module DOES NOT do:
 *   - Read any incoming messages
 *   - Access message history or archives
 *   - Listen for any events beyond auth/connection lifecycle
 *   - Store or expose contact data beyond {id, name, isGroup}
 */

let client = null;
let qrDataUrl = null;
let connected = false;
let initializing = false;
let storeRef = null;
let sendSSERef = null;

function isConnected() { return connected; }
function getQRDataUrl() { return qrDataUrl; }
function isInitializing() { return initializing; }

function init(store, sendSSE) {
  if (initializing || connected) return;
  storeRef = store;
  sendSSERef = sendSSE;
  initializing = true;

  let Client, LocalAuth, QRCode;
  try {
    ({ Client, LocalAuth } = require('whatsapp-web.js'));
    QRCode = require('qrcode');
  } catch (e) {
    console.warn('[WA] whatsapp-web.js unavailable:', e.message);
    initializing = false;
    return;
  }

  client = new Client({
    authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    }
  });

  // Only attach lifecycle events — never attach a message reader
  client.on('qr', async (qr) => {
    try {
      qrDataUrl = await QRCode.toDataURL(qr, { width: 240, margin: 1 });
      sendSSE('waQR', { qr: qrDataUrl });
      console.log('[WA] QR ready');
    } catch (e) {
      console.error('[WA] QR gen error:', e.message);
    }
  });

  client.on('loading_screen', (pct) => {
    sendSSE('waLoading', { pct });
  });

  client.on('ready', async () => {
    connected = true;
    initializing = false;
    qrDataUrl = null;
    if (storeRef) storeRef.settings.waConnected = true;
    sendSSE('waStatus', { connected: true });
    console.log('[WA] Ready');

    // Pre-fetch chat list so Settings page loads fast
    try {
      const chats = await _getChats();
      sendSSE('waChats', { chats });
    } catch (e) {}
  });

  client.on('auth_failure', (msg) => {
    connected = false;
    initializing = false;
    if (storeRef) storeRef.settings.waConnected = false;
    sendSSE('waStatus', { connected: false, error: 'Auth failed — try scanning again' });
    console.warn('[WA] Auth failure:', msg);
  });

  client.on('disconnected', (reason) => {
    connected = false;
    initializing = false;
    if (storeRef) storeRef.settings.waConnected = false;
    sendSSE('waStatus', { connected: false, reason });
    console.log('[WA] Disconnected:', reason);
  });

  client.initialize().catch(e => {
    console.error('[WA] Init error:', e.message);
    initializing = false;
    sendSSE('waStatus', { connected: false, error: e.message });
  });
}

// Returns chat metadata only — no message content
async function _getChats() {
  if (!client || !connected) throw new Error('Not connected');
  const raw = await client.getChats();
  return raw
    .map(c => ({
      id: c.id._serialized,
      name: c.name || c.pushname || c.id.user || c.id._serialized,
      isGroup: c.isGroup,
      participantsCount: c.isGroup ? (c.groupMetadata?.participants?.length || 0) : null
    }))
    .filter(c => c.name)
    .sort((a, b) => {
      // Groups first, then alphabetical
      if (a.isGroup && !b.isGroup) return -1;
      if (!a.isGroup && b.isGroup) return 1;
      return a.name.localeCompare(b.name);
    });
}

async function getChats() { return _getChats(); }

async function sendMessage(chatId, message) {
  if (!client || !connected) {
    console.warn('[WA] Not connected, cannot send');
    return false;
  }
  try {
    await client.sendMessage(chatId, message);
    return true;
  } catch (e) {
    console.error('[WA] Send error:', e.message);
    return false;
  }
}

function formatBreachAlert({ newBreaches, awbs, dashboardUrl }) {
  const list = awbs.slice(0, 5).map(a => `#${a}`).join(', ') + (awbs.length > 5 ? ` +${awbs.length - 5} more` : '');
  return [
    `🚨 *Prozoship Alert*`,
    `${newBreaches} new SLA breach${newBreaches !== 1 ? 'es' : ''} detected.`,
    `📦 AWBs: ${list}`,
    `⏱ Each has crossed its SLA window.`,
    `Tap to view → ${dashboardUrl || 'http://localhost:3000'}`
  ].join('\n');
}

function formatDailyDigest({ store, dashboardUrl }) {
  const { cancellations, pickup } = store;
  const lines = ['☀️ *Prozoship Daily Digest*', ''];
  if (cancellations?.kpis) {
    const k = cancellations.kpis;
    lines.push(`🔴 *${k.totalBreaches} active SLA breaches*`);
    lines.push(`  Delivery: ${k.deliveryBreaches}  ·  RTO: ${k.rtoBreaches}  ·  Pickup/Cancel: ${k.pickupCancellationBreaches}`);
  }
  if (pickup?.kpis) {
    lines.push(`📦 *${pickup.kpis.totalPending} pending* — ${pickup.kpis.slaBreached} breached, ${pickup.kpis.normalPipeline} on track`);
  }
  lines.push('');
  lines.push(`View → ${dashboardUrl || 'http://localhost:3000'}`);
  return lines.join('\n');
}

async function disconnect() {
  if (client) {
    try { await client.destroy(); } catch (e) {}
    client = null;
  }
  connected = false;
  initializing = false;
  qrDataUrl = null;
}

module.exports = {
  init, isConnected, isInitializing, getQRDataUrl,
  getChats, sendMessage,
  formatBreachAlert, formatDailyDigest,
  disconnect
};
