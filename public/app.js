'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  view: 'delivery',
  delivery: null,
  pickup: null,
  cancellations: null,
  notifications: [],
  settings: {},
  waConnected: false,
  waInitializing: false,
  waQR: null,
  waChats: [],
  waRecipients: [],
  broadcastSelected: [],
  proshipConnected: false,
  lastProshipSync: null,
  totalBreaches: 0,
  unread: 0,
  syncing: false,
  tableSort: { key: null, dir: 'asc' },
  tableFilter: {},
  dateRange: { preset: 'today', from: null, to: null },
  currentUser: { email: null, role: null }
};

const charts = {};

// ── Auth ─────────────────────────────────────────────────────────────────────
let _supabaseClient = null;
let _authToken = null;

async function initAuthGuard() {
  const config = await fetch('/api/auth/config').then(r => r.json()).catch(() => ({ authEnabled: false }));
  if (!config.authEnabled) {
    // Auth not configured — everyone is treated as admin
    state.currentUser = { email: null, role: 'admin' };
    return;
  }

  // Load Supabase JS
  await new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js';
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });

  _supabaseClient = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey);
  const { data: { session } } = await _supabaseClient.auth.getSession();
  if (!session) { window.location.href = '/login'; return; }
  _authToken = session.access_token;

  // Keep token fresh
  _supabaseClient.auth.onAuthStateChange((_event, session) => {
    if (!session) { window.location.href = '/login'; return; }
    _authToken = session.access_token;
  });

  // Fetch the user's role so the UI can hide admin-only controls
  try {
    const me = await fetch('/api/auth/me', { headers: { Authorization: `Bearer ${_authToken}` } }).then(r => r.json());
    state.currentUser = { email: me.email, role: me.role || 'team' };
    console.log('[auth]', state.currentUser);
  } catch (e) {
    state.currentUser = { email: null, role: 'team' };
  }
}

function isAdmin() { return state.currentUser?.role === 'admin'; }

// ── API ───────────────────────────────────────────────────────────────────────
async function api(path, opts = {}) {
  try {
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    if (_authToken) headers['Authorization'] = `Bearer ${_authToken}`;
    const res = await fetch(path, { ...opts, headers });
    if (res.status === 401) { window.location.href = '/login'; return null; }
    return res.ok ? res.json() : null;
  } catch (e) { console.error('API', path, e.message); return null; }
}

async function loadData() {
  const [delivery, pickup, cancellations, notifications, settings] = await Promise.all([
    api('/api/data/delivery'),
    api('/api/data/pickup'),
    api('/api/data/cancellations'),
    api('/api/notifications'),
    api('/api/settings')
  ]);
  if (delivery && !delivery.empty) state.delivery = delivery;
  if (pickup && !pickup.empty) state.pickup = pickup;
  if (cancellations && !cancellations.empty) state.cancellations = cancellations;
  if (notifications) state.notifications = notifications;
  if (settings) state.settings = settings;
}

// ── SSE ───────────────────────────────────────────────────────────────────────
function setupSSE() {
  let sse;
  function connect() {
    const sseUrl = _authToken ? `/api/events?token=${encodeURIComponent(_authToken)}` : '/api/events';
    sse = new EventSource(sseUrl);

    sse.addEventListener('init', e => {
      const d = JSON.parse(e.data);
      applyClientState(d);
    });

    sse.addEventListener('dataUpdated', e => {
      const d = JSON.parse(e.data);
      applyClientState(d);
      loadData().then(renderCurrentView);
    });

    sse.addEventListener('notificationsUpdated', e => {
      const d = JSON.parse(e.data);
      state.unread = d.unread || 0;
      updateTopBar();
      if (!document.getElementById('notif-panel')?.classList.contains('hidden')) loadNotifications();
    });

    sse.addEventListener('notification', e => {
      const n = JSON.parse(e.data);
      state.notifications.unshift(n);
      state.unread++;
      updateTopBar();
      toast(n.message.slice(0, 100), 'info');
    });

    sse.addEventListener('aiInsight', e => {
      const d = JSON.parse(e.data);
      const strip = document.getElementById('ai-insight-strip');
      if (strip) renderInsightStrip(strip, d.message, d.timestamp);
    });

    sse.addEventListener('waQR', e => {
      const d = JSON.parse(e.data);
      state.waQR = d.qr;
      state.waInitializing = true;
      // Update in-place if already rendered, otherwise re-render settings
      const img = document.getElementById('qr-img');
      if (img) {
        img.src = d.qr;
        img.style.display = 'block';
        const ph = document.getElementById('qr-placeholder');
        if (ph) ph.style.display = 'none';
      } else if (state.view === 'settings') {
        renderSettings();
      }
    });

    sse.addEventListener('waLoading', () => {
      const ph = document.getElementById('qr-placeholder');
      if (ph) ph.textContent = 'Loading WhatsApp…';
    });

    sse.addEventListener('waChats', e => {
      const d = JSON.parse(e.data);
      state.waChats = d.chats || [];
      renderChatPicker();
    });

    sse.addEventListener('waStatus', e => {
      const d = JSON.parse(e.data);
      state.waConnected = d.connected;
      state.waInitializing = false;
      if (d.connected) state.waQR = null; // clear QR once connected
      updateTopBar();
      if (state.view === 'settings') renderSettings();
    });

    sse.addEventListener('proshipSync', e => {
      const d = JSON.parse(e.data);
      state.syncing = false;
      if (d.ok) {
        toast(`Synced ${d.orders} orders from Proship`, 'success');
        state.lastProshipSync = new Date().toISOString();
        loadData().then(renderCurrentView);
      } else {
        toast(`Sync failed: ${d.error}`, 'error');
      }
      if (state.view === 'settings') renderSettings();
    });

    sse.addEventListener('settingsUpdated', e => {
      state.settings = JSON.parse(e.data);
    });

    sse.onerror = () => { sse.close(); setTimeout(connect, 3000); };
  }
  connect();
}

function applyClientState(d) {
  state.totalBreaches = d.totalBreaches || 0;
  state.unread = d.unreadNotifications || 0;
  state.waConnected = d.waConnected || false;
  state.waInitializing = d.waInitializing || false;
  state.proshipConnected = d.proshipConnected || false;
  state.lastProshipSync = d.lastProshipSync || null;
  if (d.settings) state.settings = d.settings;
  if (d.waRecipients) state.waRecipients = d.waRecipients;
  if (d.settings?.waRecipients) state.waRecipients = d.settings.waRecipients;
  updateTopBar();
}

// ── Top bar ───────────────────────────────────────────────────────────────────
function updateTopBar() {
const nb = document.getElementById('notif-badge');
  if (nb) {
    nb.textContent = state.unread > 9 ? '9+' : state.unread;
    nb.classList.toggle('hidden', state.unread === 0);
  }
  const waPill = document.getElementById('wa-pill');
  const waTxt = document.getElementById('wa-pill-text');
  const waDot = document.getElementById('wa-dot');
  if (waPill && waTxt) {
    if (state.waConnected) {
      waPill.className = 'wa-pill connected';
      const recipCount = (state.settings.waRecipients || []).length;
      waTxt.textContent = recipCount ? `WA: ${recipCount} group${recipCount > 1 ? 's' : ''}` : 'Connected';
      if (waDot) waDot.className = 'wa-dot';
    } else if (state.waInitializing) {
      waPill.className = 'wa-pill';
      waTxt.textContent = 'Connecting…';
      if (waDot) waDot.className = 'wa-dot pulse';
    } else {
      waPill.className = 'wa-pill disconnected';
      waTxt.textContent = 'WhatsApp';
      if (waDot) waDot.className = 'wa-dot';
    }
  }
}

// ── Navigation ────────────────────────────────────────────────────────────────
function setupNavigation() {
  document.getElementById('sidebar').addEventListener('click', e => {
    const item = e.target.closest('[data-view]');
    if (!item) return;
    e.preventDefault();
    setView(item.dataset.view);
  });
}

