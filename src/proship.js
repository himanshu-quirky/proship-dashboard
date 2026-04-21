'use strict';
const https = require('https');

const BASE_HOST = 'proship.prozo.com';

// Large fields to drop per order (merchant alone is ~25MB per order)
const SKIP_KEYS = new Set(['merchant', 'courier_id', 'skipRule', 'overriddenCourierRule']);

// ── Auth ──────────────────────────────────────────────────────────────────────
let _jwt = null, _jwtExpiry = 0;

async function httpsPost(path, body, token) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const opts = {
      hostname: BASE_HOST, port: 443, path, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      }
    };
    const req = https.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: () => JSON.parse(Buffer.concat(chunks).toString('utf8')) }); }
        catch (e) { reject(new Error('JSON parse failed: ' + e.message)); }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.write(data); req.end();
  });
}

async function login(username, password) {
  const res = await httpsPost('/api/auth/signin', { username, password });
  if (res.status !== 200) throw new Error(`Login failed: HTTP ${res.status}`);
  const data = res.json();
  const token = data.accessToken || data.token;
  if (!token) throw new Error('Login succeeded but no accessToken in response');
  _jwt = token;
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
    _jwtExpiry = (payload.exp * 1000) - 60000;
  } catch (_) { _jwtExpiry = Date.now() + 55 * 60 * 1000; }
  console.log(`[Proship] Logged in — token valid until ${new Date(_jwtExpiry).toISOString()}`);
  return token;
}

async function getToken(username, password) {
  if (_jwt && Date.now() < _jwtExpiry) return _jwt;
  return login(username, password);
}

// ── Streaming Order Extractor ─────────────────────────────────────────────────
// Custom stateful streaming parser — no external dependencies.
// Handles the Proship API response which contains a "data" array where each
// order is ~27MB (mostly the "merchant" field we drop inline).
//
// States: preamble → array → order ↔ skip → done
//
class OrderExtractor {
  constructor() {
    this._cbs = {};
    this._buf = '';
    this._state = 'preamble';
    // order-object state
    this._depth = 0;
    this._inStr = false;
    this._esc = false;
    this._out = '';          // accumulated compact order JSON
    this._fieldStart = 0;    // out.length after last depth-1 comma
    this._keyMode = false;   // collecting a key string at depth=1?
    this._keyBuf = '';
    this._curKey = '';
    // skip-value state (must persist across push() calls)
    this._skStarted = false;
    this._skDepth = 0;       // -1 = skipping string, 0+ = object/array depth
    this._skInStr = false;
    this._skEsc = false;
    this._skGotOpen = false; // consumed opening " for string skip
  }

  on(evt, fn) { this._cbs[evt] = fn; return this; }
  emit(evt, data) { const fn = this._cbs[evt]; if (fn) fn(data); }

  push(chunk) {
    this._buf += (typeof chunk === 'string') ? chunk : chunk.toString('utf8');
    this._run();
  }

  finish() { this.emit('done'); }

  // ── Main loop ──────────────────────────────────────────────────────────────
  _run() {
    let safety = 0;
    while (this._buf.length && this._state !== 'done') {
      const before = this._buf.length;
      if (this._state === 'preamble')  this._preamble();
      else if (this._state === 'array') this._array();
      else if (this._state === 'order') this._order();
      else if (this._state === 'skip')  this._skip();
      // Avoid infinite loop if nothing consumed
      if (this._buf.length === before && ++safety > 3) break;
      else if (this._buf.length !== before) safety = 0;
    }
  }

  // ── State: preamble ────────────────────────────────────────────────────────
  _preamble() {
    const needle = '"data":[';
    const idx = this._buf.indexOf(needle);
    if (idx === -1) {
      if (this._buf.length > needle.length)
        this._buf = this._buf.slice(-(needle.length - 1));
      return;
    }
    this._buf = this._buf.slice(idx + needle.length);
    this._state = 'array';
  }

  // ── State: array (between objects) ────────────────────────────────────────
  _array() {
    while (this._buf.length) {
      const c = this._buf[0];
      this._buf = this._buf.slice(1);
      if (c === '{') { this._startOrder(); this._state = 'order'; return; }
      if (c === ']') { this._state = 'done'; this.emit('done'); return; }
      // skip commas / whitespace
    }
  }

  _startOrder() {
    this._depth = 1;
    this._inStr = false; this._esc = false;
    this._out = '{'; this._fieldStart = 1;
    this._keyMode = false; this._keyBuf = ''; this._curKey = '';
  }

