'use strict';
const https = require('https');
const { Transform } = require('stream');
const { parser } = require('stream-json');
const { streamArray } = require('../node_modules/stream-json/src/streamers/stream-array.js');
const { pick } = require('../node_modules/stream-json/src/filters/pick.js');
const { chain } = require('stream-chain');

const BASE_HOST = 'proship.prozo.com';

// ── Auth state ────────────────────────────────────────────────────────────────
let _jwt = null;
let _jwtExpiry = 0;

async function httpsPost(path, body, token) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const opts = {
      hostname: BASE_HOST,
      port: 443,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        ...(token ? { 'Authorization': `Bearer ${token}` } : {})
      }
    };
    const req = https.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const buf = Buffer.concat(chunks);
          resolve({ status: res.statusCode, json: () => JSON.parse(buf.toString('utf8')) });
        } catch (e) {
          reject(new Error(`JSON parse failed: ${e.message}`));
        }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ── Login ─────────────────────────────────────────────────────────────────────
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
  } catch (_) {
    _jwtExpiry = Date.now() + 55 * 60 * 1000;
  }
  console.log(`[Proship] Logged in, token valid until ${new Date(_jwtExpiry).toISOString()}`);
  return token;
}

async function getToken(username, password) {
  if (_jwt && Date.now() < _jwtExpiry) return _jwt;
  return login(username, password);
}

// ── Status mapping ────────────────────────────────────────────────────────────
function normaliseStatus(raw) {
  if (!raw) return 'unknown';
  const s = raw.toUpperCase().replace(/\s+/g, '_');
  const map = {
    DELIVERED: 'delivered',
    RTO_DELIVERED: 'rto_delivered',
    RTO_INTRANSIT: 'rto', RTO_IN_TRANSIT: 'rto',
    CANCELLED: 'cancelled',
    LOST: 'lost',
    IN_TRANSIT: 'in_transit', INTRANSIT: 'in_transit',
    PICKED_UP: 'picked_up',
    OUT_FOR_DELIVERY: 'out_for_delivery',
    DELIVERY_FAILED: 'delivery_failed', FAILED_DELIVERY: 'delivery_failed',
    CANCELLED_PENDING: 'cancelled_pending',
    PICKUP_PENDING: 'pickup_pending',
    PICKUP_FAILED: 'pickup_failed',
    OUT_FOR_PICKUP: 'out_for_pickup',
    AWB_REGISTERED: 'registered',
    ORDER_PLACED: 'registered',
  };
  return map[s] || raw.toLowerCase();
}

function daysBetween(a, b) {
  return Math.abs(new Date(b) - new Date(a)) / 86400000;
}

// ── Drop large unwanted fields during token streaming ─────────────────────────
// The 'merchant' field is ~25MB per order; skip it to avoid memory/perf issues
const SKIP_KEYS = new Set(['merchant', 'courier_id', 'skipRule', 'overriddenCourierRule']);

function makeFieldDropper() {
  // depth is relative to the data array (depth=1 = inside an order object)
  let depth = 0, skipping = false, skipDepth = 0, expectingValue = false;
  return new Transform({
    objectMode: true,
    transform(chunk, _enc, cb) {
      const name = chunk.name;

      if (skipping) {
        if (name === 'startObject' || name === 'startArray') depth++;
        else if (name === 'endObject' || name === 'endArray') {
          depth--;
          if (depth === skipDepth) skipping = false;
        }
        return cb(); // drop token
      }

      if (expectingValue) {
        expectingValue = false;
        if (name === 'startObject' || name === 'startArray') {
          depth++;
          skipDepth = depth - 1;
          skipping = true;
        }
        // drop both the key and the value start token
        return cb();
      }

      if (name === 'startObject' || name === 'startArray') depth++;
      else if (name === 'endObject' || name === 'endArray') depth--;
      else if (name === 'keyValue' && depth === 2 && SKIP_KEYS.has(chunk.value)) {
        // depth=2: inside data array item (depth=1) inside the order object (depth=2)
        expectingValue = true;
        return cb(); // drop the key token
      }

      this.push(chunk);
      cb();
    }
  });
}

