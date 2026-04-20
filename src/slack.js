'use strict';
const fetch = require('node-fetch');

async function send(webhookUrl, text, blocks) {
  if (!webhookUrl) return { ok: false, error: 'No webhook configured' };
  try {
    const body = blocks ? { text, blocks } : { text };
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      return { ok: false, error: `Slack responded ${res.status}: ${t}` };
    }
    return { ok: true };
  } catch (e) {
    console.error('Slack send error:', e.message);
    return { ok: false, error: e.message };
  }
}

function n(v) { return (v || 0).toLocaleString('en-IN'); }

// ── Real-time breach alert ────────────────────────────────────────────────────
function buildBreachBlocks({ totalBreaches, newBreaches, awbs = [], shipments = [], dashboardUrl }) {
  // Build a short AWB preview list with details where possible
  const preview = shipments.slice(0, 5).map(s => {
    const city = s.city ? ` · ${s.city}` : '';
    const days = s.daysElapsed != null ? ` · ${s.daysElapsed}d` : '';
    return `• \`${s.awb}\` — ${s.breachType || 'SLA breach'}${city}${days}`;
  });
  const more = shipments.length > 5 ? `\n_+${shipments.length - 5} more_` : '';
  const awbFallback = awbs.slice(0, 5).join(', ') + (awbs.length > 5 ? ` +${awbs.length - 5} more` : '');

  return [
    { type: 'header', text: { type: 'plain_text', text: '🚨 New SLA Breaches' } },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${newBreaches} new breach${newBreaches !== 1 ? 'es' : ''} detected* — ${n(totalBreaches)} total active\n\n${preview.length ? preview.join('\n') + more : `AWBs: ${awbFallback}`}`
      }
    },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `⏰ ${new Date().toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })} IST` }] },
    {
      type: 'actions',
      elements: [{
        type: 'button',
        text: { type: 'plain_text', text: 'Raise with Proship →' },
        url: (dashboardUrl || 'http://localhost:3000') + '/#cancellations',
        style: 'primary'
      }]
    }
  ];
}

// ── Daily digest ──────────────────────────────────────────────────────────────
function buildDigestBlocks({ store, dashboardUrl }) {
  const { delivery, pickup, cancellations } = store;
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: '☀️ Prozoship Daily Digest' } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `${new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}` }] },
    { type: 'divider' }
  ];

  // Summary KPIs
  if (delivery?.kpis) {
    const k = delivery.kpis;
    const rateEmoji = k.deliveryRate >= 95 ? '🟢' : k.deliveryRate >= 90 ? '🟡' : '🔴';
    const otEmoji = k.onTimeDelivery >= 85 ? '🟢' : k.onTimeDelivery >= 70 ? '🟡' : '🔴';
    blocks.push({
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*📦 Total Shipments*\n${n(k.totalShipments)}` },
        { type: 'mrkdwn', text: `*${rateEmoji} Delivery Rate*\n${k.deliveryRate}%` },
        { type: 'mrkdwn', text: `*⏱ Avg TAT*\n${k.avgTAT} days` },
        { type: 'mrkdwn', text: `*${otEmoji} On-Time vs EDD*\n${k.onTimeDelivery}%` }
      ]
    });
  }

  // Pending Shipments
  if (pickup?.kpis) {
    const k = pickup.kpis;
    const breachPct = k.totalPending ? ((k.slaBreached / k.totalPending) * 100).toFixed(0) : 0;
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*📋 Pending Shipments — ${n(k.totalPending)}*\n🔴 ${n(k.slaBreached)} SLA breached (${breachPct}%)   🟢 ${n(k.normalPipeline)} within SLA` }
    });
  }

  // Active SLA breaches — main call-to-action
  if (cancellations?.kpis) {
    const k = cancellations.kpis;
    if (k.totalBreaches > 0) {
      blocks.push({ type: 'divider' });
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `*⚠️ ${n(k.totalBreaches)} Active SLA Breaches — raise with Proship today*\n• ${n(k.deliveryBreaches)} Delivery overdue\n• ${n(k.rtoBreaches)} RTO overdue\n• ${n(k.pickupCancellationBreaches)} Pickup / Cancellation overdue` }
      });

      // Top 5 breaches with most days elapsed
      const top = (cancellations.shipments || [])
        .slice()
        .sort((a, b) => (b.daysElapsed || 0) - (a.daysElapsed || 0))
        .slice(0, 5);
      if (top.length) {
        blocks.push({
          type: 'section',
          text: { type: 'mrkdwn', text: '*Top overdue:*\n' + top.map(s => `• \`${s.awb}\` — ${s.breachType} · ${s.city || '—'} · *${s.daysElapsed}d*`).join('\n') }
        });
      }
    } else {
      blocks.push({ type: 'divider' });
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '*✅ No active SLA breaches today.*' } });
    }
  }

  blocks.push({ type: 'divider' });
  blocks.push({
    type: 'actions',
    elements: [{
      type: 'button',
      text: { type: 'plain_text', text: 'Open Dashboard →' },
      url: dashboardUrl || 'http://localhost:3000',
      style: 'primary'
    }]
  });

  return blocks;
}

// ── AI insight ────────────────────────────────────────────────────────────────
function buildInsightBlocks({ message, dashboardUrl }) {
  return [
    { type: 'header', text: { type: 'plain_text', text: '🧠 AI Insight' } },
    { type: 'section', text: { type: 'mrkdwn', text: message } },
    {
      type: 'actions',
      elements: [{
        type: 'button',
        text: { type: 'plain_text', text: 'Open Dashboard →' },
        url: dashboardUrl || 'http://localhost:3000'
      }]
    }
  ];
}

// ── Test message ──────────────────────────────────────────────────────────────
function buildTestBlocks(dashboardUrl) {
  return [
    { type: 'header', text: { type: 'plain_text', text: '✅ Prozoship · Slack Connected' } },
    { type: 'section', text: { type: 'mrkdwn', text: "You're all set. This channel will now receive:\n• 🚨 Real-time SLA breach alerts\n• ☀️ Daily digest at 9 AM IST\n• 🧠 AI insights when new data is analyzed" } },
    {
      type: 'actions',
      elements: [{
        type: 'button',
        text: { type: 'plain_text', text: 'Open Dashboard →' },
        url: dashboardUrl || 'http://localhost:3000'
      }]
    }
  ];
}

module.exports = { send, buildBreachBlocks, buildDigestBlocks, buildInsightBlocks, buildTestBlocks };