  // ── State: order ──────────────────────────────────────────────────────────
  _order() {
    const buf = this._buf;
    let i = 0;

    while (i < buf.length) {
      const c = buf[i];

      // escape
      if (this._esc) {
        this._esc = false;
        this._out += c;
        if (this._keyMode) this._keyBuf += c;
        i++; continue;
      }

      // inside string
      if (this._inStr) {
        if (c === '\\') { this._esc = true; this._out += c; if (this._keyMode) this._keyBuf += c; }
        else if (c === '"') {
          this._inStr = false; this._out += c;
          if (this._keyMode) { this._curKey = this._keyBuf; this._keyMode = false; }
        }
        else { this._out += c; if (this._keyMode) this._keyBuf += c; }
        i++; continue;
      }

      // outside string
      if (c === '"') {
        this._inStr = true; this._out += c;
        if (this._depth === 1) { this._keyMode = true; this._keyBuf = ''; }
        i++; continue;
      }

      if (c === ':') {
        if (this._depth === 1 && SKIP_KEYS.has(this._curKey)) {
          // Erase this key from out, enter skip-value mode
          this._out = this._out.slice(0, this._fieldStart);
          this._state = 'skip';
          this._skStarted = false; this._skDepth = 0;
          this._skInStr = false; this._skEsc = false; this._skGotOpen = false;
          this._buf = buf.slice(i + 1);
          return;
        }
        this._out += c; this._keyMode = false;
        i++; continue;
      }

      if (c === '{' || c === '[') {
        this._depth++; this._out += c; i++; continue;
      }

      if (c === '}' || c === ']') {
        this._depth--;
        if (this._depth === 0) {
          // Order complete — fix potential trailing comma then emit
          let o = this._out;
          const t = o.trimEnd();
          if (t.endsWith(',')) o = t.slice(0, -1);
          this._buf = buf.slice(i + 1);
          this._emitOrder(o + '}');
          this._state = 'array';
          return;
        }
        this._out += c; i++; continue;
      }

      if (c === ',' && this._depth === 1) {
        this._out += c; this._fieldStart = this._out.length;
        i++; continue;
      }

      this._out += c; i++;
    }

    this._buf = '';
  }

  // ── State: skip (skipping a SKIP_KEY value) ────────────────────────────────
  _skip() {
    let i = 0;
    const buf = this._buf;

    // Consume leading whitespace and detect value type (first call only)
    if (!this._skStarted) {
      while (i < buf.length && ' \t\n\r'.includes(buf[i])) i++;
      if (i >= buf.length) { this._buf = ''; return; }

      const fc = buf[i];
      this._skStarted = true;

      if (fc === '"') {
        // String value — consume opening quote, flag depth=-1
        this._skDepth = -1; i++;
        this._skGotOpen = true;
      } else if (fc === '{' || fc === '[') {
        this._skDepth = 0;
        // Don't advance i — the main loop below will process '{'
      } else {
        // Primitive (number / true / false / null)
        while (i < buf.length && !',}]'.includes(buf[i])) i++;
        if (i < buf.length && buf[i] === ',') i++; // consume trailing comma
        this._buf = buf.slice(i);
        this._state = 'order'; this._fieldStart = this._out.length;
        this._skStarted = false;
        return;
      }
    }

    // Skip string value
    if (this._skDepth === -1) {
      while (i < buf.length) {
        if (this._skEsc) { this._skEsc = false; i++; continue; }
        if (buf[i] === '\\') { this._skEsc = true; i++; continue; }
        if (buf[i] === '"') {
          i++; // closing quote
          while (i < buf.length && ' \t\n\r'.includes(buf[i])) i++;
          if (i < buf.length && buf[i] === ',') i++; // trailing comma
          this._buf = buf.slice(i);
          this._state = 'order'; this._fieldStart = this._out.length;
          this._skStarted = false;
          return;
        }
        i++;
      }
      this._buf = ''; return; // need more data
    }

    // Skip object or array value
    while (i < buf.length) {
      const c = buf[i];
      if (this._skEsc) { this._skEsc = false; i++; continue; }
      if (this._skInStr) {
        if (c === '\\') this._skEsc = true;
        else if (c === '"') this._skInStr = false;
        i++; continue;
      }
      if (c === '"') { this._skInStr = true; i++; continue; }
      if (c === '{' || c === '[') { this._skDepth++; i++; continue; }
      if (c === '}' || c === ']') {
        this._skDepth--;
        i++;
        if (this._skDepth === 0) {
          while (i < buf.length && ' \t\n\r'.includes(buf[i])) i++;
          if (i < buf.length && buf[i] === ',') i++;
          this._buf = buf.slice(i);
          this._state = 'order'; this._fieldStart = this._out.length;
          this._skStarted = false;
          return;
        }
        continue;
      }
      i++;
    }
    this._buf = ''; // need more data
  }