// ── Fetch a page of orders using stream-json ──────────────────────────────────
function fetchOrderPage(token, offset, limit) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify({ offset, limit });
    const opts = {
      hostname: BASE_HOST,
      port: 443,
      path: '/api/order/search',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
        'Authorization': `Bearer ${token}`
      }
    };

    const orders = [];
    let req;
    let settled = false;

    function done(err) {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(orders);
    }

    // 4 minute hard timeout per page (each page ~68s at current API speed)
    const timeout = setTimeout(() => {
      console.log(`[Proship] Page offset=${offset} timeout — got ${orders.length} orders`);
      if (req) req.destroy();
      done(null);
    }, 4 * 60 * 1000);

    const pipeline = chain([
      parser(),
      pick({ filter: 'data' }),
      makeFieldDropper(),
      streamArray()
    ]);

    pipeline.on('data', ({ value }) => {
      orders.push(value);
    });

    pipeline.on('end', () => {
      clearTimeout(timeout);
      console.log(`[Proship] Page offset=${offset}: ${orders.length} orders`);
      done(null);
    });

    pipeline.on('error', e => {
      clearTimeout(timeout);
      console.error(`[Proship] Parse error offset=${offset}:`, e.message);
      done(null); // non-fatal — return whatever we got
    });

    req = https.request(opts, res => {
      if (res.statusCode === 401) {
        clearTimeout(timeout);
        done(new Error('401 Unauthorized'));
        return;
      }
      console.log(`[Proship] Fetching offset=${offset} limit=${limit} — HTTP ${res.statusCode}`);
      res.pipe(pipeline);
      res.on('error', e => { clearTimeout(timeout); done(null); });
    });

    req.on('error', e => { clearTimeout(timeout); done(e); });
    req.write(bodyStr);
    req.end();
  });
}

// ── Fetch representative sample across the order history ──────────────────────
async function fetchSampleOrders(username, password) {
  let token = await getToken(username, password);

  // Fetch multiple pages concurrently at different offsets to get a diverse
  // sample: recent orders, mid-history, and older orders
  const OFFSETS = [0, 20, 40, 60, 80];   // first 100 orders (all recent)
  // Add deeper offsets to get some delivered/historical orders
  // We don't know the sort order yet, so spread evenly
  const TOTAL_ESTIMATED = 25068;
  for (const frac of [0.1, 0.25, 0.5, 0.75]) {
    OFFSETS.push(Math.floor(TOTAL_ESTIMATED * frac));
  }

  console.log(`[Proship] Fetching ${OFFSETS.length} pages concurrently (offsets: ${OFFSETS.slice(0,5).join(',')}...)`);

  const pages = await Promise.all(
    OFFSETS.map(offset =>
      fetchOrderPage(token, offset, 20).catch(e => {
        if (e.message.includes('401')) {
          // Token expired mid-flight — refresh and retry once
          return login(username, password).then(t => fetchOrderPage(t, offset, 20));
        }
        console.error(`[Proship] Page offset=${offset} failed:`, e.message);
        return [];
      })
    )
  );

  // Deduplicate by orderId
  const seen = new Set();
  const orders = [];
  for (const page of pages) {
    for (const o of page) {
      const id = o.orderId || o.id;
      if (id && !seen.has(id)) {
        seen.add(id);
        orders.push(o);
      }
    }
  }

  console.log(`[Proship] Total unique orders: ${orders.length}`);
  return orders;
}

