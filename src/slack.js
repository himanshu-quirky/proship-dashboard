'use strict';
const fetch = require('node-fetch');

async function send(webhookUrl, text, blocks) {
  if (!webhookUrl) return false;
  try {
    const body = blocks ? { text, blocks } : { text };
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    return res.ok;
  } catch (e) {
    console.error('Slack send error:', e.message);
    return false;
  }
}

function buildBreachBlocks({ totalBreaches, newBreaches, awbs, dashboardUrl }) {
  const awbList = awbs.slice(0, 5).join(', ') + (awbs.length > 5 ? ` +${awbs.length - 5} more` : '');
  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: '🚨 Prozoship Alert' }
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${newBreaches} new SLA breach${newBreaches !== 1 ? 'es' : ''} detected* (${totalBreaches} total active)\n📦 *AWBs:* ${awbList}`
      }
    },
    {
      type: 'actions',
      elements: [{
        type: 'button',
        text: { type: 'plain_text', text: 'View Dashboard →' },
        url: dashboardUrl || 'http://localhost:3000',
        style: 'primary'
      }]
    }
  ];
}

function buildDigestBlocks({ store, dashboardUrl }) {
  const { cancellations, pickup } = store;
  const lines = [];

  if (cancellations?.kpis) {
    const k = cancellations.kpis;
    lines.push(`*${k.totalBreaches} active SLA breaches* — ${k.deliveryBreaches} delivery, ${k.rtoBreaches} RTO, ${k.pickupCancellationBreaches} pickup/cancellation`);
  }
  if (pickup?.kpis) {
    lines.push(`*${pickup.kpis.slaBreached} of ${pickup.kpis.totalPending} pending shipments* are breached`);
  }

  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: '☀️ Prozoship Daily Digest' }
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: lines.join('\n') || 'No active breaches. All good.' }
    },
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

module.exports = { send, buildBreachBlocks, buildDigestBlocks };