  _emitOrder(text) {
    try { this.emit('order', JSON.parse(text)); }
    catch (e) { console.log('[Proship] Bad order JSON:', e.message, text.slice(0, 80)); }
  }
}

// ── Fetch one page of orders ──────────────────────────────────────────────────
function fetchOrderPage(token, offset, limit) {
  return new Promise((resolve) => {
    const orders = [];
    const bodyStr = JSON.stringify({ offset, limit });
    const opts = {
      hostname: BASE_HOST, port: 443,
      path: '/api/order/search',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
        Authorization: `Bearer ${token}`
      }
    };

    let settled = false;
    function done() {
      if (settled) return; settled = true;
      console.log(`[Proship] offset=${offset}: ${orders.length} orders`);
      resolve(orders);
    }

    const timer = setTimeout(() => {
      console.log(`[Proship] offset=${offset}: timeout after ${orders.length} orders`);
      if (req) req.destroy();
      done();
    }, 5 * 60 * 1000);

    let req;
    req = https.request(opts, res => {
      console.log(`[Proship] GET offset=${offset} limit=${limit} → HTTP ${res.statusCode}`);
      if (res.statusCode !== 200) { clearTimeout(timer); res.resume(); done(); return; }

      const ex = new OrderExtractor();
      ex.on('order', o => orders.push(o));
      ex.on('done', () => { clearTimeout(timer); done(); });

      res.on('data', chunk => ex.push(chunk));
      res.on('end', () => ex.finish());
      res.on('error', () => { clearTimeout(timer); done(); });
    });

    req.on('error', () => { clearTimeout(timer); done(); });
    req.write(bodyStr); req.end();
  });
}

// ── Sample orders from across the full history ────────────────────────────────
async function fetchSampleOrders(username, password) {
  const token = await getToken(username, password);

  // Use 4 concurrent pages spread across the order history
  const TOTAL = 25068;
  const OFFSETS = [0, 20, Math.floor(TOTAL * 0.33), Math.floor(TOTAL * 0.66)];

  console.log(`[Proship] Fetching ${OFFSETS.length} pages (offsets: ${OFFSETS.join(', ')})`);

  const pages = await Promise.all(
    OFFSETS.map(off =>
      fetchOrderPage(token, off, 20).catch(e => {
        console.error(`[Proship] offset=${off} error:`, e.message); return [];
      })
    )
  );

  // Deduplicate
  const seen = new Set(), orders = [];
  for (const page of pages)
    for (const o of page) {
      const id = o.orderId || o.id;
      if (id && !seen.has(id)) { seen.add(id); orders.push(o); }
    }

  console.log(`[Proship] Total unique orders: ${orders.length}`);
  return orders;
}

// ── Status helpers ────────────────────────────────────────────────────────────
function normaliseStatus(raw) {
  if (!raw) return 'unknown';
  const s = raw.toUpperCase().replace(/\s+/g, '_');
  const map = {
    DELIVERED: 'delivered', RTO_DELIVERED: 'rto_delivered',
    RTO_INTRANSIT: 'rto', RTO_IN_TRANSIT: 'rto',
    CANCELLED: 'cancelled', LOST: 'lost',
    IN_TRANSIT: 'in_transit', INTRANSIT: 'in_transit',
    PICKED_UP: 'picked_up', OUT_FOR_DELIVERY: 'out_for_delivery',
    DELIVERY_FAILED: 'delivery_failed', FAILED_DELIVERY: 'delivery_failed',
    CANCELLED_PENDING: 'cancelled_pending', PICKUP_PENDING: 'pickup_pending',
    PICKUP_FAILED: 'pickup_failed', OUT_FOR_PICKUP: 'out_for_pickup',
    AWB_REGISTERED: 'registered', ORDER_PLACED: 'registered',
  };
  return map[s] || raw.toLowerCase();
}

function daysBetween(a, b) { return Math.abs(new Date(b) - new Date(a)) / 86400000; }

function getDateFromHistory(order, statusEnum) {
  const h = order.order_history || order.orderHistory || [];
  return h.find(e => e.orderStatusEnum === statusEnum)?.timestamp || null;
}