function setView(view) {
  state.view = view;
  state.tableSort = { key: null, dir: 'asc' };
  state.tableFilter = {};
  document.querySelectorAll('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.view === view));
  renderCurrentView();
}

function renderCurrentView() {
  updateDateRangeBarVisibility();
  if (state.view === 'delivery') renderDelivery();
  else if (state.view === 'pickup') renderPickup();
  else if (state.view === 'cancellations') renderCancellations();
  else if (state.view === 'broadcast') renderBroadcast();
  else if (state.view === 'settings') renderSettings();
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function fmtDate(iso) { if (!iso) return '—'; return new Date(iso).toLocaleString('en-IN',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}); }
function fmtRelative(iso) {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s/60)}m ago`;
  if (s < 86400) return `${Math.floor(s/3600)}h ago`;
  return `${Math.floor(s/86400)}d ago`;
}
function num(n) { return (n||0).toLocaleString('en-IN'); }

// ── Date range helpers ────────────────────────────────────────────────────────
function getDateRangeBounds() {
  const { preset, from, to } = state.dateRange;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const endOfToday = new Date(today.getTime() + 86400000 - 1);
  if (preset === 'today') return { from: today, to: endOfToday };
  if (preset === '7d')  return { from: new Date(today - 6 * 86400000), to: endOfToday };
  if (preset === '30d') return { from: new Date(today - 29 * 86400000), to: endOfToday };
  if (preset === '3m')  return { from: new Date(today - 89 * 86400000), to: endOfToday };
  if (preset === '6m')  return { from: new Date(today - 179 * 86400000), to: endOfToday };
  if (preset === 'custom' && from && to) return { from: new Date(from + 'T00:00:00'), to: new Date(to + 'T23:59:59') };
  return null; // 'all' — no filter
}

function inDateRange(dateStr) {
  if (!dateStr) return true;
  const bounds = getDateRangeBounds();
  if (!bounds) return true;
  const d = new Date(dateStr);
  if (isNaN(d)) return true;
  return d >= bounds.from && d <= bounds.to;
}

// Parse "Apr '25" or "Dec '24" month labels into a Date (1st of that month)
// Parse month labels like "Apr '25", "Apr 25", "Apr 2025", "April 2025"
function parseMonthLabel(label) {
  if (!label) return null;
  const months = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };
  // Strip apostrophes, accept 3-letter prefix + 2 or 4 digit year
  const cleaned = String(label).replace(/'/g, '').trim();
  const m = cleaned.match(/^([A-Za-z]{3,})[\s\-\/]+(\d{2,4})$/);
  if (!m) return null;
  const mi = months[m[1].slice(0,3).toLowerCase()];
  if (mi === undefined) return null;
  const y = parseInt(m[2], 10);
  const year = y < 100 ? 2000 + y : y;
  return new Date(year, mi, 1);
}

// Return the overlap fraction (0..1) between a month and the filter bounds.
// This lets us scale a month's volume proportionally when only part of the
// month falls within the filter range (e.g. "Last 30 days").
function monthOverlapFraction(monthStart, bounds) {
  if (!bounds) return 1;
  const monthEnd = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0, 23, 59, 59, 999);
  const daysInMonth = (monthEnd - monthStart) / 86400000 + 1/86400; // + tiny to avoid /0
  const overlapStart = Math.max(monthStart.getTime(), bounds.from.getTime());
  const overlapEnd   = Math.min(monthEnd.getTime(),   bounds.to.getTime());
  if (overlapEnd < overlapStart) return 0;
  const overlapDays = (overlapEnd - overlapStart) / 86400000 + 1/86400;
  return Math.max(0, Math.min(1, overlapDays / daysInMonth));
}

function filterShipments(shipments) {
  const bounds = getDateRangeBounds();
  if (!bounds) return shipments;
  return shipments.filter(s => {
    // Try pickupDate first, then fall back to checking daysElapsed from today
    const raw = s._rawDate || s.pickupDate;
    if (!raw || raw.startsWith('No pickup')) {
      // For orders with no pickup, can't filter precisely — include them
      return true;
    }
    try {
      const d = new Date(raw);
      if (isNaN(d)) return true;
      return d >= bounds.from && d <= bounds.to;
    } catch (_) { return true; }
  });
}

function setupDateRangeBar() {
  document.querySelectorAll('.dr-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const preset = btn.dataset.preset;
      document.querySelectorAll('.dr-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.dateRange.preset = preset;
      const customPanel = document.getElementById('dr-custom');
      const activeLabel = document.getElementById('dr-active-label');
      if (preset === 'custom') {
        customPanel.classList.remove('hidden');
        activeLabel.classList.add('hidden');
        // Set default to since Dec 1 2025 if empty
        if (!document.getElementById('dr-from').value) {
          const to = new Date();
          document.getElementById('dr-from').value = '2025-12-01';
          document.getElementById('dr-to').value = to.toISOString().slice(0, 10);
        }
      } else {
        customPanel.classList.add('hidden');
        state.dateRange.from = null;
        state.dateRange.to = null;
        activeLabel.classList.remove('hidden');
        const labels = { 'today': 'Today', '7d': 'Last 7 days', '30d': 'Last 30 days', '3m': 'Last 3 months', '6m': 'Last 6 months' };
        activeLabel.textContent = labels[preset] || '';
        renderCurrentView();
      }
    });
  });
}

// Show/hide date range bar based on current view (only visible on Summary)
function updateDateRangeBarVisibility() {
  const bar = document.getElementById('date-range-bar');
  if (!bar) return;
  if (state.view === 'delivery') bar.classList.remove('hidden');
  else bar.classList.add('hidden');
}

function applyCustomRange() {
  const from = document.getElementById('dr-from').value;
  const to = document.getElementById('dr-to').value;
  if (!from || !to) { toast('Select both From and To dates', 'error'); return; }
  if (new Date(from) > new Date(to)) { toast('From date must be before To date', 'error'); return; }
  state.dateRange.preset = 'custom';
  state.dateRange.from = from;
  state.dateRange.to = to;
  // Mark "Custom" button active so UI stays in sync
  document.querySelectorAll('.dr-btn').forEach(b => b.classList.remove('active'));
  document.querySelector('.dr-btn[data-preset="custom"]')?.classList.add('active');
  const activeLabel = document.getElementById('dr-active-label');
  activeLabel.classList.remove('hidden');
  activeLabel.textContent = `${from} → ${to}`;
  renderCurrentView();
}

function clearCustomRange() {
  state.dateRange = { preset: 'today', from: null, to: null };
  document.querySelectorAll('.dr-btn').forEach(b => b.classList.remove('active'));
  document.querySelector('.dr-btn[data-preset="today"]')?.classList.add('active');
  document.getElementById('dr-custom').classList.add('hidden');
  const activeLabel = document.getElementById('dr-active-label');
  activeLabel.classList.remove('hidden');
  activeLabel.textContent = 'Today';
  document.getElementById('dr-from').value = '';
  document.getElementById('dr-to').value = '';
  renderCurrentView();
}

function destroyChart(id) { if (charts[id]) { charts[id].destroy(); delete charts[id]; } }
function makeChart(id, config) {
  destroyChart(id);
  const canvas = document.getElementById(id);
  if (!canvas) return;
  charts[id] = new Chart(canvas.getContext('2d'), config);
}
const CHART_FONT = { family: 'Sora, system-ui', size: 11 };

function renderInsightStrip(container, message, timestamp) {
  if (!message) { container.innerHTML = ''; return; }
  container.innerHTML = `<div class="ai-insight-strip">
    <div class="ai-insight-icon">✦</div>
    <div class="ai-insight-body">
      <div class="ai-insight-text">${esc(message)}</div>
      <div class="ai-insight-time">${fmtRelative(timestamp)}</div>
    </div>
  </div>`;
}

function renderSyncStrip(source, lastSync) {
  if (!lastSync) return '';
  return `<div class="sync-strip">
    <div class="sync-dot"></div>
    <span>Live data from ${esc(source)} — last synced ${fmtRelative(lastSync)}</span>
  </div>`;
}

function getAIInsight() { return state.notifications.find(n => n.type === 'ai_analysis'); }

// ── Sort ──────────────────────────────────────────────────────────────────────
function sortData(data, key, dir) {
  if (!key) return data;
  return [...data].sort((a, b) => {
    let av = a[key], bv = b[key];
    if (typeof av === 'string') av = av.toLowerCase();
    if (typeof bv === 'string') bv = bv.toLowerCase();
    if (av < bv) return dir === 'asc' ? -1 : 1;
    if (av > bv) return dir === 'asc' ? 1 : -1;
    return 0;
  });
}
function thSort(key, label) {
  const isCurr = state.tableSort.key === key;
  const cls = `sortable${isCurr && state.tableSort.dir === 'asc' ? ' sort-asc' : isCurr && state.tableSort.dir === 'desc' ? ' sort-desc' : ''}`;
  return `<th class="${cls}" data-sort="${esc(key)}">${esc(label)}</th>`;
}
function handleSort(e) {
  const th = e.target.closest('th[data-sort]');
  if (!th) return;
  const key = th.dataset.sort;
  if (state.tableSort.key === key) state.tableSort.dir = state.tableSort.dir === 'asc' ? 'desc' : 'asc';
  else { state.tableSort.key = key; state.tableSort.dir = 'asc'; }
  renderCurrentView();
}

function renderEmpty(label, icon = '📂') {
  const hasCreds = state.settings.proshipUsername && state.settings.proshipPassword;
  return `<div class="empty-state">
    <div class="empty-icon">${icon}</div>
    <div class="empty-title">No ${label} data yet</div>
    <div class="empty-sub">${hasCreds ? 'Data is being fetched from Proship. Click Sync Now or wait for auto-sync.' : 'Connect your Proship account in Settings to auto-fetch, or upload a report manually.'}</div>
    <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin-top:4px">
      ${hasCreds ? `<button class="btn btn-primary" onclick="triggerSync()">Sync Now</button>` : `<button class="btn btn-outline" onclick="setView('settings')">Go to Settings</button>`}
      <button class="btn btn-outline" onclick="openUploadModal()">Upload Report Manually</button>
    </div>
  </div>`;
}

// ── SUMMARY (Delivery) ────────────────────────────────────────────────────────
function renderDelivery() {
  const el = document.getElementById('content');
  const d = state.delivery;
  if (!d) { el.innerHTML = renderEmpty('delivery data', '📦'); return; }
  const insight = getAIInsight();

  // Apply date range filter. If the backend provides dailyTrend (new Proship
  // API sync format), we filter by actual day for accuracy. Otherwise we fall
  // back to monthly proportional scaling for older HTML-uploaded data.
  const bounds = getDateRangeBounds();
  const allMonthly = d.monthlyTrend || [];
  const dailyAvailable = Array.isArray(d.dailyTrend) && d.dailyTrend.length > 0;

  let monthlyTrend, onTimeByMonth, k = d.kpis;
  const filterActive = !!bounds;
  let filtTotal = 0, filtDelivered = 0;

  if (dailyAvailable) {
    // Day-level filtering — most accurate
    const days = d.dailyTrend.filter(day => {
      if (!bounds) return true;
      const dt = new Date(day.day + 'T12:00:00');
      return dt >= bounds.from && dt <= bounds.to;
    });
    filtTotal = days.reduce((a, x) => a + (x.volume||0), 0);
    filtDelivered = days.reduce((a, x) => a + (x.delivered||0), 0);
    const tats = days.flatMap(x => x.avgTAT != null ? [x.avgTAT] : []);
    const avgTAT = tats.length ? parseFloat((tats.reduce((a,b)=>a+b,0)/tats.length).toFixed(1)) : d.kpis.avgTAT;
    // Group into months for the chart regardless of selection
    const monthAgg = {};
    days.forEach(x => {
      const mk = new Date(x.day).toLocaleString('en',{month:'short',year:'2-digit'});
      if (!monthAgg[mk]) monthAgg[mk] = {volume:0,delivered:0};
      monthAgg[mk].volume += (x.volume||0);
      monthAgg[mk].delivered += (x.delivered||0);
    });
    monthlyTrend = Object.entries(monthAgg).map(([month,v]) => ({
      month, volume: v.volume,
      deliveryRate: v.volume ? parseFloat((v.delivered/v.volume*100).toFixed(1)) : 0
    }));
    onTimeByMonth = monthlyTrend.map(m => ({ month: m.month, onTimePct: m.deliveryRate }));
    if (filterActive) {
      k = {
        ...d.kpis,
        totalShipments: filtTotal,
        deliveredCount: filtDelivered,
        deliveryRate: filtTotal ? parseFloat((filtDelivered / filtTotal * 100).toFixed(1)) : 0,
        avgTAT
      };
    }
  } else {
    // Fallback: monthly-only data → proportional scaling
    const monthBuckets = allMonthly.map(m => {
      const dt = parseMonthLabel(m.month);
      const frac = bounds ? (dt ? monthOverlapFraction(dt, bounds) : 1) : 1;
      return { ...m, _date: dt, _frac: frac, _volume: Math.round((m.volume||0) * frac) };
    });
    monthlyTrend = bounds
      ? monthBuckets.filter(m => m._frac > 0).map(m => ({ ...m, volume: m._volume }))
      : allMonthly;
    onTimeByMonth = bounds
      ? (d.onTimeByMonth || []).filter(m => {
          const dt = parseMonthLabel(m.month);
          return !dt || monthOverlapFraction(dt, bounds) > 0;
        })
      : (d.onTimeByMonth || []);
    if (filterActive) {
      filtTotal = monthBuckets.reduce((a, m) => a + m._volume, 0);
      filtDelivered = monthBuckets.reduce((a, m) => a + Math.round(m._volume * (m.deliveryRate||0) / 100), 0);
      const filtOnTime = onTimeByMonth.length
        ? parseFloat((onTimeByMonth.reduce((a,m) => a + (m.onTimePct||0), 0) / onTimeByMonth.length).toFixed(1))
        : d.kpis.onTimeDelivery;
      k = {
        ...d.kpis,
        totalShipments: filtTotal,
        deliveredCount: filtDelivered,
        deliveryRate: filtTotal ? parseFloat((filtDelivered / filtTotal * 100).toFixed(1)) : 0,
        onTimeDelivery: filtOnTime
      };
    }
  }

  // Range label for the KPI subtext
  const rangeLabel = (() => {
    if (!bounds) return 'All data';
    const fmt = dt => dt.toLocaleString('en-IN', { month: 'short', day: 'numeric' });
    const sameDay = bounds.from.toDateString() === new Date(bounds.to.getTime() - 1000).toDateString();
    return sameDay ? fmt(bounds.from) : `${fmt(bounds.from)} – ${fmt(bounds.to)}`;
  })();

  // Scale used for status donut / TAT bars / courier counts — proportional to
  // what the filtered volume is vs the total
  const originalTotal = (d.kpis?.totalShipments) || allMonthly.reduce((a, m) => a + (m.volume||0), 0) || 1;
  const filtTotalForScale = filterActive ? k.totalShipments : originalTotal;
  const scale = filterActive ? filtTotalForScale / originalTotal : 1;

  // Scale status breakdown and TAT distribution by filter ratio
  const sb = d.statusBreakdown || {};
  const scaledStatus = filterActive ? {
    delivered: Math.round((sb.delivered||0) * scale),
    rto: Math.round((sb.rto||0) * scale),
    cancelled: Math.round((sb.cancelled||0) * scale),
    lost: Math.round((sb.lost||0) * scale),
    active: Math.round((sb.active||0) * scale)
  } : sb;
  const scaledTAT = filterActive
    ? (d.tatDistribution||[]).map(t => ({ ...t, count: Math.round((t.count||0) * scale) }))
    : (d.tatDistribution||[]);
  const scaledCourier = filterActive
    ? (d.courierPerformance||[]).map(c => ({ ...c, shipments: Math.round((c.shipments||0) * scale) }))
    : (d.courierPerformance||[]);

  el.innerHTML = `
    <div class="view-header">
      <div>
        <div class="view-title">Summary</div>
        <div class="view-meta">${filterActive ? `Filtered · ${rangeLabel}` : 'No data loaded'}</div>
      </div>
      <div class="view-actions">
        <button class="btn btn-outline btn-sm" onclick="triggerAnalyze()"><svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg> AI Analysis</button>
        <button class="btn btn-primary btn-sm" onclick="openUploadModal()"><svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg> Upload MIS (.xlsx)</button>
      </div>
    </div>

    ${renderSyncStrip(d.meta.source, state.lastProshipSync)}

    <div class="kpi-row">
      <div class="kpi-card">
        <div class="kpi-label">TOTAL SHIPMENTS</div>
        <div class="kpi-value">${num(k.totalShipments)}</div>
        <div class="kpi-sub">${rangeLabel}</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">DELIVERY RATE</div>
        <div class="kpi-value ${k.deliveryRate >= 95 ? 'green' : k.deliveryRate >= 90 ? 'amber' : 'red'}">${k.deliveryRate}%</div>
        <div class="kpi-sub">delivered</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">AVG TAT</div>
        <div class="kpi-value">${k.avgTAT}</div>
        <div class="kpi-sub">Median — days</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">ON-TIME VS EDD</div>
        <div class="kpi-value ${k.onTimeDelivery >= 85 ? 'green' : k.onTimeDelivery >= 70 ? 'amber' : 'red'}">${k.onTimeDelivery}%</div>
        <div class="kpi-sub">vs estimated delivery date</div>
      </div>
    </div>

    <div id="ai-insight-strip"></div>

    <div class="chart-grid">
      <div class="chart-card">
        <div class="chart-card-title">MONTHLY VOLUME &amp; DELIVERY RATE</div>
        <div class="chart-wrap"><canvas id="chart-monthly"></canvas></div>
      </div>
      <div class="chart-card">
        <div class="chart-card-title">TAT DISTRIBUTION (DAYS)</div>
        <div class="chart-wrap"><canvas id="chart-tat"></canvas></div>
      </div>
      <div class="chart-card">
        <div class="chart-card-title">SHIPMENT STATUS BREAKDOWN</div>
        <div class="chart-wrap chart-wrap-sm"><canvas id="chart-status"></canvas></div>
        <div id="status-legend" class="donut-legend"></div>
      </div>
      <div class="chart-card">
        <div class="chart-card-title">ON-TIME % BY MONTH</div>
        <div class="chart-wrap"><canvas id="chart-ontime"></canvas></div>
      </div>
    </div>

    <div class="section-card">
      <div class="section-card-header">
        <span class="section-card-title">Courier Partner Performance</span>
      </div>
      <div class="table-scroll" id="courier-table-wrap"></div>
    </div>`;

  if (insight) renderInsightStrip(document.getElementById('ai-insight-strip'), insight.message, insight.timestamp);

  const months = monthlyTrend.map(m=>m.month);
  makeChart('chart-monthly', { type:'bar', data:{ labels:months, datasets:[
    { label:'Shipments', data:monthlyTrend.map(m=>m.volume), backgroundColor:'#D4A373', yAxisID:'y', borderRadius:3 },
    { label:'Delivery Rate %', data:monthlyTrend.map(m=>m.deliveryRate), type:'line', borderColor:'#2D6A4F', backgroundColor:'transparent', yAxisID:'y1', tension:0.3, pointRadius:4, pointBackgroundColor:'#2D6A4F' }
  ]}, options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{display:true, labels:{font:CHART_FONT, boxWidth:12, usePointStyle:true}}}, scales:{ y:{grid:{color:'rgba(0,0,0,0.04)'},ticks:{font:CHART_FONT}}, y1:{position:'right',min:0,max:100,grid:{display:false},ticks:{font:CHART_FONT,callback:v=>v+'%'}}, x:{grid:{display:false},ticks:{font:CHART_FONT}} }}});

  makeChart('chart-tat', { type:'bar', data:{ labels:scaledTAT.map(t=>t.days), datasets:[{ data:scaledTAT.map(t=>t.count), backgroundColor:'#2D6A4F', borderRadius:3 }]}, options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false}}, scales:{ y:{grid:{color:'rgba(0,0,0,0.04)'},ticks:{font:CHART_FONT}}, x:{grid:{display:false},ticks:{font:CHART_FONT}} }}});

  const statusLabels=['Delivered','RTO','Cancelled','Lost','Active'];
  const statusVals=[scaledStatus.delivered,scaledStatus.rto,scaledStatus.cancelled,scaledStatus.lost,scaledStatus.active];
  const statusColors=['#2D6A4F','#B91C1C','#D4A373','#334155','#3B82F6'];
  makeChart('chart-status', { type:'doughnut', data:{ labels:statusLabels, datasets:[{ data:statusVals, backgroundColor:statusColors, borderWidth:0 }]}, options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false}}, cutout:'64%' }});
  document.getElementById('status-legend').innerHTML = statusLabels.map((l,i)=>`<div class="legend-item"><div class="legend-dot" style="background:${statusColors[i]}"></div>${l}</div>`).join('');

  const onTimeLabels = onTimeByMonth.map(m=>m.month);
  const onTimeVals = onTimeByMonth.map(m=>m.onTimePct || 0);
  makeChart('chart-ontime', { type:'bar', data:{ labels:onTimeLabels, datasets:[{ data:onTimeVals, backgroundColor:'#D4A373', borderRadius:3 }]}, options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false}}, scales:{ y:{min:0,max:100,grid:{color:'rgba(0,0,0,0.04)'},ticks:{font:CHART_FONT,callback:v=>v+'%'}}, x:{grid:{display:false},ticks:{font:CHART_FONT}} }}});

  renderCourierTable(scaledCourier);
}

function renderCourierTable(data) {
  const sorted = sortData(data, state.tableSort.key, state.tableSort.dir);
  const wrap = document.getElementById('courier-table-wrap');
  if (!wrap) return;
  wrap.innerHTML = `<table class="data-table"><thead><tr>${thSort('partner','Partner')}${thSort('shipments','Shipments')}${thSort('deliveryPct','Delivery %')}${thSort('rtoPct','RTO %')}${thSort('lost','Lost')}${thSort('avgTAT','Avg TAT')}</tr></thead><tbody>${sorted.map(r=>{
    const c=r.deliveryPct>=97?'#16A34A':r.deliveryPct>=90?'#D97706':'#DC2626';
    const rC=r.rtoPct>2?'#DC2626':r.rtoPct>1?'#D97706':'inherit';
    const lC=r.lost>10?'#DC2626':r.lost>0?'#D97706':'inherit';
    return `<tr><td>${esc(r.partner)}</td><td class="td-num">${num(r.shipments)}</td><td><div class="bar-wrap"><div class="bar-bg"><div class="bar-fill" style="width:${r.deliveryPct}%;background:${c}"></div></div><span style="color:${c};font-weight:600;font-size:11.5px;min-width:36px">${r.deliveryPct}%</span></div></td><td style="color:${rC}">${r.rtoPct}%</td><td style="color:${lC}">${r.lost}</td><td>${r.avgTAT ? r.avgTAT+' days' : '—'}</td></tr>`;
  }).join('')}</tbody></table>`;
  wrap.querySelector('thead').addEventListener('click', handleSort);
}

// ── PENDING SHIPMENTS (Pickup) ────────────────────────────────────────────────
function renderPickup() {
  const el = document.getElementById('content');
  const d = state.pickup;
  if (!d) { el.innerHTML = renderEmpty('pickup data', '📦'); return; }
  const k = d.kpis, insight = getAIInsight();
  const filter = state.tableFilter.slaStatus || 'all';
  const breachPct = k.totalPending ? (k.slaBreached/k.totalPending*100) : 0;
  const pipelinePct = k.totalPending ? (k.normalPipeline/k.totalPending*100) : 0;

  // Count in-transit / picked up shipments from statusBreakdown
  const sb = d.statusBreakdown || [];
  const inTransitRow = sb.find(r => /transit/i.test(r.status));
  const pickedUpRow = sb.find(r => /picked up/i.test(r.status));

  el.innerHTML = `
    <div class="view-header">
      <div>
        <div class="view-title">Pending Shipments</div>
        <div class="view-meta">${num(k.totalPending)} active shipments</div>
      </div>
    </div>
    ${renderSyncStrip(d.meta.source, state.lastProshipSync)}
    <div class="kpi-row">
      <div class="kpi-card"><div class="kpi-label">TOTAL PENDING</div><div class="kpi-value">${num(k.totalPending)}</div><div class="kpi-sub">100% of all shipments</div></div>
      <div class="kpi-card"><div class="kpi-label">SLA BREACHED</div><div class="kpi-value red">${num(k.slaBreached)}</div><div class="kpi-sub">Needs action with Proship</div><div class="kpi-bar"><div class="kpi-bar-fill kpi-bar-red" style="width:${breachPct}%"></div></div></div>
      <div class="kpi-card"><div class="kpi-label">NORMAL PIPELINE</div><div class="kpi-value green">${num(k.normalPipeline)}</div><div class="kpi-sub">Within SLA</div><div class="kpi-bar"><div class="kpi-bar-fill kpi-bar-green" style="width:${pipelinePct}%"></div></div></div>
    </div>

    <div class="info-row">
      <div class="info-card">
        <div class="info-card-title">SLA REFERENCE</div>
        <ul class="info-list">
          <li><span class="info-dot dot-red"></span><strong>Delivery / RTO / Reverse:</strong> Must be delivered or returned within 5 days of pickup date</li>
          <li><span class="info-dot dot-amber"></span><strong>Pickup:</strong> Any shipment must be picked up within 24 hours of order placement</li>
          <li><span class="info-dot dot-amber"></span><strong>Cancellations:</strong> Must be reviewed and actioned within 24 hours of order</li>
        </ul>
      </div>
      <div class="info-card">
        <div class="info-card-title">NORMAL PIPELINE</div>
        <ul class="info-list">
          ${inTransitRow ? `<li><span class="info-dot dot-green"></span><strong>${inTransitRow.withinSLA} In transit</strong> — within SLA</li>` : ''}
          ${pickedUpRow ? `<li><span class="info-dot dot-green"></span><strong>${pickedUpRow.withinSLA} Picked up</strong> — within SLA</li>` : ''}
        </ul>
      </div>
    </div>

    <div id="ai-insight-strip"></div>
    <div class="section-card">
      <div class="section-card-header">
        <span class="section-card-title">All Pending — by Status</span>
        <div class="table-filters">
          <div class="filter-chip-group">
            <button class="filter-chip ${filter==='all'?'active':''}" data-slafilter="all">All</button>
            <button class="filter-chip ${filter==='breached'?'active':''}" data-slafilter="breached">Breached only</button>
          </div>
          <span class="section-card-count">${sb.length} status groups</span>
        </div>
      </div>
      <div class="table-scroll" id="pickup-table-wrap"></div>
    </div>`;

  if (insight) renderInsightStrip(document.getElementById('ai-insight-strip'), insight.message, insight.timestamp);
  document.querySelectorAll('[data-slafilter]').forEach(btn => {
    btn.addEventListener('click', () => { state.tableFilter.slaStatus = btn.dataset.slafilter; renderPickup(); });
  });
  renderPickupTable(d.statusBreakdown||[]);
}

function renderPickupTable(data) {
  const f = state.tableFilter.slaStatus || 'all';
  let rows = f === 'breached' ? data.filter(r=>r.slaBreached>0) : f === 'ok' ? data.filter(r=>r.slaBreached===0) : data;
  const sorted = sortData(rows, state.tableSort.key, state.tableSort.dir);
  const wrap = document.getElementById('pickup-table-wrap');
  if (!wrap) return;
  const totals = sorted.reduce((a,r)=>({t:a.t+r.total,w:a.w+r.withinSLA,b:a.b+r.slaBreached}),{t:0,w:0,b:0});
  wrap.innerHTML = `<table class="data-table"><thead><tr>${thSort('status','Status')}${thSort('total','Total')}${thSort('withinSLA','Within SLA')}${thSort('slaBreached','Breached')}<th>Context</th><th>SLA Rule</th></tr></thead><tbody>${sorted.map(r=>{
    const bBadge = r.slaBreached>0?`<span class="badge badge-red">${r.slaBreached}</span>`:`<span class="badge badge-green">0</span>`;
    const wBadge = r.withinSLA>0?`<span class="badge badge-green">${r.withinSLA}</span>`:`<span class="text-muted">—</span>`;
    return `<tr><td><strong>${esc(r.status)}</strong></td><td class="td-num">${r.total}</td><td class="td-num">${wBadge}</td><td class="td-num">${bBadge}</td><td style="color:var(--text-2);font-size:12px;max-width:320px">${esc(r.description)}</td><td style="color:var(--text-3);font-size:11.5px;white-space:nowrap">${esc(r.slaRule)}</td></tr>`;
  }).join('')}</tbody><tfoot><tr><td>Total</td><td class="td-num">${totals.t}</td><td class="td-num"><span class="badge badge-green">${totals.w}</span></td><td class="td-num"><span class="badge badge-red">${totals.b}</span></td><td colspan="2"></td></tr></tfoot></table>`;
  wrap.querySelector('thead').addEventListener('click', handleSort);
}

// ── ACTIONS (Cancellations) ───────────────────────────────────────────────────
function renderCancellations() {
  const el = document.getElementById('content');
  const d = state.cancellations;
  if (!d) { el.innerHTML = renderEmpty('breach data', '⚠️'); return; }
  if (!state.tableSort.key) { state.tableSort.key = 'daysElapsed'; state.tableSort.dir = 'desc'; }

  // Actions view intentionally does NOT apply the date-range filter —
  // the filter only affects the Summary view.
  const allShipments = d.shipments || [];

  const k = {
    totalBreaches: allShipments.length,
    deliveryBreaches: allShipments.filter(s=>s.breachType==='Delivery overdue').length,
    rtoBreaches: allShipments.filter(s=>s.breachType==='RTO overdue').length,
    pickupCancellationBreaches: allShipments.filter(s=>['Cancellation overdue','Pickup overdue'].includes(s.breachType)).length
  };
  const insight = getAIInsight();
  const cities = [...new Set(allShipments.map(s=>s.city).filter(Boolean))].sort();
  const active = state.tableFilter.breachType || '';

  el.innerHTML = `
    <div class="view-header">
      <div>
        <div class="view-title">Actions</div>
        <div class="view-meta">${num(k.totalBreaches)} active SLA breaches — sorted by severity</div>
      </div>
      <div class="view-actions">
        <button class="btn btn-outline btn-sm" onclick="triggerAnalyze()"><svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg> AI Analysis</button>
      </div>
    </div>
    ${renderSyncStrip(d.meta.source, state.lastProshipSync)}
    <div class="kpi-row">
      <div class="kpi-card"><div class="kpi-label">TOTAL SLA BREACHES</div><div class="kpi-value red">${num(k.totalBreaches)}</div><div class="kpi-sub">Raise with Proship today</div></div>
      <div class="kpi-card"><div class="kpi-label">DELIVERY BREACHES</div><div class="kpi-value red">${num(k.deliveryBreaches)}</div><div class="kpi-sub">&gt;5 days since pickup</div></div>
      <div class="kpi-card"><div class="kpi-label">RTO BREACHES</div><div class="kpi-value red">${num(k.rtoBreaches)}</div><div class="kpi-sub">&gt;5 days since pickup</div></div>
      <div class="kpi-card"><div class="kpi-label">PICKUP &amp; CANCELLATION</div><div class="kpi-value amber">${num(k.pickupCancellationBreaches)}</div><div class="kpi-sub">Not yet picked up / actioned</div></div>
    </div>

    <div class="sla-legend">
      <span><span class="info-dot dot-red"></span><strong>Delivery / RTO / Reverse:</strong> Must complete within <strong>5 days of pickup date</strong></span>
      <span><span class="info-dot dot-amber"></span><strong>Pickup:</strong> Must be picked up within <strong>24 hrs of order</strong></span>
      <span><span class="info-dot dot-amber"></span><strong>Cancellations:</strong> Must be actioned within <strong>24 hrs of order</strong></span>
    </div>

    <div class="filter-chip-row">
      <button class="filter-chip ${active===''?'active':''}" data-type="">All <span class="chip-count">${k.totalBreaches}</span></button>
      <button class="filter-chip ${active==='Delivery overdue'?'active':''}" data-type="Delivery overdue">Delivery overdue <span class="chip-count">${k.deliveryBreaches}</span></button>
      <button class="filter-chip ${active==='RTO overdue'?'active':''}" data-type="RTO overdue">RTO overdue <span class="chip-count">${k.rtoBreaches}</span></button>
      <button class="filter-chip ${active==='Pickup overdue'?'active':''}" data-type="Pickup overdue">Pickup overdue <span class="chip-count">${allShipments.filter(s=>s.breachType==='Pickup overdue').length}</span></button>
      <button class="filter-chip ${active==='Cancellation overdue'?'active':''}" data-type="Cancellation overdue">Cancellation overdue <span class="chip-count">${allShipments.filter(s=>s.breachType==='Cancellation overdue').length}</span></button>
    </div>
    <div id="ai-insight-strip"></div>
    <div class="section-card">
      <div class="section-card-header">
        <span class="section-card-title">Raise with Proship — ${num(k.totalBreaches)} shipments</span>
        <div class="table-filters">
          <input type="text" class="filter-input" id="awb-search" placeholder="Search AWB, city, status…" value="${esc(state.tableFilter.awb||'')}">
          <button class="btn btn-outline btn-sm" onclick="copyAWBs()"><svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg> Copy AWBs</button>
          <button class="btn btn-outline btn-sm" onclick="exportCSV()"><svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Export CSV</button>
        </div>
      </div>
      <div class="table-scroll" id="cancellations-table-wrap"></div>
    </div>`;

  if (insight) renderInsightStrip(document.getElementById('ai-insight-strip'), insight.message, insight.timestamp);
  document.getElementById('awb-search').addEventListener('input', e => { state.tableFilter.awb = e.target.value; renderCancellationsTable(d.shipments||[]); });
  document.querySelectorAll('.filter-chip-row [data-type]').forEach(btn => {
    btn.addEventListener('click', () => { state.tableFilter.breachType = btn.dataset.type; renderCancellations(); });
  });
  renderCancellationsTable(d.shipments||[]);
}

// Copy AWBs of currently filtered breaches to clipboard
function copyAWBs() {
  const rows = getFilteredBreachRows();
  const text = rows.map(r => r.awb).join('\n');
  navigator.clipboard.writeText(text).then(() => toast(`Copied ${rows.length} AWBs`, 'success')).catch(() => toast('Copy failed', 'error'));
}

// Export filtered breaches as CSV
function exportCSV() {
  const rows = getFilteredBreachRows();
  const header = ['AWB','Status','Breach Type','City','Pickup Date','Days Elapsed','SLA Limit'];
  const csv = [header.join(','), ...rows.map(r => [r.awb, r.status, r.breachType, r.city, r.pickupDate, r.daysElapsed, r.slaLimit].map(v => `"${String(v||'').replace(/"/g,'""')}"`).join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `sla-breaches-${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function getFilteredBreachRows() {
  const data = state.cancellations?.shipments || [];
  const f = state.tableFilter;
  let rows = data;
  if (f.awb) rows = rows.filter(r => (r.awb + ' ' + r.city + ' ' + r.status).toLowerCase().includes(f.awb.toLowerCase()));
  if (f.breachType) rows = rows.filter(r => r.breachType === f.breachType);
  return rows;
}

