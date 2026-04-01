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
  proshipConnected: false,
  lastProshipSync: null,
  totalBreaches: 0,
  unread: 0,
  syncing: false,
  tableSort: { key: null, dir: 'asc' },
  tableFilter: {}
};

const charts = {};

// ── API ───────────────────────────────────────────────────────────────────────
async function api(path, opts = {}) {
  try {
    const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
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
    sse = new EventSource('/api/events');

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
      waTxt.textContent = state.settings.waTargetName ? `WA: ${state.settings.waTargetName.slice(0, 20)}` : 'Connected';
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
  if (state.view === 'delivery') renderDelivery();
  else if (state.view === 'pickup') renderPickup();
  else if (state.view === 'cancellations') renderCancellations();
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
  const hasKey = state.settings.proshipApiKey;
  return `<div class="empty-state">
    <div class="empty-icon">${icon}</div>
    <div class="empty-title">No ${label} data yet</div>
    <div class="empty-sub">${hasKey ? 'Data is being fetched from Proship. This may take a moment on first load.' : 'Connect your Proship account in Settings, or upload a report file manually.'}</div>
    ${hasKey ? `<button class="btn btn-primary" onclick="triggerSync()">Sync Now</button>` : `<button class="btn btn-outline" onclick="setView('settings')">Go to Settings</button>`}
  </div>`;
}

// ── DELIVERY ──────────────────────────────────────────────────────────────────
function renderDelivery() {
  const el = document.getElementById('content');
  const d = state.delivery;
  if (!d) { el.innerHTML = renderEmpty('delivery data', '📦'); return; }
  const k = d.kpis, insight = getAIInsight();

  el.innerHTML = `
    <div class="view-header">
      <div>
        <div class="view-title">Delivery Report</div>
        <div class="view-meta">Last updated ${fmtDate(d.meta.lastUpdated)} · ${esc(d.meta.source || 'Manual upload')}</div>
      </div>
      <div class="view-actions">
        <button class="btn btn-outline btn-sm" onclick="triggerSync()">↻ Refresh</button>
        <button class="btn btn-outline btn-sm" onclick="triggerAnalyze()">Run AI Analysis</button>
      </div>
    </div>

    ${renderSyncStrip(d.meta.source, state.lastProshipSync)}

    <div class="kpi-row">
      <div class="kpi-card">
        <div class="kpi-label">Total Shipments</div>
        <div class="kpi-value">${num(k.totalShipments)}</div>
        <div class="kpi-sub">All couriers</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Delivery Rate</div>
        <div class="kpi-value ${k.deliveryRate >= 95 ? 'green' : k.deliveryRate >= 90 ? 'amber' : 'red'}">${k.deliveryRate}%</div>
        <div class="kpi-sub">${num(k.deliveredCount)} delivered</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Avg TAT</div>
        <div class="kpi-value blue">${k.avgTAT}<span style="font-size:14px;font-weight:400;margin-left:2px">days</span></div>
        <div class="kpi-sub">Pickup to delivery</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">On-Time Delivery</div>
        <div class="kpi-value ${k.onTimeDelivery >= 85 ? 'green' : k.onTimeDelivery >= 70 ? 'amber' : 'red'}">${k.onTimeDelivery}%</div>
        <div class="kpi-sub">vs EDD</div>
      </div>
    </div>

    <div id="ai-insight-strip"></div>

    <div class="chart-grid">
      <div class="chart-card">
        <div class="chart-card-title">Monthly Volume &amp; Delivery Rate</div>
        <div class="chart-wrap"><canvas id="chart-monthly"></canvas></div>
      </div>
      <div class="chart-card">
        <div class="chart-card-title">TAT Distribution</div>
        <div class="chart-wrap"><canvas id="chart-tat"></canvas></div>
      </div>
      <div class="chart-card">
        <div class="chart-card-title">Shipment Status</div>
        <div class="chart-wrap chart-wrap-sm"><canvas id="chart-status"></canvas></div>
        <div id="status-legend" class="donut-legend"></div>
      </div>
      <div class="chart-card">
        <div class="chart-card-title">On-Time % by Month</div>
        <div class="chart-wrap"><canvas id="chart-ontime"></canvas></div>
      </div>
    </div>

    <div class="section-card">
      <div class="section-card-header">
        <span class="section-card-title">Courier Performance</span>
        <span class="section-card-count">${d.courierPerformance.length} partners</span>
      </div>
      <div class="table-scroll" id="courier-table-wrap"></div>
    </div>`;

  if (insight) renderInsightStrip(document.getElementById('ai-insight-strip'), insight.message, insight.timestamp);

  const months = (d.monthlyTrend||[]).map(m=>m.month);
  makeChart('chart-monthly', { type:'bar', data:{ labels:months, datasets:[
    { label:'Shipments', data:(d.monthlyTrend||[]).map(m=>m.volume), backgroundColor:'#0F172A', yAxisID:'y', borderRadius:3 },
    { label:'Delivery %', data:(d.monthlyTrend||[]).map(m=>m.deliveryRate), type:'line', borderColor:'#16A34A', backgroundColor:'transparent', yAxisID:'y1', tension:0.3, pointRadius:3, pointBackgroundColor:'#16A34A' }
  ]}, options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false}}, scales:{ y:{grid:{color:'rgba(0,0,0,0.04)'},ticks:{font:CHART_FONT}}, y1:{position:'right',min:60,max:100,grid:{display:false},ticks:{font:CHART_FONT,callback:v=>v+'%'}}, x:{grid:{display:false},ticks:{font:CHART_FONT}} }}});

  makeChart('chart-tat', { type:'bar', data:{ labels:(d.tatDistribution||[]).map(t=>t.days), datasets:[{ data:(d.tatDistribution||[]).map(t=>t.count), backgroundColor:'#2563EB', borderRadius:3 }]}, options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false}}, scales:{ y:{grid:{color:'rgba(0,0,0,0.04)'},ticks:{font:CHART_FONT}}, x:{title:{display:true,text:'Days',font:CHART_FONT},grid:{display:false},ticks:{font:CHART_FONT}} }}});

  const sb = d.statusBreakdown||{};
  const statusLabels=['Delivered','RTO','Cancelled','Lost','Active'];
  const statusVals=[sb.delivered,sb.rto,sb.cancelled,sb.lost,sb.active];
  const statusColors=['#16A34A','#D97706','#64748B','#DC2626','#2563EB'];
  makeChart('chart-status', { type:'doughnut', data:{ labels:statusLabels, datasets:[{ data:statusVals, backgroundColor:statusColors, borderWidth:0 }]}, options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false}}, cutout:'64%' }});
  const total = statusVals.reduce((a,b)=>(a||0)+(b||0),0)||1;
  document.getElementById('status-legend').innerHTML = statusLabels.map((l,i)=>`<div class="legend-item"><div class="legend-dot" style="background:${statusColors[i]}"></div>${l} ${statusVals[i]?((statusVals[i]/total*100).toFixed(1)+'%'):''}</div>`).join('');

  const onTimeVals=(d.onTimeByMonth||[]).map(m=>m.onTimePct);
  makeChart('chart-ontime', { type:'bar', data:{ labels:(d.onTimeByMonth||[]).map(m=>m.month), datasets:[{ data:onTimeVals, backgroundColor:onTimeVals.map(v=>v>=85?'#16A34A':v>=70?'#D97706':'#DC2626'), borderRadius:3 }]}, options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false}}, scales:{ y:{min:0,max:100,grid:{color:'rgba(0,0,0,0.04)'},ticks:{font:CHART_FONT,callback:v=>v+'%'}}, x:{grid:{display:false},ticks:{font:CHART_FONT}} }}});

  renderCourierTable(d.courierPerformance||[]);
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