// ── Report builders ───────────────────────────────────────────────────────────
function buildDeliveryReport(orders) {
  if (!orders.length) return null;
  const getStatus = o => normaliseStatus(o.orderStatus || o.currentStatus || o.orderStatusEnum);

  const delivered = orders.filter(o => getStatus(o) === 'delivered');
  const rto       = orders.filter(o => ['rto','rto_delivered'].includes(getStatus(o)));
  const cancelled = orders.filter(o => getStatus(o) === 'cancelled');
  const lost      = orders.filter(o => getStatus(o) === 'lost');
  const active    = orders.filter(o => !['delivered','rto','rto_delivered','cancelled','lost'].includes(getStatus(o)));

  const tats = delivered.map(o => {
    const p = o.pickupDate || o.actualPickupDate || getDateFromHistory(o, 'PICKED_UP');
    const d = o.deliveryDate || o.actualDeliveryDate || getDateFromHistory(o, 'DELIVERED');
    if (p && d) return daysBetween(p, d);
    if (o.createdDate && d) return daysBetween(o.createdDate, d);
    return null;
  }).filter(v => v !== null && v > 0 && v < 60);

  const avgTAT = tats.length ? parseFloat((tats.reduce((a,b) => a+b,0)/tats.length).toFixed(1)) : 0;
  const deliveryRate = parseFloat((delivered.length / orders.length * 100).toFixed(1));
  const onTimeDelivery = tats.length ? parseFloat((tats.filter(t => t<=5).length/tats.length*100).toFixed(1)) : 0;

  const monthMap = {};
  const dayMap = {};
  orders.forEach(o => {
    const d = new Date(o.createdDate || o.orderDate);
    if (isNaN(d)) return;
    const mk = d.toLocaleString('en',{month:'short',year:'2-digit'});
    if (!monthMap[mk]) monthMap[mk] = {volume:0,delivered:0};
    monthMap[mk].volume++;
    if (getStatus(o)==='delivered') monthMap[mk].delivered++;
    // Daily aggregation (YYYY-MM-DD) — lets the frontend filter accurately
    const dk = d.toISOString().slice(0,10);
    if (!dayMap[dk]) dayMap[dk] = {volume:0,delivered:0,rto:0,cancelled:0,lost:0,active:0,tats:[]};
    dayMap[dk].volume++;
    const st = getStatus(o);
    if (st==='delivered') dayMap[dk].delivered++;
    else if (['rto','rto_delivered'].includes(st)) dayMap[dk].rto++;
    else if (st==='cancelled') dayMap[dk].cancelled++;
    else if (st==='lost') dayMap[dk].lost++;
    else dayMap[dk].active++;
    const p = o.pickupDate||getDateFromHistory(o,'PICKED_UP');
    const dd = o.deliveryDate||getDateFromHistory(o,'DELIVERED');
    if (p && dd) dayMap[dk].tats.push(daysBetween(p,dd));
  });
  const monthlyTrend = Object.entries(monthMap).slice(-6).map(([month,v]) => ({
    month, volume: v.volume,
    deliveryRate: v.volume ? parseFloat((v.delivered/v.volume*100).toFixed(1)) : 0
  }));
  const dailyTrend = Object.entries(dayMap).sort(([a],[b]) => a.localeCompare(b)).map(([day,v]) => ({
    day,
    volume: v.volume,
    delivered: v.delivered,
    rto: v.rto,
    cancelled: v.cancelled,
    lost: v.lost,
    active: v.active,
    deliveryRate: v.volume ? parseFloat((v.delivered/v.volume*100).toFixed(1)) : 0,
    avgTAT: v.tats.length ? parseFloat((v.tats.reduce((a,b)=>a+b,0)/v.tats.length).toFixed(1)) : null
  }));

  const tatBuckets={'1':0,'2':0,'3':0,'4':0,'5':0,'6':0,'7':0,'8':0,'9':0,'10+':0};
  tats.forEach(t => { const b = t>=10?'10+':String(Math.ceil(t)); tatBuckets[b]=(tatBuckets[b]||0)+1; });

  const cpMap = {};
  orders.forEach(o => {
    const cp = o.actualCourierProviderName || o.courierPartnerParent || o.courierPartner || o.logisticName || 'Unknown';
    if (!cpMap[cp]) cpMap[cp]={total:0,delivered:0,rto:0,lost:0,tats:[]};
    cpMap[cp].total++;
    const st=getStatus(o);
    if (st==='delivered') cpMap[cp].delivered++;
    if (['rto','rto_delivered'].includes(st)) cpMap[cp].rto++;
    if (st==='lost') cpMap[cp].lost++;
    const p=o.pickupDate||getDateFromHistory(o,'PICKED_UP');
    const d=o.deliveryDate||getDateFromHistory(o,'DELIVERED');
    if (p&&d) cpMap[cp].tats.push(daysBetween(p,d));
  });
  const courierPerformance = Object.entries(cpMap).sort((a,b)=>b[1].total-a[1].total).map(([partner,v])=>({
    partner, shipments: v.total,
    deliveryPct: parseFloat((v.delivered/v.total*100).toFixed(1)),
    rtoPct: parseFloat((v.rto/v.total*100).toFixed(1)),
    lost: v.lost,
    avgTAT: v.tats.length ? parseFloat((v.tats.reduce((a,b)=>a+b,0)/v.tats.length).toFixed(1)) : null
  }));

  return {
    type: 'delivery',
    meta: { lastUpdated: new Date().toISOString(), source: 'Proship API', sampleSize: orders.length },
    kpis: { totalShipments: orders.length, deliveryRate, avgTAT, onTimeDelivery, deliveredCount: delivered.length },
    monthlyTrend,
    dailyTrend,
    tatDistribution: Object.entries(tatBuckets).map(([days,count])=>({days,count})),
    statusBreakdown: { delivered:delivered.length, rto:rto.length, cancelled:cancelled.length, lost:lost.length, active:active.length },
    onTimeByMonth: monthlyTrend.map(m=>({month:m.month,onTimePct:m.deliveryRate})),
    courierPerformance
  };
}