function renderCancellationsTable(data) {
  const f = state.tableFilter;
  let rows = data;
  if (f.awb) rows = rows.filter(r=>(r.awb + ' ' + r.city + ' ' + r.status).toLowerCase().includes(f.awb.toLowerCase()));
  if (f.breachType) rows = rows.filter(r=>r.breachType.toLowerCase().includes(f.breachType.toLowerCase()));
  if (f.city) rows = rows.filter(r=>r.city===f.city);
  if (f.severity) rows = rows.filter(r=>r.severity===f.severity);
  const sorted = sortData(rows, state.tableSort.key||'daysElapsed', state.tableSort.dir||'desc');
  const wrap = document.getElementById('cancellations-table-wrap');
  if (!wrap) return;
  wrap.innerHTML = `<table class="data-table"><thead><tr>${thSort('awb','AWB')}${thSort('status','Status')}<th>Breach</th>${thSort('city','City')}${thSort('pickupDate','Pickup / Order')}${thSort('daysElapsed','Days Elapsed')}<th>SLA</th></tr></thead><tbody>${sorted.map(r=>`<tr>
    <td class="td-mono">${esc(r.awb)}</td>
    <td style="color:var(--text-2);font-size:12px">${esc(r.status)}</td>
    <td><span class="badge ${r.severity==='red'?'badge-red':'badge-amber'}">${esc(r.breachType)}</span></td>
    <td>${esc(r.city)}</td>
    <td style="font-size:12px;color:var(--text-2)">${esc(r.pickupDate)}</td>
    <td><span class="${r.severity==='red'?'days-red':'days-amber'}">${r.daysElapsed}d</span></td>
    <td style="color:var(--text-3);font-size:11.5px">${esc(r.slaLimit)}</td>
  </tr>`).join('')}</tbody><tfoot><tr><td>Showing ${sorted.length} of ${data.length}</td><td colspan="6"></td></tr></tfoot></table>`;
  wrap.querySelector('thead').addEventListener('click', handleSort);
}