// ── Test connection ───────────────────────────────────────────────────────────
async function testConnection(username, password) {
  try {
    await login(username, password);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── Helper: extract date from order_history ───────────────────────────────────
function getDateFromHistory(order, statusEnum) {
  const history = order.order_history || order.orderHistory || [];
  const entry = history.find(h => h.orderStatusEnum === statusEnum);
  return entry?.timestamp || null;
}

// ── Build delivery report ─────────────────────────────────────────────────────
function buildDeliveryReport(orders) {
  if (!orders.length) return null;
  const total = orders.length;

  const getStatus = o => normaliseStatus(o.orderStatus || o.currentStatus || o.orderStatusEnum);

  const delivered = orders.filter(o => getStatus(o) === 'delivered');
  const rto = orders.filter(o => ['rto', 'rto_delivered'].includes(getStatus(o)));
  const cancelled = orders.filter(o => getStatus(o) === 'cancelled');
  const lost = orders.filter(o => getStatus(o) === 'lost');
  const active = orders.filter(o => !['delivered','rto','rto_delivered','cancelled','lost'].includes(getStatus(o)));

  const deliveryRate = parseFloat((delivered.length / total * 100).toFixed(1));

  const tats = delivered.map(o => {
    const pickup = o.pickupDate || o.actualPickupDate || getDateFromHistory(o, 'PICKED_UP');
    const delivery = o.deliveryDate || o.actualDeliveryDate || getDateFromHistory(o, 'DELIVERED');
    if (pickup && delivery) return daysBetween(pickup, delivery);
    if (o.createdDate && delivery) return daysBetween(o.createdDate, delivery);
    return null;
  }).filter(v => v !== null && v > 0 && v < 60);

  const avgTAT = tats.length ? parseFloat((tats.reduce((a,b) => a+b, 0) / tats.length).toFixed(1)) : null;

  const monthMap = {};
  orders.forEach(o => {
    const d = new Date(o.createdDate || o.orderDate || o.order_date);
    if (isNaN(d)) return;
    const key = d.toLocaleString('en', { month: 'short', year: '2-digit' });
    if (!monthMap[key]) monthMap[key] = { volume: 0, delivered: 0 };
    monthMap[key].volume++;
    if (getStatus(o) === 'delivered') monthMap[key].delivered++;
  });
  const monthlyTrend = Object.entries(monthMap).slice(-6).map(([month, v]) => ({
    month, volume: v.volume,
    deliveryRate: v.volume ? parseFloat((v.delivered / v.volume * 100).toFixed(1)) : 0
  }));

  const tatBuckets = { '1':0,'2':0,'3':0,'4':0,'5':0,'6':0,'7':0,'8':0,'9':0,'10+':0 };
  tats.forEach(t => {
    const b = t >= 10 ? '10+' : String(Math.ceil(t));
    tatBuckets[b] = (tatBuckets[b] || 0) + 1;
  });

  const courierMap = {};
  orders.forEach(o => {
    const cp = o.actualCourierProviderName || o.courierPartnerParent || o.courierPartner || o.logisticName || 'Unknown';
    if (!courierMap[cp]) courierMap[cp] = { total: 0, delivered: 0, rto: 0, lost: 0, tats: [] };
    courierMap[cp].total++;
    const st = getStatus(o);
    if (st === 'delivered') courierMap[cp].delivered++;
    if (['rto','rto_delivered'].includes(st)) courierMap[cp].rto++;
    if (st === 'lost') courierMap[cp].lost++;
    const pickup = o.pickupDate || getDateFromHistory(o, 'PICKED_UP');
    const delivery = o.deliveryDate || getDateFromHistory(o, 'DELIVERED');
    if (pickup && delivery) courierMap[cp].tats.push(daysBetween(pickup, delivery));
  });
  const courierPerformance = Object.entries(courierMap)
    .sort((a,b) => b[1].total - a[1].total)
    .map(([partner, v]) => ({
      partner, shipments: v.total,
      deliveryPct: parseFloat((v.delivered / v.total * 100).toFixed(1)),
      rtoPct: parseFloat((v.rto / v.total * 100).toFixed(1)),
      lost: v.lost,
      avgTAT: v.tats.length ? parseFloat((v.tats.reduce((a,b)=>a+b,0)/v.tats.length).toFixed(1)) : null
    }));

  const onTimeDelivery = tats.length ? parseFloat((tats.filter(t => t <= 5).length / tats.length * 100).toFixed(1)) : 0;

  return {
    type: 'delivery',
    meta: { lastUpdated: new Date().toISOString(), source: 'Proship API', sampleSize: total },
    kpis: { totalShipments: total, deliveryRate, avgTAT: avgTAT || 0, onTimeDelivery, deliveredCount: delivered.length },
    monthlyTrend,
    tatDistribution: Object.entries(tatBuckets).map(([days, count]) => ({ days, count })),
    statusBreakdown: { delivered: delivered.length, rto: rto.length, cancelled: cancelled.length, lost: lost.length, active: active.length },
    onTimeByMonth: monthlyTrend.map(m => ({ month: m.month, onTimePct: m.deliveryRate })),
    courierPerformance
  };
}

// ── Build pickup report ───────────────────────────────────────────────────────
function buildPickupReport(orders) {
  const getStatus = o => normaliseStatus(o.orderStatus || o.currentStatus || o.orderStatusEnum);
  const pendingStatuses = ['in_transit','picked_up','out_for_delivery','out_for_pickup','pickup_pending','pickup_failed','cancelled_pending','rto','delivery_failed','registered'];
  const pending = orders.filter(o => pendingStatuses.includes(getStatus(o)));
  const now = new Date();

  const slaRules = {
    in_transit: { days: 5, fromField: 'pickupDate', label: '5 days from pickup' },
    picked_up: { days: 5, fromField: 'pickupDate', label: '5 days from pickup' },
    out_for_delivery: { days: 5, fromField: 'pickupDate', label: '5 days from pickup' },
    rto: { days: 5, fromField: 'pickupDate', label: '5 days from pickup' },
    delivery_failed: { days: 5, fromField: 'pickupDate', label: '5 days from pickup' },
    out_for_pickup: { hours: 24, fromField: 'createdDate', label: '24 hrs from order' },
    pickup_pending: { hours: 24, fromField: 'createdDate', label: '24 hrs from order' },
    pickup_failed: { hours: 24, fromField: 'createdDate', label: '24 hrs from order' },
    cancelled_pending: { hours: 24, fromField: 'createdDate', label: '24 hrs from order' },
    registered: { hours: 48, fromField: 'createdDate', label: '48 hrs from order' },
  };

  const grouped = {};
  pending.forEach(o => {
    const cat = getStatus(o);
    if (!grouped[cat]) grouped[cat] = { total: 0, breached: 0 };
    grouped[cat].total++;
    const rule = slaRules[cat];
    if (rule) {
      const ref = new Date(o[rule.fromField] || o.createdDate);
      const elapsed = rule.days ? (now - ref) / 86400000 : (now - ref) / 3600000;
      if (elapsed > (rule.days || rule.hours)) grouped[cat].breached++;
    }
  });

  const statusBreakdown = Object.entries(grouped).map(([status, v]) => ({
    status: status.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
    total: v.total,
    withinSLA: v.total - v.breached,
    slaBreached: v.breached,
    description: `${v.total - v.breached} within SLA, ${v.breached} breached`,
    slaRule: slaRules[status]?.label || 'N/A'
  }));

  const totalPending = pending.length;
  const slaBreached = statusBreakdown.reduce((a, r) => a + r.slaBreached, 0);
  return {
    type: 'pickup',
    meta: { lastUpdated: new Date().toISOString(), source: 'Proship API', sampleSize: orders.length },
    kpis: { totalPending, slaBreached, normalPipeline: totalPending - slaBreached },
    statusBreakdown
  };
}

// ── Build cancellations/breach report ────────────────────────────────────────
function buildCancellationsReport(orders) {
  const getStatus = o => normaliseStatus(o.orderStatus || o.currentStatus || o.orderStatusEnum);
  const now = new Date();
  const breached = [];

  orders.forEach(o => {
    const cat = getStatus(o);
    const pickupDate = o.pickupDate || getDateFromHistory(o, 'PICKED_UP');
    const ref = pickupDate ? new Date(pickupDate) : new Date(o.createdDate);
    const daysElapsed = (now - ref) / 86400000;
    const hrsElapsed = (now - new Date(o.createdDate)) / 3600000;

    let breachType = null, severity = 'amber', slaLimit = '';

    if (['rto','rto_delivered'].includes(cat) && daysElapsed > 5) {
      breachType = 'RTO overdue'; severity = daysElapsed > 14 ? 'red' : 'amber'; slaLimit = '5 days';
    } else if (['delivery_failed','in_transit','out_for_delivery'].includes(cat) && daysElapsed > 5) {
      breachType = 'Delivery overdue'; severity = daysElapsed > 10 ? 'red' : 'amber'; slaLimit = '5 days';
    } else if (cat === 'cancelled_pending' && hrsElapsed > 24) {
      breachType = 'Cancellation overdue'; severity = hrsElapsed > 72 ? 'red' : 'amber'; slaLimit = '24 hrs';
    } else if (['pickup_pending','pickup_failed'].includes(cat) && hrsElapsed > 24) {
      breachType = 'Pickup overdue'; severity = hrsElapsed > 72 ? 'red' : 'amber'; slaLimit = '24 hrs';
    }
    if (!breachType) return;

    breached.push({
      awb: o.awb_number || o.waybill || o.awbNumber || o.orderId,
      status: (o.orderStatus || o.currentStatus || '').replace(/_/g, ' '),
      breachType, severity,
      city: o.delivery_details?.toCity || o.delivery_details?.city || o.deliveryDetails?.toCity || '—',
      pickupDate: pickupDate
        ? new Date(pickupDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
        : `No pickup — order ${new Date(o.createdDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}`,
      isNoPickup: !pickupDate,
      daysElapsed: Math.floor(daysElapsed),
      slaLimit
    });
  });

  breached.sort((a, b) => b.daysElapsed - a.daysElapsed);
  return {
    type: 'cancellations',
    meta: { lastUpdated: new Date().toISOString(), source: 'Proship API', sampleSize: orders.length },
    kpis: {
      totalBreaches: breached.length,
      deliveryBreaches: breached.filter(s => s.breachType === 'Delivery overdue').length,
      rtoBreaches: breached.filter(s => s.breachType === 'RTO overdue').length,
      pickupCancellationBreaches: breached.filter(s => ['Cancellation overdue','Pickup overdue'].includes(s.breachType)).length
    },
    shipments: breached
  };
}

// ── Main sync ─────────────────────────────────────────────────────────────────
async function sync(store, sendSSE, onComplete) {
  const { proshipUsername: username, proshipPassword: password } = store.settings;
  if (!username || !password) return { ok: false, error: 'No credentials configured' };

  try {
    console.log('[Proship] Sync starting…');
    const orders = await fetchSampleOrders(username, password);
    console.log(`[Proship] Processing ${orders.length} orders`);

    if (orders.length > 0) {
      store.delivery = buildDeliveryReport(orders);
      store.pickup = buildPickupReport(orders);
      store.cancellations = buildCancellationsReport(orders);
    }
    store.lastProshipSync = new Date().toISOString();

    if (sendSSE) sendSSE('dataUpdated', {
      hasDelivery: !!store.delivery, hasPickup: !!store.pickup, hasCancellations: !!store.cancellations,
      totalBreaches: store.cancellations?.kpis?.totalBreaches || 0,
      unreadNotifications: store.notifications.filter(n => !n.read).length,
      waConnected: store.settings.waConnected,
      settings: store.settings
    });

    if (onComplete) onComplete();
    return { ok: true, orders: orders.length };
  } catch (e) {
    console.error('[Proship] Sync error:', e.message);
    return { ok: false, error: e.message };
  }
}

let pollTimer = null;

function startPolling(store, sendSSE, analyzeAndAlert, intervalMinutes = 30) {
  if (pollTimer) clearInterval(pollTimer);
  sync(store, sendSSE, analyzeAndAlert);
  pollTimer = setInterval(() => sync(store, sendSSE, analyzeAndAlert), intervalMinutes * 60 * 1000);
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

module.exports = { sync, testConnection, startPolling, stopPolling, login };