function buildPickupReport(orders) {
  const getStatus = o => normaliseStatus(o.orderStatus || o.currentStatus || o.orderStatusEnum);
  const pendingStatuses = ['in_transit','picked_up','out_for_delivery','out_for_pickup','pickup_pending','pickup_failed','cancelled_pending','rto','delivery_failed','registered'];
  const pending = orders.filter(o => pendingStatuses.includes(getStatus(o)));
  const now = new Date();
  const slaRules = {
    in_transit:{days:5,fromField:'pickupDate',label:'5 days from pickup'},
    picked_up:{days:5,fromField:'pickupDate',label:'5 days from pickup'},
    out_for_delivery:{days:5,fromField:'pickupDate',label:'5 days from pickup'},
    rto:{days:5,fromField:'pickupDate',label:'5 days from pickup'},
    delivery_failed:{days:5,fromField:'pickupDate',label:'5 days from pickup'},
    out_for_pickup:{hours:24,fromField:'createdDate',label:'24 hrs from order'},
    pickup_pending:{hours:24,fromField:'createdDate',label:'24 hrs from order'},
    pickup_failed:{hours:24,fromField:'createdDate',label:'24 hrs from order'},
    cancelled_pending:{hours:24,fromField:'createdDate',label:'24 hrs from order'},
    registered:{hours:48,fromField:'createdDate',label:'48 hrs from order'},
  };
  const grouped = {};
  pending.forEach(o => {
    const cat = getStatus(o);
    if (!grouped[cat]) grouped[cat]={total:0,breached:0};
    grouped[cat].total++;
    const rule = slaRules[cat];
    if (rule) {
      const ref = new Date(o[rule.fromField]||o.createdDate);
      const elapsed = rule.days ? (now-ref)/86400000 : (now-ref)/3600000;
      if (elapsed > (rule.days||rule.hours)) grouped[cat].breached++;
    }
  });
  const statusBreakdown = Object.entries(grouped).map(([status,v])=>({
    status: status.replace(/_/g,' ').replace(/\b\w/g,c=>c.toUpperCase()),
    total:v.total, withinSLA:v.total-v.breached, slaBreached:v.breached,
    description:`${v.total-v.breached} within SLA, ${v.breached} breached`,
    slaRule:slaRules[status]?.label||'N/A'
  }));
  const totalPending = pending.length;
  const slaBreached = statusBreakdown.reduce((a,r)=>a+r.slaBreached,0);
  return {
    type:'pickup',
    meta:{lastUpdated:new Date().toISOString(),source:'Proship API',sampleSize:orders.length},
    kpis:{totalPending,slaBreached,normalPipeline:totalPending-slaBreached},
    statusBreakdown
  };
}