// ── SETTINGS ──────────────────────────────────────────────────────────────────
function renderSettings() {
  const el = document.getElementById('content');
  const s = state.settings;

  el.innerHTML = `
    <div class="view-header">
      <div><div class="view-title">Settings</div><div class="view-meta">Integrations, alerts, and notifications</div></div>
    </div>
    <div class="settings-grid">

      <div class="settings-card">
        <div class="settings-card-header"><span class="settings-card-title">Proship API</span><div class="proship-status" id="proship-status-indicator"></div></div>
        <div class="settings-card-body">
          <div class="form-row">
            <label class="form-label">Proship Username</label>
            <input class="form-input" id="s-proship-user" type="text" value="${esc(s.proshipUsername||'')}" placeholder="your@email.com" autocomplete="off">
          </div>
          <div class="form-row">
            <label class="form-label">Password</label>
            <input class="form-input" id="s-proship-pass" type="password" value="${esc(s.proshipPassword||'')}" placeholder="••••••••" autocomplete="new-password">
          </div>
          <div class="form-row">
            <label class="form-label">Auto-sync every</label>
            <select class="form-select" id="s-poll-interval">
              <option value="15" ${s.pollIntervalMinutes==15?'selected':''}>15 minutes</option>
              <option value="30" ${s.pollIntervalMinutes==30?'selected':''}>30 minutes</option>
              <option value="60" ${s.pollIntervalMinutes==60?'selected':''}>1 hour</option>
              <option value="360" ${s.pollIntervalMinutes==360?'selected':''}>6 hours</option>
            </select>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn btn-primary btn-sm" onclick="saveProshipSettings()">Save &amp; Start Sync</button>
            <button class="btn btn-outline btn-sm" id="test-proship-btn" onclick="testProship()">Test Connection</button>
          </div>
          <div id="proship-test-result" style="margin-top:8px;font-size:12px"></div>
          ${state.lastProshipSync ? `<div class="form-hint" style="margin-top:8px">Last sync: ${fmtRelative(state.lastProshipSync)}</div>` : ''}
        </div>
      </div>

      <div class="settings-card">
        <div class="settings-card-header">
          <span class="settings-card-title">WhatsApp</span>
          ${state.waConnected ? '<span class="badge badge-green">Connected</span>' : ''}
        </div>
        <div class="settings-card-body">
          <div class="wa-section" id="wa-section">
            ${renderWASection()}
          </div>
        </div>
      </div>

      <div class="settings-card">
        <div class="settings-card-header"><span class="settings-card-title">Alert Thresholds</span></div>
        <div class="settings-card-body">
          <div class="form-row">
            <label class="form-label">Alert when breaches exceed</label>
            <input class="form-input" id="s-threshold" type="number" value="${s.breachThreshold||10}" min="1">
            <div class="form-hint">Currently ${state.totalBreaches} active breaches</div>
          </div>
          <div class="form-row">
            <label class="form-label">Notification schedule</label>
            <select class="form-select" id="s-notif-mode">
              <option value="realtime" ${s.notificationMode==='realtime'?'selected':''}>Real-time only</option>
              <option value="daily" ${s.notificationMode==='daily'?'selected':''}>Daily digest only (9 AM IST)</option>
              <option value="both" ${s.notificationMode==='both'?'selected':''}>Both</option>
            </select>
          </div>
          <button class="btn btn-primary btn-sm" onclick="saveAlertSettings()">Save</button>
        </div>
      </div>

      <div class="settings-card">
        <div class="settings-card-header"><span class="settings-card-title">Slack</span></div>
        <div class="settings-card-body">
          <div class="form-row">
            <label class="form-label">Incoming Webhook URL</label>
            <input class="form-input" id="s-slack-webhook" type="text" placeholder="https://hooks.slack.com/services/…" value="${esc(s.slackWebhook||'')}">
          </div>
          <div style="display:flex;gap:8px">
            <button class="btn btn-primary btn-sm" onclick="saveSlackSettings()">Save</button>
            <button class="btn btn-outline btn-sm" onclick="testSlack()">Send test</button>
          </div>
        </div>
      </div>

      <div class="settings-card">
        <div class="settings-card-header"><span class="settings-card-title">Prozo Webhook Receiver</span></div>
        <div class="settings-card-body">
          <div class="form-row">
            <label class="form-label">Your webhook URL</label>
            <div style="padding:7px 10px;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--r);font-family:monospace;font-size:11.5px;color:var(--text-2)">${window.location.origin}/api/webhook/prozo</div>
            <div class="form-hint">Email techsupport@prozo.com with this URL to enable push events</div>
          </div>
        </div>
      </div>

    </div>`;

  // Proship status indicator
  const ind = document.getElementById('proship-status-indicator');
  if (ind) {
    if (s.proshipUsername && s.proshipPassword) {
      ind.innerHTML = `<div class="proship-dot"></div><span style="color:var(--green)">Connected</span>`;
    } else {
      ind.innerHTML = `<div class="proship-dot unknown"></div><span style="color:var(--text-3)">Not configured</span>`;
    }
  }
}

