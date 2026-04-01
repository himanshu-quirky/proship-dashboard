'use strict';
/**
 * WhatsApp bridge — uses @whiskeysockets/baileys (WebSocket-based, no Chromium)
 *
 * What this module DOES:
 *   - Authenticate via QR scan
 *   - Fetch group list so the user can pick recipients (no message content ever read)
 *   - Send messages to one or more groups / contacts
 *
 * What this module DOES NOT do:
 *   - Read any incoming messages
 *   - Access message history or archives
 *   - Listen for any events beyond auth/connection lifecycle
 */

const path = require('path');
const fs = require('fs');

const AUTH_DIR = path.join(__dirname, '../data/wa_auth');

let sock = null;
let qrDataUrl = null;
let connected = false;
let initializing = false;
let storeRef = null;
let sendSSERef = null;
let _groupCache = [];

// Minimal pino-compatible logger (suppresses Baileys internal noise)
const logger = {
  level: 'silent',
  trace: () => {},
  debug: () => {},
  info:  () => {},
  warn:  () => {},
  error: (o, msg) => { if (msg) console.error('[WA]', msg); },
  fatal: () => {},
  child: function () { return this; }
};

function isConnected()    { return connected; }
function getQRDataUrl()   { return qrDataUrl; }
function isInitializing() { return initializing; }

async function init(store, sendSSE) {
  if (initializing || connected) return;
  storeRef  = store;
  sendSSERef = sendSSE;
  initializing = true;

  let Baileys, QRCode;
  try {
    Baileys  = await import('@whiskeysockets/baileys');
    QRCode   = require('qrcode');
  } catch (e) {
    console.warn('[WA] Baileys unavailable:', e.message);
    initializing = false;
    sendSSE('waStatus', { connected: false, error: 'Baileys module not installed' });
    return;
  }

  const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion
  } = Baileys;

  fs.mkdirSync(AUTH_DIR, { recursive: true });

  const { state: authState, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  let version = [2, 3000, 1015901307]; // fallback
  try {
    const info = await fetchLatestBaileysVersion();
    version = info.version;
  } catch (e) { /* use fallback */ }

  sock = makeWASocket({
    version,
    auth: authState,
    logger,
    browser: ['Proship Dashboard', 'Chrome', '1.0.0'],
    printQRInTerminal: false,
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
    connectTimeoutMs: 60000
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      try {
        qrDataUrl = await QRCode.toDataURL(qr, { width: 240, margin: 1 });
        sendSSE('waQR', { qr: qrDataUrl });
        console.log('[WA] QR ready');
      } catch (e) {
        console.error('[WA] QR gen error:', e.message);
      }
    }

    if (connection === 'open') {
      connected    = true;
      initializing = false;
      qrDataUrl    = null;
      if (storeRef) storeRef.settings.waConnected = true;
      sendSSE('waStatus', { connected: true });
      console.log('[WA] Ready');

      // Pre-fetch groups so the UI loads instantly
      try {
        _groupCache = await _fetchGroups();
        sendSSE('waChats', { chats: _groupCache });
      } catch (e) {
        console.error('[WA] Group fetch error:', e.message);
      }
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut  = statusCode === DisconnectReason?.loggedOut || statusCode === 401;
      connected    = false;
      initializing = false;
      if (storeRef) storeRef.settings.waConnected = false;
      sendSSE('waStatus', { connected: false, reason: String(statusCode || 'unknown') });
      console.log('[WA] Disconnected, status:', statusCode, 'loggedOut:', loggedOut);

      if (!loggedOut) {
        // Transient disconnect — auto-reconnect after 5 s
        setTimeout(() => {
          if (!connected && !initializing) init(store, sendSSE);
        }, 5000);
      }
    }
  });
}

// Returns groups the account participates in (no personal chat history accessed)
async function _fetchGroups() {
  if (!sock || !connected) throw new Error('Not connected');
  const raw = await sock.groupFetchAllParticipating();
  return Object.values(raw)
    .map(g => ({
      id: g.id,
      name: g.subject || g.id,
      isGroup: true,
      participantsCount: g.participants?.length || 0
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function getChats() {
  if (!sock || !connected) throw new Error('Not connected');
  if (_groupCache.length) return _groupCache;
  _groupCache = await _fetchGroups();
  return _groupCache;
}

async function refreshChats() {
  if (!sock || !connected) return [];
  _groupCache = await _fetchGroups();
  return _groupCache;
}

// Send a text message to a single chatId (group JID or contact JID)
async function sendMessage(chatId, message) {
  if (!sock || !connected) {
    console.warn('[WA] Not connected, cannot send');
    return false;
  }
  try {
    await sock.sendMessage(chatId, { text: message });
    return true;
  } catch (e) {
    console.error('[WA] Send error:', e.message);
    return false;
  }
}

// ── Message formatters ────────────────────────────────────────────────────────

function formatBreachAlert({ newBreaches, awbs, dashboardUrl }) {
  const list = awbs.slice(0, 5).map(a => `#${a}`).join(', ') +
    (awbs.length > 5 ? ` +${awbs.length - 5} more` : '');
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
  if (sock) {
    try { await sock.logout(); } catch (e) {}
    try { sock.end(); }         catch (e) {}
    sock = null;
  }
  connected    = false;
  initializing = false;
  qrDataUrl    = null;
  _groupCache  = [];
  // Wipe saved auth so next scan starts fresh
  try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (e) {}
}

module.exports = {
  init, isConnected, isInitializing, getQRDataUrl,
  getChats, refreshChats, sendMessage,
  formatBreachAlert, formatDailyDigest,
  disconnect
};