function buildCancellationsReport(orders) {
  const getStatus = o => normaliseStatus(o.orderStatus || o.currentStatus || o.orderStatusEnum);
  const now = new Date();
  const breached = [];
  orders.forEach(o => {
    const cat = getStatus(o);
    const pickupDate = o.pickupDate || getDateFromHistory(o,'PICKED_UP');
    const ref = pickupDate ? new Date(pickupDate) : new Date(o.createdDate);
    const daysElapsed = (now-ref)/86400000;
    const hrsElapsed = (now-new Date(o.createdDate))/3600000;
    let breachType=null, severity='amber', slaLimit='';
    if (['rto','rto_delivered'].includes(cat)&&daysElapsed>5)
      { breachType='RTO overdue'; severity=daysElapsed>14?'red':'amber'; slaLimit='5 days'; }
    else if (['delivery_failed','in_transit','out_for_delivery'].includes(cat)&&daysElapsed>5)
      { breachType='Delivery overdue'; severity=daysElapsed>10?'red':'amber'; slaLimit='5 days'; }
    else if (cat==='cancelled_pending'&&hrsElapsed>24)
      { breachType='Cancellation overdue'; severity=hrsElapsed>72?'red':'amber'; slaLimit='24 hrs'; }
    else if (['pickup_pending','pickup_failed'].includes(cat)&&hrsElapsed>24)
      { breachType='Pickup overdue'; severity=hrsElapsed>72?'red':'amber'; slaLimit='24 hrs'; }
    if (!breachType) return;
    breached.push({
      awb: o.awb_number||o.waybill||o.awbNumber||o.orderId,
      status: (o.orderStatus||o.currentStatus||'').replace(/_/g,' '),
      breachType, severity,
      city: o.delivery_details?.toCity||o.delivery_details?.city||o.deliveryDetails?.toCity||'—',
      pickupDate: pickupDate
        ? new Date(pickupDate).toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'numeric'})
        : `No pickup — order ${new Date(o.createdDate).toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'numeric'})}`,
      isNoPickup: !pickupDate,
      daysElapsed: Math.floor(daysElapsed),
      slaLimit
    });
  });
  breached.sort((a,b)=>b.daysElapsed-a.daysElapsed);
  return {
    type:'cancellations',
    meta:{lastUpdated:new Date().toISOString(),source:'Proship API',sampleSize:orders.length},
    kpis:{
      totalBreaches:breached.length,
      deliveryBreaches:breached.filter(s=>s.breachType==='Delivery overdue').length,
      rtoBreaches:breached.filter(s=>s.breachType==='RTO overdue').length,
      pickupCancellationBreaches:breached.filter(s=>['Cancellation overdue','Pickup overdue'].includes(s.breachType)).length
    },
    shipments:breached
  };
}

// ── Test connection ───────────────────────────────────────────────────────────
async function testConnection(username, password) {
  try { await login(username, password); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
}

// ── Main sync ─────────────────────────────────────────────────────────────────
async function sync(store, sendSSE, onComplete) {
  const { proshipUsername: user, proshipPassword: pass } = store.settings;
  if (!user || !pass) return { ok: false, error: 'No credentials configured' };
  try {
    console.log('[Proship] Sync starting…');
    const orders = await fetchSampleOrders(user, pass);
    console.log(`[Proship] Processing ${orders.length} orders`);
    if (orders.length > 0) {
      store.delivery     = buildDeliveryReport(orders);
      store.pickup       = buildPickupReport(orders);
      store.cancellations = buildCancellationsReport(orders);
    }
    store.lastProshipSync = new Date().toISOString();
    if (sendSSE) sendSSE('dataUpdated', {
      hasDelivery: !!store.delivery, hasPickup: !!store.pickup, hasCancellations: !!store.cancellations,
      totalBreaches: store.cancellations?.kpis?.totalBreaches || 0,
      unreadNotifications: store.notifications.filter(n => !n.read).length,
      waConnected: store.settings.waConnected, settings: store.settings
    });
    if (onComplete) onComplete();
    return { ok: true, orders: orders.length };
  } catch (e) {
    console.error('[Proship] Sync error:', e.message);
    return { ok: false, error: e.message };
  }
}

// ── Polling ───────────────────────────────────────────────────────────────────
let pollTimer = null;

function startPolling(store, sendSSE, analyzeAndAlert, intervalMinutes = 30) {
  if (pollTimer) clearInterval(pollTimer);
  sync(store, sendSSE, analyzeAndAlert);
  pollTimer = setInterval(() => sync(store, sendSSE, analyzeAndAlert), intervalMinutes * 60 * 1000);
}

function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

module.exports = { sync, testConnection, startPolling, stopPolling, login };