function renderWASection() {
  if (state.waConnected) {
    const recipients = state.settings.waRecipients || [];
    return `
      <div class="wa-connected-badge">✓ WhatsApp connected</div>
      <div class="form-row" style="margin-top:12px">
        <label class="form-label">Auto-alert groups <span style="color:var(--text-3);font-weight:400">(checked groups receive breach alerts &amp; daily digests)</span></label>
        <div id="chat-picker-container">${renderChatPickerInner()}</div>
      </div>
      <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-outline btn-sm" onclick="refreshWAChats()">Refresh groups</button>
        <button class="btn btn-danger btn-sm" onclick="disconnectWA()">Disconnect WhatsApp</button>
      </div>
      <div class="form-hint" style="margin-top:8px">
        ${recipients.length ? `✓ ${recipients.length} group${recipients.length>1?'s':''} selected for auto-alerts.` : 'No groups selected — alerts won\'t be sent via WhatsApp.'}
        No messages are read by this dashboard.
      </div>`;
  }
  const hasQR = !!state.waQR;
  return `
    <div class="qr-wrap">
      <div class="qr-frame" id="qr-frame">
        <img id="qr-img" src="${hasQR ? state.waQR : ''}" style="display:${hasQR ? 'block' : 'none'};width:100%;height:100%;object-fit:contain">
        <div class="qr-placeholder" id="qr-placeholder" style="display:${hasQR ? 'none' : 'flex'}">${state.waInitializing ? 'Generating QR…' : 'Tap Connect to show QR code'}</div>
      </div>
      <button class="btn btn-primary" id="wa-connect-btn" onclick="initWA()" ${state.waInitializing?'disabled':''}>
        ${state.waInitializing ? 'Connecting…' : 'Connect WhatsApp'}
      </button>
    </div>
    <div class="form-hint" style="text-align:center">
      Scan with your phone. No chats or messages are read — only notifications are sent to groups you select.
    </div>`;
}

function renderChatPickerInner() {
  if (!state.waChats.length) {
    return `<div class="chat-loading">No groups loaded yet</div><button class="btn btn-outline btn-sm" style="margin-top:6px" onclick="loadWAChats()">Load groups</button>`;
  }
  const selected = new Set((state.settings.waRecipients || []).map(r => r.id));
  return `<div class="chat-checklist">${state.waChats.map(c => `
    <label class="chat-check-item">
      <input type="checkbox" value="${esc(c.id)}" ${selected.has(c.id)?'checked':''}
        onchange="toggleRecipient('${esc(c.id)}','${esc(c.name.replace(/'/g,"\\'"))}',${c.isGroup},this.checked)">
      <span class="chat-check-name">${esc(c.name)}</span>
      ${c.participantsCount ? `<span class="chat-check-count">${c.participantsCount}</span>` : ''}
    </label>`).join('')}</div>`;
}

function renderChatPicker() {
  const container = document.getElementById('chat-picker-container');
  if (container) container.innerHTML = renderChatPickerInner();
}

// ── Settings actions ──────────────────────────────────────────────────────────
async function saveProshipSettings() {
  const username = document.getElementById('s-proship-user')?.value?.trim();
  const password = document.getElementById('s-proship-pass')?.value;
  const interval = document.getElementById('s-poll-interval')?.value;
  if (!username || !password) { toast('Enter username and password', 'error'); return; }
  const res = await api('/api/settings', { method:'POST', body:JSON.stringify({ proshipUsername: username, proshipPassword: password, pollIntervalMinutes: interval }) });
  if (res?.ok) {
    toast('Saved — starting sync…', 'success');
    state.settings.proshipUsername = username;
    state.syncing = true;
    await api('/api/proship/sync', { method:'POST', body:'{}' });
  } else toast('Save failed', 'error');
}

