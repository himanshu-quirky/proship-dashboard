#!/usr/bin/env node
require('dotenv').config();
const https = require('https');

const BASE_HOST = 'proship.prozo.com';
const username = process.env.PROSHIP_USERNAME;
const password = process.env.PROSHIP_PASSWORD;
const merchantId = '688cb69e9af82b288c34c4ff';

function request(path, { method = 'GET', body, token } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: BASE_HOST, port: 443, path, method,
      headers: {
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      }
    };
    const req = https.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const txt = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, body: txt });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function login() {
  const res = await request('/api/auth/signin', { method: 'POST', body: { username, password } });
  const json = JSON.parse(res.body);
  return json.accessToken || json.token;
}

async function main() {
  const token = await login();
  console.log('=== Logged in ===\n');

  const from = '2026-04-14';
  const to = '2026-04-21';

  // Fetch the big endpoint and analyze its structure
  const ep = `/api/external/ct/controltower/v1/wms/freightsnapshot/bydate/all_awb_registered_orders_today_grouped_by_mechant?from_date=${from}&to_date=${to}&merchant_list=${merchantId}&shipmentType_list=B2C`;
  const r = await request(ep, { token });
  console.log(`bytes=${r.body.length}`);

  const data = JSON.parse(r.body);
  console.log(`Top-level array length: ${data.length}`);
  if (data.length > 0) {
    console.log('\nFirst entry top-level keys:', Object.keys(data[0]));
    console.log('time:', data[0].time);
    console.log('inner data length:', data[0].data?.length);
    if (data[0].data?.[0]) {
      console.log('\nFirst group _id:', data[0].data[0]._id);
      const orders = data[0].data[0].data;
      console.log('orders in first group:', orders?.length);
      if (orders?.[0]) {
        console.log('\nFirst order keys:', Object.keys(orders[0]));
      }
    }
  }

  // Now aggregate all orders, count by status
  console.log('\n=== STATUS BREAKDOWN ===');
  let allOrders = [];
  const awbSeen = new Set();
  for (const top of data) {
    for (const group of top.data || []) {
      for (const o of group.data || []) {
        const awb = o.awbNumber || o.orderId;
        if (awb && awbSeen.has(awb)) continue;
        if (awb) awbSeen.add(awb);
        allOrders.push(o);
      }
    }
  }
  console.log(`Total unique orders: ${allOrders.length}`);

  const statusMap = {};
  for (const o of allOrders) {
    const st = o.orderStatus || 'UNKNOWN';
    statusMap[st] = (statusMap[st] || 0) + 1;
  }
  console.log('\nStatus counts:');
  Object.entries(statusMap).sort((a,b)=>b[1]-a[1]).forEach(([s,c]) => console.log(`  ${s}: ${c}`));

  // courier breakdown
  const courierMap = {};
  for (const o of allOrders) {
    const cp = o.actualCourierProviderName || o.courierPartner || 'Unknown';
    courierMap[cp] = (courierMap[cp] || 0) + 1;
  }
  console.log('\nCourier breakdown:');
  Object.entries(courierMap).sort((a,b)=>b[1]-a[1]).slice(0, 15).forEach(([s,c]) => console.log(`  ${s}: ${c}`));

  // date distribution
  const dayMap = {};
  for (const o of allOrders) {
    const d = o.createdDate || o.orderDate;
    if (!d) continue;
    const k = new Date(d).toISOString().slice(0, 10);
    dayMap[k] = (dayMap[k] || 0) + 1;
  }
  console.log('\nOrders per day:');
  Object.entries(dayMap).sort().forEach(([d,c]) => console.log(`  ${d}: ${c}`));
}

main().catch(e => { console.error('ERR:', e.message); process.exit(1); });