// ── PICKUP ────────────────────────────────────────────────────────────────────
function renderPickup() {
  const el = document.getElementById('content');
  const d = state.pickup;
  if (!d) { el.innerHTML = renderEmpty('pickup data', '📦'); return; }
  const k = d.kpis, insight = getAIInsight();
  const filter = state.tableFilter.slaStatus || 'all';

  el.innerHTML = `
    <div class="view-header">
      <div>
        <div class="view-title">Pickup Report</div>
        <div class="view-meta">Last updated ${fmtDate(d.meta.lastUpdated)}</div>
      </div>
      <div class="view-actions">
        <button class="btn btn-outline btn-sm" onclick="triggerSync()">↻ Refresh</button>
      </div>
    </div>
    ${renderSyncStrip(d.meta.source, state.lastProshipSync)}
    <div class="kpi-row">
      <div class="kpi-card"><div class="kpi-label">Total Pending</div><div class="kpi-value amber">${num(k.totalPending)}</div><div class="kpi-sub">Across all statuses</div></div>
      <div class="kpi-card"><div class="kpi-label">SLA Breached</div><div class="kpi-value red">${num(k.slaBreached)}</div><div class="kpi-sub">Action needed</div></div>
      <div class="kpi-card"><div class="kpi-label">Normal Pipeline</div><div class="kpi-value green">${num(k.normalPipeline)}</div><div class="kpi-sub">Within SLA</div></div>
      <div class="kpi-card"><div class="kpi-label">Breach Rate</div><div class="kpi-value ${k.slaBreached/k.totalPending>0.3?'red':'amber'}">${k.totalPending?((k.slaBreached/k.totalPending*100).toFixed(1)):0}%</div><div class="kpi-sub">of all pending</div></div>
    </div>
    <div id="ai-insight-strip"></div>
    <div class="section-card">
      <div class="section-card-header">
        <span class="section-card-title">Pending by Status</span>
        <div class="table-filters">
          <select class="filter-select" id="pickup-sla-filter">
            <option value="all" ${filter==='all'?'selected':''}>All statuses</option>
            <option value="breached" ${filter==='breached'?'selected':''}>Breached only</option>
            <option value="ok" ${filter==='ok'?'selected':''}>Within SLA only</option>
          </select>
        </div>
      </div>
      <div class="table-scroll" id="pickup-table-wrap"></div>
    </div>`;

  if (insight) renderInsightStrip(document.getElementById('ai-insight-strip'), insight.message, insight.timestamp);
  document.getElementById('pickup-sla-filter').addEventListener('change', e => { state.tableFilter.slaStatus = e.target.value; renderPickupTable(d.statusBreakdown||[]); });
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

// ── CANCELLATIONS ─────────────────────────────────────────────────────────────
function renderCancellations() {
  const el = document.getElementById('content');
  const d = state.cancellations;
  if (!d) { el.innerHTML = renderEmpty('breach data', '⚠️'); return; }
  const k = d.kpis, insight = getAIInsight();
  if (!state.tableSort.key) { state.tableSort.key = 'daysElapsed'; state.tableSort.dir = 'desc'; }

  const cities = [...new Set((d.shipments||[]).map(s=>s.city).filter(Boolean))].sort();

  el.innerHTML = `
    <div class="view-header">
      <div>
        <div class="view-title">Cancellations &amp; Returns</div>
        <div class="view-meta">Last updated ${fmtDate(d.meta.lastUpdated)}</div>
      </div>
      <div class="view-actions">
        <button class="btn btn-outline btn-sm" onclick="triggerSync()">↻ Refresh</button>
      </div>
    </div>
    ${renderSyncStrip(d.meta.source, state.lastProshipSync)}
    <div class="kpi-row">
      <div class="kpi-card"><div class="kpi-label">Total SLA Breaches</div><div class="kpi-value red">${num(k.totalBreaches)}</div><div class="kpi-sub">Raise with Proship</div></div>
      <div class="kpi-card"><div class="kpi-label">Delivery Breaches</div><div class="kpi-value red">${num(k.deliveryBreaches)}</div><div class="kpi-sub">&gt;5 days since pickup</div></div>
      <div class="kpi-card"><div class="kpi-label">RTO Breaches</div><div class="kpi-value red">${num(k.rtoBreaches)}</div><div class="kpi-sub">&gt;5 days since pickup</div></div>
      <div class="kpi-card"><div class="kpi-label">Pickup &amp; Cancel</div><div class="kpi-value amber">${num(k.pickupCancellationBreaches)}</div><div class="kpi-sub">Not actioned</div></div>
    </div>
    <div id="ai-insight-strip"></div>
    <div class="section-card">
      <div class="section-card-header">
        <span class="section-card-title">All SLA Breaches</span>
        <div class="table-filters">
          <input type="text" class="filter-input" id="awb-search" placeholder="Search AWB…" style="width:120px" value="${esc(state.tableFilter.awb||'')}">
          <select class="filter-select" id="breach-type-filter">
            <option value="">All types</option>
            <option value="Delivery overdue" ${state.tableFilter.breachType==='Delivery overdue'?'selected':''}>Delivery overdue</option>
            <option value="RTO overdue" ${state.tableFilter.breachType==='RTO overdue'?'selected':''}>RTO overdue</option>
            <option value="Cancellation overdue" ${state.tableFilter.breachType==='Cancellation overdue'?'selected':''}>Cancellation overdue</option>
            <option value="Pickup overdue" ${state.tableFilter.breachType==='Pickup overdue'?'selected':''}>Pickup overdue</option>
          </select>
          <select class="filter-select" id="city-filter">
            <option value="">All cities</option>
            ${cities.map(c=>`<option value="${esc(c)}" ${state.tableFilter.city===c?'selected':''}>${esc(c)}</option>`).join('')}
          </select>
          <select class="filter-select" id="severity-filter">
            <option value="">All severity</option>
            <option value="red" ${state.tableFilter.severity==='red'?'selected':''}>Critical</option>
            <option value="amber" ${state.tableFilter.severity==='amber'?'selected':''}>Warning</option>
          </select>
        </div>
      </div>
      <div class="table-scroll" id="cancellations-table-wrap"></div>
    </div>`;

  if (insight) renderInsightStrip(document.getElementById('ai-insight-strip'), insight.message, insight.timestamp);
  document.getElementById('awb-search').addEventListener('input', e => { state.tableFilter.awb = e.target.value; renderCancellationsTable(d.shipments||[]); });
  document.getElementById('breach-type-filter').addEventListener('change', e => { state.tableFilter.breachType = e.target.value; renderCancellationsTable(d.shipments||[]); });
  document.getElementById('city-filter').addEventListener('change', e => { state.tableFilter.city = e.target.value; renderCancellationsTable(d.shipments||[]); });
  document.getElementById('severity-filter').addEventListener('change', e => { state.tableFilter.severity = e.target.value; renderCancellationsTable(d.shipments||[]); });
  renderCancellationsTable(d.shipments||[]);
}

function renderCancellationsTable(data) {
  const f = state.tableFilter;
  let rows = data;
  if (f.awb) rows = rows.filter(r=>r.awb.toLowerCase().includes(f.awb.toLowerCase()));
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
    const s = state.settings;
    return `
      <div class="wa-connected-badge">✓ WhatsApp connected</div>
      <div class="form-row chat-picker-wrap" style="margin-top:12px">
        <label class="form-label">Send notifications to</label>
        <div id="chat-picker-container">${renderChatPickerInner()}</div>
      </div>
      <div style="margin-top:10px">
        <button class="btn btn-danger btn-sm" onclick="disconnectWA()">Disconnect WhatsApp</button>
      </div>
      <div class="form-hint" style="margin-top:8px">
        Only the selected chat receives notifications. No messages are read by this dashboard.
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
      Scan with your phone. No chats or messages are read — only notifications are sent to a group you pick.
    </div>`;
}

function renderChatPickerInner() {
  if (!state.waChats.length) {
    return `<div class="chat-loading">Loading chats…</div><button class="btn btn-outline btn-sm" onclick="loadWAChats()">Load chats</button>`;
  }
  const selected = state.settings.waTargetChatId || '';
  const groups = state.waChats.filter(c => c.isGroup);
  const contacts = state.waChats.filter(c => !c.isGroup);
  return `<select class="form-select" id="chat-select" onchange="selectChat(this.value, this.options[this.selectedIndex].text)">
    <option value="">Select a chat or group…</option>
    ${groups.length ? `<optgroup label="Groups">${groups.map(c=>`<option value="${esc(c.id)}" ${c.id===selected?'selected':''}>${esc(c.name)}${c.participantsCount?` (${c.participantsCount})`:''}` ).join('')}</optgroup>` : ''}
    ${contacts.length ? `<optgroup label="Contacts">${contacts.slice(0,50).map(c=>`<option value="${esc(c.id)}" ${c.id===selected?'selected':''}>${esc(c.name)}</option>`).join('')}</optgroup>` : ''}
  </select>
  ${selected ? `<div class="form-hint" style="margin-top:4px">✓ Sending to: <strong>${esc(state.settings.waTargetName||selected)}</strong></div>` : ''}`;
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
  state.settings.waTargetChatId = '';
  state.settings.waTargetName = '';
  updateTopBar();
  renderSettings();
}

async function loadWAChats() {
  const container = document.getElementById('chat-picker-container');
  if (container) container.innerHTML = '<div class="chat-loading">Loading…</div>';
  const data = await api('/api/whatsapp/chats');
  if (data?.chats) {
    state.waChats = data.chats;
    renderChatPicker();
  } else {
    if (container) container.innerHTML = '<div class="chat-loading" style="color:var(--red)">Failed to load chats</div>';
  }
}

async function selectChat(chatId, chatName) {
  if (!chatId) return;
  const cleanName = chatName.replace(/^(Groups|Contacts)\s*\/\s*/, '').trim();
  await api('/api/settings', { method:'POST', body:JSON.stringify({ waTargetChatId: chatId, waTargetName: cleanName }) });
  state.settings.waTargetChatId = chatId;
  state.settings.waTargetName = cleanName;
  updateTopBar();
  renderChatPicker();
  toast(`Notifications → ${cleanName}`, 'success');
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
  if (!state.settings.proshipApiKey) { toast('No Proship API key — use Upload Reports instead', 'error'); return; }
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
  setupSSE();
  setupNavigation();
  setupNotifPanel();
  setupUpload();
  await loadData();
  const lu = state.delivery?.meta?.lastUpdated || state.pickup?.meta?.lastUpdated || state.cancellations?.meta?.lastUpdated;
  if (lu) document.getElementById('sidebar-last-updated').textContent = `Updated ${fmtDate(lu)}`;
  renderCurrentView();
  updateTopBar();
}

document.addEventListener('DOMContentLoaded', init);