async function testProship() {
  const username = document.getElementById('s-proship-user')?.value?.trim();
  const password = document.getElementById('s-proship-pass')?.value;
  const resultEl = document.getElementById('proship-test-result');
  if (!username || !password) { toast('Enter credentials first', 'error'); return; }
  if (resultEl) resultEl.textContent = 'Testing…';
  const res = await api('/api/proship/test', { method:'POST', body:JSON.stringify({ username, password }) });
  if (!resultEl) return;
  if (res?.ok) resultEl.innerHTML = '<span style="color:var(--green)">✓ Connection successful</span>';
  else resultEl.innerHTML = `<span style="color:var(--red)">✗ ${esc(res?.error||'Failed')}</span>`;
}

async function saveAlertSettings() {
  const body = {
    breachThreshold: document.getElementById('s-threshold')?.value,
    notificationMode: document.getElementById('s-notif-mode')?.value
  };
  const res = await api('/api/settings', { method:'POST', body:JSON.stringify(body) });
  if (res?.ok) toast('Saved', 'success');
  else toast('Save failed', 'error');
}

async function saveSlackSettings() {
  const body = { slackWebhook: document.getElementById('s-slack-webhook')?.value };
  const res = await api('/api/settings', { method:'POST', body:JSON.stringify(body) });
  if (res?.ok) toast('Slack webhook saved', 'success');
}

async function testSlack() {
  await saveSlackSettings();
  await api('/api/analyze', { method:'POST', body:'{}' });
  toast('Test alert sent — check Slack', 'info');
}

async function initWA() {
  const btn = document.getElementById('wa-connect-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Connecting…'; }
  state.waInitializing = true;
  updateTopBar();
  const res = await api('/api/whatsapp/init', { method:'POST', body:'{}' });
  if (res?.error) {
    toast(res.error, 'error');
    state.waInitializing = false;
    updateTopBar();
    if (btn) { btn.disabled = false; btn.textContent = 'Connect WhatsApp'; }
  }
}

async function disconnectWA() {
  if (!confirm('Disconnect WhatsApp?')) return;
  await api('/api/whatsapp/disconnect', { method:'POST', body:'{}' });
  state.waConnected = false;
  state.waQR = null;
  state.waChats = [];
  state.waRecipients = [];
  state.settings.waRecipients = [];
  updateTopBar();
  renderSettings();
}

async function loadWAChats() {
  const container = document.getElementById('chat-picker-container');
  if (container) container.innerHTML = '<div class="chat-loading">Loading groups…</div>';
  const data = await api('/api/whatsapp/chats');
  if (data?.chats) {
    state.waChats = data.chats;
    renderChatPicker();
    renderBroadcastGroupList();
  } else {
    if (container) container.innerHTML = '<div class="chat-loading" style="color:var(--red)">Failed to load groups</div>';
  }
}

async function refreshWAChats() {
  const container = document.getElementById('chat-picker-container');
  if (container) container.innerHTML = '<div class="chat-loading">Refreshing…</div>';
  const data = await api('/api/whatsapp/refresh-chats');
  if (data?.chats) {
    state.waChats = data.chats;
    renderChatPicker();
    renderBroadcastGroupList();
    toast(`${data.chats.length} groups loaded`, 'success');
  } else {
    toast('Refresh failed', 'error');
    renderChatPicker();
  }
}

async function toggleRecipient(chatId, chatName, isGroup, checked) {
  const recipients = [...(state.settings.waRecipients || [])];
  if (checked) {
    if (!recipients.find(r => r.id === chatId)) recipients.push({ id: chatId, name: chatName, isGroup });
  } else {
    const idx = recipients.findIndex(r => r.id === chatId);
    if (idx > -1) recipients.splice(idx, 1);
  }
  await api('/api/settings', { method:'POST', body:JSON.stringify({ waRecipients: recipients }) });
  state.settings.waRecipients = recipients;
  state.waRecipients = recipients;
  updateTopBar();
  // Refresh the hint line without full re-render
  const waSection = document.getElementById('wa-section');
  if (waSection) waSection.innerHTML = renderWASection();
}

// ── BROADCAST VIEW ────────────────────────────────────────────────────────────

async function renderBroadcast() {
  const el = document.getElementById('content');
  const s = state.settings || {};
  const [slackStatus, emailStatus, waStatus] = await Promise.all([
    api('/api/slack/status').catch(() => ({ configured: false })),
    api('/api/email/status').catch(() => ({ configured: false })),
    api('/api/whatsapp/status').catch(() => ({ connected: false }))
  ]);
  const tab = state.notifTab || 'slack';
  const mode = s.notificationMode || 'both';

  const tabs = [
    { id: 'slack',    label: 'Slack',    badge: slackStatus?.configured ? 'ok' : 'off' },
    { id: 'email',    label: 'Email',    badge: emailStatus?.configured ? 'ok' : 'off' },
    { id: 'whatsapp', label: 'WhatsApp', badge: waStatus?.connected ? 'ok' : 'off' }
  ];

  el.innerHTML = `
    <div class="view-header">
      <div>
        <div class="view-title">Notifications</div>
        <div class="view-meta">Send SLA breach alerts and the daily digest to your team via Slack, Email, or WhatsApp</div>
      </div>
    </div>

    <div class="notif-tabs">
      ${tabs.map(t => `<button class="notif-tab ${tab===t.id?'active':''}" data-tab="${t.id}">
        ${t.label}
        <span class="notif-tab-dot ${t.badge==='ok'?'dot-green':'dot-muted'}"></span>
      </button>`).join('')}
    </div>

    <div id="notif-panel-body">
      ${tab === 'slack' ? renderSlackPanel({ slackStatus, mode, webhook: s.slackWebhook || '' })
        : tab === 'email' ? renderEmailPanel({ emailStatus, mode })
        : renderWhatsAppPanel({ waStatus, recipients: s.waRecipients || [] })}
    </div>`;

  document.querySelectorAll('.notif-tab').forEach(btn => {
    btn.addEventListener('click', () => { state.notifTab = btn.dataset.tab; renderBroadcast(); });
  });
  document.querySelectorAll('input[name="notif-mode"]').forEach(r => {
    r.addEventListener('change', () => {
      document.querySelectorAll('.slack-mode-option').forEach(o => o.classList.remove('selected'));
      r.closest('.slack-mode-option').classList.add('selected');
    });
  });
  if (tab === 'whatsapp' && waStatus?.connected) loadWAChats();
}

function renderSlackPanel({ slackStatus, mode, webhook }) {
  return `
    <div class="slack-grid">
      <div class="slack-card">
        <div class="slack-card-head">
          <span class="slack-card-title">① Connect Slack</span>
          ${slackStatus?.configured ? '<span class="badge badge-green">Connected</span>' : '<span class="badge badge-amber">Not connected</span>'}
        </div>
        <p class="slack-card-desc">Paste an <strong>Incoming Webhook</strong> URL from <a href="https://api.slack.com/apps" target="_blank" rel="noopener">api.slack.com/apps</a> — no bot/OAuth needed.</p>
        <div class="form-row">
          <label class="form-label">Slack Incoming Webhook URL</label>
          <input class="form-input" id="slack-webhook-input" type="password" placeholder="https://hooks.slack.com/services/…" value="${esc(webhook)}" autocomplete="off">
          ${slackStatus?.redacted ? `<div class="form-hint">Saved: <code>${esc(slackStatus.redacted)}</code></div>` : ''}
        </div>
        <div class="form-actions">
          <button class="btn btn-primary btn-sm" onclick="saveSlackWebhook()">Save</button>
          <button class="btn btn-outline btn-sm" onclick="testSlack()" ${webhook ? '' : 'disabled'}>Test</button>
          <button class="btn btn-outline btn-sm" onclick="sendSlackDigestNow()" ${webhook ? '' : 'disabled'}>Send digest now</button>
        </div>
      </div>
      ${renderSchedulePanel(mode)}
    </div>`;
}

function renderEmailPanel({ emailStatus, mode }) {
  const recipients = state.settings?.emailRecipients || emailStatus?.recipients || [];
  return `
    <div class="slack-grid">
      <div class="slack-card">
        <div class="slack-card-head">
          <span class="slack-card-title">① Recipients</span>
          ${emailStatus?.configured ? '<span class="badge badge-green">SMTP connected</span>' : '<span class="badge badge-amber">SMTP not configured</span>'}
        </div>
        ${!emailStatus?.configured ? `
          <div class="info-strip">
            <strong>Server-side setup required.</strong> Add these env vars on Render:
            <ul style="margin:6px 0 0 18px;font-size:12px">
              <li><code>SMTP_HOST</code> (e.g. <code>smtp.gmail.com</code>, <code>smtp.resend.com</code>)</li>
              <li><code>SMTP_PORT</code> (<code>587</code> for STARTTLS, <code>465</code> for SSL)</li>
              <li><code>SMTP_USER</code> and <code>SMTP_PASS</code> (for Gmail: a 16-char <a href="https://myaccount.google.com/apppasswords" target="_blank">App Password</a>; for Resend: use <code>resend</code> / API key)</li>
              <li><code>SMTP_FROM</code> (optional — defaults to <code>SMTP_USER</code>)</li>
            </ul>
          </div>
        ` : ''}
        <div class="form-row">
          <label class="form-label">Send alerts to these addresses (one per line)</label>
          <textarea class="form-input" id="email-recipients" rows="5" placeholder="ops@company.com&#10;team@company.com">${recipients.join('\n')}</textarea>
          <div class="form-hint">Emails will be sent to all recipients on the To: line. Separate with newlines.</div>
        </div>
        <div class="form-actions">
          <button class="btn btn-primary btn-sm" onclick="saveEmailRecipients()">Save recipients</button>
          <button class="btn btn-outline btn-sm" onclick="testEmail()" ${emailStatus?.configured ? '' : 'disabled'}>Send test email</button>
          <button class="btn btn-outline btn-sm" onclick="sendEmailDigestNow()" ${emailStatus?.configured && recipients.length ? '' : 'disabled'}>Send digest now</button>
        </div>
      </div>
      ${renderSchedulePanel(mode)}
    </div>`;
}

