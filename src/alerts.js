'use strict';
const slack = require('./slack');
const wa = require('./whatsapp');

// Track which breach AWBs have already triggered a real-time notification this session
const notifiedBreaches = new Set();
let thresholdTriggered = false;

function getActiveBreachAWBs(store) {
  return (store.cancellations?.shipments || []).map(s => s.awb);
}

function addNotification(store, message, type = 'breach') {
  const notif = {
    id: Date.now().toString() + Math.random().toString(36).slice(2, 6),
    message,
    timestamp: new Date().toISOString(),
    read: false,
    type
  };
  store.notifications.unshift(notif);
  // Keep last 100
  store.notifications = store.notifications.slice(0, 100);
  return notif;
}

async function checkAndNotify(store, sendSSE) {
  const { settings } = store;
  const allAWBs = getActiveBreachAWBs(store);
  const newAWBs = allAWBs.filter(awb => !notifiedBreaches.has(awb));

  if (newAWBs.length > 0 && (settings.notificationMode === 'realtime' || settings.notificationMode === 'both')) {
    newAWBs.forEach(awb => notifiedBreaches.add(awb));

    const totalBreaches = store.cancellations?.kpis?.totalBreaches || 0;
    const alertPayload = {
      newBreaches: newAWBs.length,
      awbs: newAWBs,
      totalBreaches,
      dashboardUrl: process.env.DASHBOARD_URL || 'http://localhost:3000'
    };

    // WhatsApp
    if (settings.waConnected && settings.waRecipient) {
      const msg = wa.formatBreachAlert(alertPayload);
      await wa.sendMessage(settings.waRecipient, msg);
    }

    // Slack
    if (settings.slackWebhook) {
      const blocks = slack.buildBreachBlocks(alertPayload);
      const text = `${newAWBs.length} new SLA breach${newAWBs.length !== 1 ? 'es' : ''} detected`;
      await slack.send(settings.slackWebhook, text, blocks);
    }

    const notif = addNotification(store, `${newAWBs.length} new SLA breach${newAWBs.length !== 1 ? 'es' : ''} detected: ${newAWBs.slice(0, 3).join(', ')}${newAWBs.length > 3 ? ` +${newAWBs.length - 3} more` : ''}`, 'breach');
    sendSSE('notification', notif);
  }

  // Threshold alert
  const totalBreaches = store.cancellations?.kpis?.totalBreaches || 0;
  const threshold = settings.breachThreshold || 10;
  if (totalBreaches >= threshold && !thresholdTriggered) {
    thresholdTriggered = true;
    const msg = `Breach threshold crossed: ${totalBreaches} active breaches (limit: ${threshold})`;

    if (settings.waConnected && settings.waRecipient) {
      await wa.sendMessage(settings.waRecipient, `⚠️ *Prozoship Threshold Alert*\n${msg}`);
    }
    if (settings.slackWebhook) {
      await slack.send(settings.slackWebhook, msg);
    }
    addNotification(store, msg, 'threshold');
    sendSSE('notification', { message: msg, type: 'threshold' });
  } else if (totalBreaches < threshold) {
    thresholdTriggered = false; // reset for next crossing
  }

  sendSSE('notificationsUpdated', {
    unread: store.notifications.filter(n => !n.read).length
  });
}

async function sendDailyDigest(store) {
  const { settings } = store;
  const dashboardUrl = process.env.DASHBOARD_URL || 'http://localhost:3000';

  if (settings.notificationMode !== 'daily' && settings.notificationMode !== 'both') return;

  if (settings.waConnected && settings.waRecipient) {
    const msg = wa.formatDailyDigest({ store, dashboardUrl });
    await wa.sendMessage(settings.waRecipient, msg);
  }

  if (settings.slackWebhook) {
    const blocks = slack.buildDigestBlocks({ store, dashboardUrl });
    await slack.send(settings.slackWebhook, '☀️ Prozoship Daily Digest', blocks);
  }

  const totalBreaches = store.cancellations?.kpis?.totalBreaches || 0;
  const message = `Daily digest sent — ${totalBreaches} active SLA breach${totalBreaches !== 1 ? 'es' : ''}`;
  console.log(message);
}

module.exports = { checkAndNotify, sendDailyDigest, addNotification };