function renderWhatsAppPanel({ waStatus, recipients }) {
  const connected = waStatus?.connected;
  const initializing = waStatus?.initializing;
  const qr = waStatus?.qr;
  return `
    <div class="slack-grid">
      <div class="slack-card">
        <div class="slack-card-head">
          <span class="slack-card-title">① Connect WhatsApp</span>
          ${connected ? '<span class="badge badge-green">Connected</span>'
            : initializing ? '<span class="badge badge-amber">Scanning QR…</span>'
            : '<span class="badge badge-amber">Not connected</span>'}
        </div>
        <p class="slack-card-desc">
          Links your personal WhatsApp via a one-time QR scan (uses Baileys — WhatsApp Web protocol).
          Once connected the server posts to chats & groups <strong>even when your laptop is closed</strong>
          — the session runs on Render, not your device.
        </p>
        ${!connected && !initializing ? `
          <div class="form-actions">
            <button class="btn btn-primary btn-sm" onclick="initWhatsApp()">Start connection (show QR)</button>
          </div>
        ` : ''}
        ${initializing && qr ? `
          <div class="wa-qr-box">
            <img src="${qr}" alt="WhatsApp QR code" style="width:220px;height:220px;display:block;margin:10px auto;border-radius:8px" />
            <p style="text-align:center;font-size:12px;color:var(--text-2)">
              WhatsApp → Settings → <strong>Linked Devices</strong> → <strong>Link a Device</strong> → scan this QR
            </p>
          </div>
        ` : ''}
        ${connected ? `
          <p style="color:var(--green-text);font-size:12.5px;margin-bottom:10px">
            ✅ Session active on the Render server. Notifications will be sent without needing your laptop online.
          </p>
          <div class="form-actions">
            <button class="btn btn-outline btn-sm" onclick="refreshBroadcastGroups()">Refresh chats &amp; groups</button>
            <button class="btn btn-outline btn-sm" onclick="disconnectWhatsApp()" style="color:var(--red)">Disconnect</button>
          </div>
        ` : ''}
      </div>

      ${connected ? `
        <div class="slack-card">
          <div class="slack-card-head">
            <span class="slack-card-title">② Select chats &amp; groups to notify</span>
            <span id="bc-selected-count" style="font-size:11.5px;color:var(--text-2)">${recipients.length} selected</span>
          </div>
          <div class="broadcast-search-wrap">
            <input class="form-input" id="bc-search" placeholder="Search chats…" oninput="filterBroadcastGroups(this.value)">
          </div>
          <div id="broadcast-group-list" class="broadcast-group-list" style="max-height:340px;overflow-y:auto">
            <div class="broadcast-empty-groups">Loading chats…</div>
          </div>
          <div class="form-actions">
            <button class="btn btn-primary btn-sm" onclick="saveWARecipients()">Save selection</button>
            <button class="btn btn-outline btn-sm" onclick="sendWATestMessage()">Send test message</button>
          </div>
        </div>
      ` : `
        <div class="slack-card">
          <div class="slack-card-head">
            <span class="slack-card-title">Privacy &amp; token usage</span>
          </div>
          <p style="font-size:12.5px;color:var(--text-2);line-height:1.55">
            The server only <strong>sends outgoing messages</strong> — it does not read existing
            conversations, reply to messages, or fetch message history.
          </p>
          <p style="font-size:12.5px;color:var(--text-2);line-height:1.55">
            <strong>⚠️ Note on reliability:</strong> Baileys is an unofficial WhatsApp Web client.
            Meta may rarely disconnect the session (requiring a fresh QR scan). For business-critical
            alerts, keep Email or Slack enabled as a backup.
          </p>
        </div>
      `}
    </div>`;
}

function renderSchedulePanel(mode) {
  return `
    <div class="slack-card">
      <div class="slack-card-head">
        <span class="slack-card-title">② When to notify</span>
        <span class="form-hint" style="margin:0">Applies to all channels</span>
      </div>
      <div class="slack-mode-options">
        <label class="slack-mode-option ${mode==='realtime'?'selected':''}">
          <input type="radio" name="notif-mode" value="realtime" ${mode==='realtime'?'checked':''}>
          <div>
            <div class="slack-mode-title">Real-time only <span class="mode-meta">Instant</span></div>
            <div class="slack-mode-desc">Alert immediately when new SLA breaches appear</div>
          </div>
        </label>
        <label class="slack-mode-option ${mode==='daily'?'selected':''}">
          <input type="radio" name="notif-mode" value="daily" ${mode==='daily'?'checked':''}>
          <div>
            <div class="slack-mode-title">Daily digest only <span class="mode-meta">9 AM IST</span></div>
            <div class="slack-mode-desc">One morning summary with KPIs + top overdue shipments</div>
          </div>
        </label>
        <label class="slack-mode-option ${mode==='both'?'selected':''}">
          <input type="radio" name="notif-mode" value="both" ${mode==='both'?'checked':''}>
          <div>
            <div class="slack-mode-title">Both <span class="mode-meta">Recommended</span></div>
            <div class="slack-mode-desc">Real-time breach alerts plus the daily morning digest</div>
          </div>
        </label>
      </div>
      <div class="form-actions">
        <button class="btn btn-primary btn-sm" onclick="saveSlackMode()">Save schedule</button>
      </div>
    </div>`;
}

// Email handlers
async function saveEmailRecipients() {
  const raw = document.getElementById('email-recipients').value;
  const list = raw.split(/[\n,;]+/).map(s => s.trim()).filter(s => /@/.test(s));
  const res = await api('/api/settings', { method: 'POST', body: JSON.stringify({ emailRecipients: list }) });
  if (res) {
    state.settings.emailRecipients = list;
    toast(`Saved ${list.length} recipient${list.length !== 1 ? 's' : ''}`, 'success');
    renderBroadcast();
  } else toast('Failed to save', 'error');
}

async function testEmail() {
  const raw = document.getElementById('email-recipients').value;
  const list = raw.split(/[\n,;]+/).map(s => s.trim()).filter(s => /@/.test(s));
  if (!list.length) return toast('Add at least one email address first', 'error');
  toast('Sending test email…', 'info');
  const res = await api('/api/email/test', { method: 'POST', body: JSON.stringify({ to: list }) });
  if (res?.ok) toast('✓ Test email sent — check inboxes', 'success');
  else toast(`Email failed: ${res?.error || 'unknown error'}`, 'error');
}

async function sendEmailDigestNow() {
  toast('Sending digest…', 'info');
  const res = await api('/api/email/digest', { method: 'POST' });
  if (res?.ok) toast(`✓ Digest sent to ${(res.accepted||[]).length} recipients`, 'success');
  else toast(`Failed: ${res?.error || 'unknown error'}`, 'error');
}

// WhatsApp handlers
async function initWhatsApp() {
  toast('Starting WhatsApp connection…', 'info');
  await api('/api/whatsapp/init', { method: 'POST' });
  // Poll for QR / connected state
  const pollId = setInterval(async () => {
    const s = await api('/api/whatsapp/status');
    if (s?.connected) { clearInterval(pollId); state.waConnected = true; renderBroadcast(); toast('✓ WhatsApp connected', 'success'); }
    else if (s?.qr && !document.querySelector('.wa-qr-box')) { renderBroadcast(); }
  }, 2000);
}

async function disconnectWhatsApp() {
  if (!confirm('Disconnect WhatsApp? You will need to re-scan the QR to reconnect.')) return;
  await api('/api/whatsapp/disconnect', { method: 'POST' });
  state.waConnected = false;
  state.broadcastSelected = [];
  renderBroadcast();
}

async function saveWARecipients() {
  const ids = state.broadcastSelected || [];
  const chats = state.waChats || [];
  const picked = chats.filter(c => ids.includes(c.id)).map(c => ({ id: c.id, name: c.name }));
  const res = await api('/api/settings', { method: 'POST', body: JSON.stringify({ waRecipients: picked }) });
  if (res) { state.settings.waRecipients = picked; toast(`Saved ${picked.length} recipient${picked.length !== 1 ? 's' : ''}`, 'success'); }
  else toast('Failed to save', 'error');
}

async function sendWATestMessage() {
  const ids = state.broadcastSelected || [];
  if (!ids.length) return toast('Select at least one chat/group first', 'error');
  toast('Sending test…', 'info');
  const res = await api('/api/whatsapp/send', { method: 'POST', body: JSON.stringify({ chatIds: ids, message: '✅ Prozoship alerts are now active in this chat.' }) });
  const okCount = (res?.results || []).filter(r => r.ok).length;
  toast(`✓ Sent to ${okCount}/${ids.length}`, okCount > 0 ? 'success' : 'error');
}

async function sendSlackDigestNow() {
  if (!state.settings.slackWebhook) return toast('Configure Slack webhook first', 'error');
  toast('Sending digest…', 'info');
  const res = await api('/api/slack/digest', { method: 'POST' });
  if (res?.ok) toast('✓ Digest posted to Slack', 'success');
  else toast(`Failed: ${res?.error || 'unknown error'}`, 'error');
}

async function saveSlackWebhook() {
  const val = document.getElementById('slack-webhook-input').value.trim();
  if (val && !val.startsWith('https://hooks.slack.com/')) {
    return toast('Webhook URL should start with https://hooks.slack.com/services/…', 'error');
  }
  const res = await api('/api/settings', { method: 'POST', body: JSON.stringify({ slackWebhook: val }) });
  if (res) {
    state.settings.slackWebhook = val;
    toast(val ? 'Slack webhook saved' : 'Slack disabled', 'success');
    renderBroadcast();
  } else {
    toast('Failed to save', 'error');
  }
}

async function saveSlackMode() {
  const mode = document.querySelector('input[name="slack-mode"]:checked')?.value || 'both';
  const res = await api('/api/settings', { method: 'POST', body: JSON.stringify({ notificationMode: mode }) });
  if (res) {
    state.settings.notificationMode = mode;
    toast('Notification schedule saved', 'success');
  } else {
    toast('Failed to save', 'error');
  }
}

async function testSlack() {
  const val = document.getElementById('slack-webhook-input').value.trim() || state.settings.slackWebhook;
  if (!val) return toast('Add your Slack webhook URL first', 'error');
  toast('Sending test message…', 'info');
  const res = await api('/api/slack/test', { method: 'POST', body: JSON.stringify({ webhook: val }) });
  if (res?.ok) toast('✓ Test message posted to your Slack channel', 'success');
  else toast(`Slack test failed: ${res?.error || 'unknown error'}`, 'error');
}


function renderBroadcastGroupListInner(groups, filter) {
  const q = filter.toLowerCase();
  const visible = q ? groups.filter(g => g.name.toLowerCase().includes(q)) : groups;
  if (!visible.length && !groups.length) {
    return `<div class="broadcast-empty-groups">No groups yet — <button class="btn-text" onclick="loadWAChats()">load groups</button></div>`;
  }
  if (!visible.length) return `<div class="broadcast-empty-groups">No groups match "${esc(filter)}"</div>`;
  return visible.map(g => {
    const checked = state.broadcastSelected.includes(g.id);
    return `<label class="broadcast-group-item ${checked?'checked':''}">
      <input type="checkbox" value="${esc(g.id)}" ${checked?'checked':''}
        onchange="toggleBroadcastGroup('${esc(g.id)}',this.checked,this.closest('label'))">
      <span class="broadcast-group-name">${esc(g.name)}</span>
      ${g.participantsCount ? `<span class="broadcast-group-count">${g.participantsCount} members</span>` : ''}
    </label>`;
  }).join('');
}

function renderBroadcastGroupList() {
  const el = document.getElementById('broadcast-group-list');
  if (!el) return;
  const q = document.getElementById('bc-search')?.value || '';
  el.innerHTML = renderBroadcastGroupListInner(state.waChats, q);
}

function toggleBroadcastGroup(id, checked, labelEl) {
  if (checked) {
    if (!state.broadcastSelected.includes(id)) state.broadcastSelected.push(id);
  } else {
    state.broadcastSelected = state.broadcastSelected.filter(x => x !== id);
  }
  if (labelEl) labelEl.classList.toggle('checked', checked);
  const cnt = document.getElementById('bc-selected-count');
  if (cnt) cnt.textContent = `${state.broadcastSelected.length} selected`;
}

function filterBroadcastGroups(q) {
  const el = document.getElementById('broadcast-group-list');
  if (el) el.innerHTML = renderBroadcastGroupListInner(state.waChats, q);
}

function selectAllBroadcast() {
  const q = document.getElementById('bc-search')?.value?.toLowerCase() || '';
  const visible = q ? state.waChats.filter(g => g.name.toLowerCase().includes(q)) : state.waChats;
  visible.forEach(g => { if (!state.broadcastSelected.includes(g.id)) state.broadcastSelected.push(g.id); });
  renderBroadcastGroupList();
  const cnt = document.getElementById('bc-selected-count');
  if (cnt) cnt.textContent = `${state.broadcastSelected.length} selected`;
}

function clearBroadcast() {
  state.broadcastSelected = [];
  renderBroadcastGroupList();
  const cnt = document.getElementById('bc-selected-count');
  if (cnt) cnt.textContent = '0 selected';
}

async function refreshBroadcastGroups() {
  const el = document.getElementById('broadcast-group-list');
  if (el) el.innerHTML = '<div class="broadcast-empty-groups">Refreshing…</div>';
  const data = await api('/api/whatsapp/refresh-chats');
  if (data?.chats) {
    state.waChats = data.chats;
    renderBroadcastGroupList();
    toast(`${data.chats.length} groups loaded`, 'success');
  } else {
    toast('Refresh failed', 'error');
    renderBroadcastGroupList();
  }
}

async function sendBroadcast() {
  if (!state.broadcastSelected.length) { toast('Select at least one group', 'error'); return; }
  const message = document.getElementById('broadcast-message')?.value?.trim();
  if (!message) { toast('Enter a message', 'error'); return; }

  const btn = document.getElementById('send-broadcast-btn');
  if (btn) { btn.disabled = true; btn.innerHTML = 'Sending…'; }

  const res = await api('/api/whatsapp/send', {
    method: 'POST',
    body: JSON.stringify({ chatIds: state.broadcastSelected, message })
  });

  if (res?.results) {
    const ok = res.results.filter(r => r.ok).length;
    const total = res.results.length;
    const resultsEl = document.getElementById('broadcast-send-results');
    if (resultsEl) {
      resultsEl.innerHTML = `<div class="broadcast-result ${ok===total?'ok':'partial'}">
        ${ok===total ? '✓' : '⚠'} Sent to ${ok} of ${total} recipient${total>1?'s':''}
      </div>`;
    }
    toast(`Sent to ${ok}/${total}`, ok > 0 ? 'success' : 'error');
    if (ok > 0) {
      document.getElementById('broadcast-message').value = '';
      document.getElementById('bc-char-count').textContent = '0 / 4096';
    }
  } else {
    toast(res?.error || 'Send failed', 'error');
  }

  if (btn) {
    btn.disabled = false;
    btn.innerHTML = '<svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" style="margin-right:5px"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>Send Message';
  }
}

// ── Notifications panel ───────────────────────────────────────────────────────
function setupNotifPanel() {
  document.getElementById('notif-btn').addEventListener('click', () => {
    document.getElementById('notif-panel').classList.remove('hidden');
    document.getElementById('notif-overlay').classList.remove('hidden');
    loadNotifications();
  });
  document.getElementById('notif-close-btn').addEventListener('click', closeNotifPanel);
  document.getElementById('notif-overlay').addEventListener('click', closeNotifPanel);
  document.getElementById('mark-all-read-btn').addEventListener('click', async () => {
    await api('/api/notifications/read-all', { method:'POST', body:'{}' });
    state.notifications.forEach(n => n.read = true);
    state.unread = 0;
    updateTopBar();
    loadNotifications();
  });
}
function closeNotifPanel() {
  document.getElementById('notif-panel').classList.add('hidden');
  document.getElementById('notif-overlay').classList.add('hidden');
}
async function loadNotifications() {
  const data = await api('/api/notifications');
  if (data) state.notifications = data;
  const list = document.getElementById('notif-list');
  if (!list) return;
  if (!state.notifications.length) { list.innerHTML = '<div class="notif-empty">No notifications yet</div>'; return; }
  list.innerHTML = state.notifications.map(n => `
    <div class="notif-item ${n.read?'read':'unread'}" data-id="${esc(n.id)}">
      <div class="notif-dot"></div>
      <div class="notif-body">
        <div class="notif-text">${esc(n.message)}</div>
        <div class="notif-time">${fmtRelative(n.timestamp)}</div>
      </div>
    </div>`).join('');
  list.querySelectorAll('.notif-item').forEach(el => {
    el.addEventListener('click', () => {
      api(`/api/notifications/${el.dataset.id}/read`, { method:'POST', body:'{}' });
      el.classList.replace('unread', 'read');
    });
  });
}

// ── Upload modal ──────────────────────────────────────────────────────────────
function setupUpload() {
  document.getElementById('upload-trigger-btn').addEventListener('click', openUploadModal);
  document.getElementById('upload-overlay').addEventListener('click', closeUploadModal);
  document.querySelector('.modal-close-btn').addEventListener('click', closeUploadModal);
  document.getElementById('choose-files-btn').addEventListener('click', () => document.getElementById('file-input').click());
  document.getElementById('file-input').addEventListener('change', e => handleFiles(e.target.files));
  const zone = document.getElementById('upload-drop-zone');
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', e => { e.preventDefault(); zone.classList.remove('drag-over'); handleFiles(e.dataTransfer.files); });
}
function openUploadModal() {
  document.getElementById('upload-modal').classList.remove('hidden');
  document.getElementById('upload-overlay').classList.remove('hidden');
  document.getElementById('upload-results').innerHTML = '';
}
function closeUploadModal() {
  document.getElementById('upload-modal').classList.add('hidden');
  document.getElementById('upload-overlay').classList.add('hidden');
}
async function handleFiles(files) {
  if (!files.length) return;
  const fd = new FormData();
  for (const f of files) fd.append('reports', f);
  document.getElementById('upload-results').innerHTML = '<div style="padding:8px 12px;font-size:12px;color:var(--text-3)">Uploading…</div>';
  try {
    const res = await fetch('/api/upload', { method:'POST', body:fd });
    const data = await res.json();
    document.getElementById('upload-results').innerHTML = (data.results||[]).map(r =>
      `<div class="upload-result-item ${r.ok?'ok':'err'}">${r.ok?'✓':'✗'} <strong>${esc(r.name)}</strong> ${r.ok?`→ ${esc(r.type)} report loaded`:`— ${esc(r.error)}`}</div>`
    ).join('');
    const ok = (data.results||[]).filter(r=>r.ok);
    if (ok.length) {
      toast(`${ok.length} report${ok.length>1?'s':''} loaded`, 'success');
      await loadData();
      renderCurrentView();
      setTimeout(closeUploadModal, 1800);
    }
  } catch (e) { toast('Upload failed', 'error'); }
}

// ── Actions ───────────────────────────────────────────────────────────────────
async function triggerSync() {
  if (state.syncing) { toast('Sync already running…', 'info'); return; }
  if (!state.settings.proshipUsername) { toast('No Proship credentials — configure in Settings first', 'error'); return; }
  state.syncing = true;
  toast('Syncing from Proship…', 'info');
  await api('/api/proship/sync', { method:'POST', body:'{}' });
}

async function triggerAnalyze() {
  toast('Running AI analysis…', 'info');
  await api('/api/analyze', { method:'POST', body:'{}' });
}

// ── Toast ─────────────────────────────────────────────────────────────────────
function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  await initAuthGuard();
  applyRoleToUI();
  setupSSE();
  setupNavigation();
  setupNotifPanel();
  setupUpload();
  setupDateRangeBar();
  await loadData();
  const lu = state.delivery?.meta?.lastUpdated || state.pickup?.meta?.lastUpdated || state.cancellations?.meta?.lastUpdated;
  if (lu) document.getElementById('sidebar-last-updated').textContent = `Updated ${fmtDate(lu)}`;
  // If team role landed on an admin-only view (URL hash), bounce them to Summary
  if (!isAdmin() && (state.view === 'settings' || state.view === 'broadcast')) {
    state.view = 'delivery';
  }
  renderCurrentView();
  updateTopBar();
  renderUserBadge();
}

// Hide Settings + Notifications nav items for non-admins. Also mark body so
// CSS can hide inline admin-only buttons (Upload Reports, Refresh, etc.)
function applyRoleToUI() {
  const admin = isAdmin();
  document.body.classList.toggle('role-admin', admin);
  document.body.classList.toggle('role-team', !admin);
  if (!admin) {
    // Hide nav items that only admins should see
    document.querySelectorAll('[data-view="settings"], [data-view="broadcast"]').forEach(el => el.classList.add('hidden'));
    // Hide "Upload Reports" in the topbar
    document.getElementById('upload-trigger-btn')?.classList.add('hidden');
  }
}

// Small user chip under the sidebar showing current email + role, with sign-out
function renderUserBadge() {
  const footer = document.querySelector('.sidebar-footer');
  if (!footer || !state.currentUser?.email) return;
  const existing = document.getElementById('user-badge');
  if (existing) existing.remove();
  const div = document.createElement('div');
  div.id = 'user-badge';
  div.className = 'user-badge';
  const role = state.currentUser.role || 'team';
  div.innerHTML = `
    <div class="user-badge-line user-badge-email" title="${esc(state.currentUser.email)}">${esc(state.currentUser.email)}</div>
    <div class="user-badge-line">
      <span class="user-role role-${role}">${role === 'admin' ? 'Admin' : 'Team'}</span>
      <button class="btn-text" onclick="signOut()">Sign out</button>
    </div>`;
  footer.insertBefore(div, footer.firstChild);
}

async function signOut() {
  try { if (_supabaseClient) await _supabaseClient.auth.signOut(); } catch (e) {}
  window.location.href = '/login';
}

document.addEventListener('DOMContentLoaded', init);
