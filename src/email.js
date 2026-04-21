'use strict';
const nodemailer = require('nodemailer');

// Build a transporter from env vars. Supports any SMTP server:
// - Gmail: SMTP_HOST=smtp.gmail.com SMTP_PORT=587 SMTP_USER=you@gmail.com SMTP_PASS=<16-char app password>
// - Resend: SMTP_HOST=smtp.resend.com SMTP_PORT=465 SMTP_USER=resend SMTP_PASS=<API_KEY>
// - SendGrid: SMTP_HOST=smtp.sendgrid.net SMTP_PORT=587 SMTP_USER=apikey SMTP_PASS=<API_KEY>
let _transporter = null;
function getTransporter() {
  if (_transporter) return _transporter;
  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) return null;
  _transporter = nodemailer.createTransport({
    host, port,
    secure: port === 465,
    auth: { user, pass }
  });
  return _transporter;
}

function isConfigured() { return !!getTransporter(); }

async function send({ to, subject, html, text }) {
  const t = getTransporter();
  if (!t) return { ok: false, error: 'Email not configured (set SMTP_HOST/SMTP_USER/SMTP_PASS env vars)' };
  const recipients = Array.isArray(to) ? to.filter(Boolean) : [to].filter(Boolean);
  if (!recipients.length) return { ok: false, error: 'No recipients' };
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  try {
    const info = await t.sendMail({ from, to: recipients.join(', '), subject, html, text });
    return { ok: true, messageId: info.messageId, accepted: info.accepted };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function n(v) { return (v || 0).toLocaleString('en-IN'); }

// ── Templates ────────────────────────────────────────────────────────────────
function breachEmail({ totalBreaches, newBreaches, shipments = [], dashboardUrl }) {
  const rows = shipments.slice(0, 15).map(s => `
    <tr>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;font-family:monospace;font-size:12px">${s.awb}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;color:#991B1B">${s.breachType || ''}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee">${s.city || '—'}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;color:#991B1B;font-weight:600">${s.daysElapsed}d</td>
    </tr>`).join('');
  const more = shipments.length > 15 ? `<p style="color:#64748B;font-size:12px">+${shipments.length - 15} more. Open dashboard for the full list.</p>` : '';
  const subject = `[Prozoship] 🚨 ${newBreaches} new SLA breach${newBreaches !== 1 ? 'es' : ''} — ${totalBreaches} total active`;
  const html = `
    <div style="font-family:system-ui,-apple-system,sans-serif;max-width:620px;margin:0 auto;color:#1F2937">
      <h2 style="color:#B91C1C;margin-bottom:4px">🚨 New SLA Breaches</h2>
      <p style="color:#52525B;margin-top:0">${newBreaches} new breach${newBreaches !== 1 ? 'es' : ''} detected · ${n(totalBreaches)} total active</p>
      <table style="width:100%;border-collapse:collapse;margin:14px 0">
        <thead><tr style="background:#F5F1EA">
          <th style="text-align:left;padding:8px 10px;font-size:11px;color:#64748B">AWB</th>
          <th style="text-align:left;padding:8px 10px;font-size:11px;color:#64748B">BREACH</th>
          <th style="text-align:left;padding:8px 10px;font-size:11px;color:#64748B">CITY</th>
          <th style="text-align:right;padding:8px 10px;font-size:11px;color:#64748B">DAYS</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      ${more}
      <p><a href="${dashboardUrl}" style="display:inline-block;background:#2D6A4F;color:#fff;padding:9px 18px;border-radius:6px;text-decoration:none;font-weight:500">Open Dashboard →</a></p>
    </div>`;
  const text = `${newBreaches} new SLA breach${newBreaches !== 1 ? 'es' : ''} detected (${totalBreaches} total).\n\n` +
    shipments.slice(0, 15).map(s => `${s.awb} — ${s.breachType || ''} · ${s.city || ''} · ${s.daysElapsed}d`).join('\n') +
    `\n\n${dashboardUrl}`;
  return { subject, html, text };
}

function digestEmail({ store, dashboardUrl }) {
  const { delivery, pickup, cancellations } = store;
  const k = delivery?.kpis || {};
  const pk = pickup?.kpis || {};
  const ck = cancellations?.kpis || {};
  const top = (cancellations?.shipments || [])
    .slice()
    .sort((a, b) => (b.daysElapsed || 0) - (a.daysElapsed || 0))
    .slice(0, 5);
  const topRows = top.map(s => `
    <tr>
      <td style="padding:4px 8px;font-family:monospace;font-size:11.5px">${s.awb}</td>
      <td style="padding:4px 8px;font-size:12px">${s.breachType || ''}</td>
      <td style="padding:4px 8px;font-size:12px">${s.city || '—'}</td>
      <td style="padding:4px 8px;font-size:12px;text-align:right;color:#991B1B"><strong>${s.daysElapsed}d</strong></td>
    </tr>`).join('');
  const subject = `[Prozoship] ☀️ Daily Digest — ${ck.totalBreaches || 0} active SLA breaches`;
  const html = `
    <div style="font-family:system-ui,-apple-system,sans-serif;max-width:640px;margin:0 auto;color:#1F2937">
      <h2 style="margin-bottom:2px">☀️ Prozoship Daily Digest</h2>
      <p style="color:#64748B;margin-top:0">${new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0 4px">
        <tr>
          <td style="padding:14px 16px;background:#FAF7F2;border-radius:6px;width:50%" valign="top">
            <div style="font-size:11px;color:#64748B;text-transform:uppercase;letter-spacing:0.06em">Total Shipments</div>
            <div style="font-size:22px;font-weight:700;margin-top:4px">${n(k.totalShipments)}</div>
          </td>
          <td style="width:8px"></td>
          <td style="padding:14px 16px;background:#FAF7F2;border-radius:6px;width:50%" valign="top">
            <div style="font-size:11px;color:#64748B;text-transform:uppercase;letter-spacing:0.06em">Delivery Rate</div>
            <div style="font-size:22px;font-weight:700;margin-top:4px;color:${(k.deliveryRate||0) >= 95 ? '#2D6A4F' : (k.deliveryRate||0) >= 90 ? '#C2410C' : '#B91C1C'}">${k.deliveryRate || 0}%</div>
          </td>
        </tr>
        <tr><td colspan="3" style="height:8px"></td></tr>
        <tr>
          <td style="padding:14px 16px;background:#FAF7F2;border-radius:6px" valign="top">
            <div style="font-size:11px;color:#64748B;text-transform:uppercase;letter-spacing:0.06em">Avg TAT</div>
            <div style="font-size:22px;font-weight:700;margin-top:4px">${k.avgTAT || 0} <span style="font-size:12px;color:#64748B">days</span></div>
          </td>
          <td></td>
          <td style="padding:14px 16px;background:#FAF7F2;border-radius:6px" valign="top">
            <div style="font-size:11px;color:#64748B;text-transform:uppercase;letter-spacing:0.06em">On-Time vs EDD</div>
            <div style="font-size:22px;font-weight:700;margin-top:4px">${k.onTimeDelivery || 0}%</div>
          </td>
        </tr>
      </table>
      ${pk.totalPending ? `<p style="margin:14px 0;font-size:13px"><strong>📋 Pending Shipments — ${n(pk.totalPending)}</strong><br>
        <span style="color:#B91C1C">🔴 ${n(pk.slaBreached)} SLA breached</span> ·
        <span style="color:#2D6A4F">🟢 ${n(pk.normalPipeline)} within SLA</span></p>` : ''}
      ${ck.totalBreaches ? `
        <h3 style="color:#B91C1C;margin-top:20px;margin-bottom:6px">⚠️ ${n(ck.totalBreaches)} Active SLA Breaches</h3>
        <p style="color:#64748B;font-size:12px;margin-top:0">Raise with Proship today — ${ck.deliveryBreaches || 0} delivery · ${ck.rtoBreaches || 0} RTO · ${ck.pickupCancellationBreaches || 0} pickup/cancellation</p>
        ${top.length ? `<p style="margin-top:12px;font-size:12px;color:#64748B;text-transform:uppercase;letter-spacing:0.06em">Top overdue</p>
          <table style="width:100%;border-collapse:collapse">${topRows}</table>` : ''}
      ` : '<p style="color:#2D6A4F;margin-top:16px"><strong>✅ No active SLA breaches today.</strong></p>'}
      <p style="margin-top:22px"><a href="${dashboardUrl}" style="display:inline-block;background:#2D6A4F;color:#fff;padding:9px 18px;border-radius:6px;text-decoration:none;font-weight:500">Open Dashboard →</a></p>
    </div>`;
  const text = `Prozoship Daily Digest — ${new Date().toDateString()}\n\n` +
    `Total Shipments: ${n(k.totalShipments)} · Delivery Rate: ${k.deliveryRate || 0}% · Avg TAT: ${k.avgTAT || 0}d · On-Time: ${k.onTimeDelivery || 0}%\n` +
    (ck.totalBreaches ? `\n⚠️ ${n(ck.totalBreaches)} active SLA breaches — raise with Proship today\n` +
      top.map(s => `  ${s.awb} — ${s.breachType} · ${s.city} · ${s.daysElapsed}d`).join('\n') : '\n✅ No active SLA breaches.') +
    `\n\n${dashboardUrl}`;
  return { subject, html, text };
}

function testEmail({ dashboardUrl }) {
  const subject = '[Prozoship] ✅ Email connected';
  const html = `
    <div style="font-family:system-ui,-apple-system,sans-serif;max-width:520px;margin:0 auto;color:#1F2937">
      <h2>✅ Prozoship — Email connected</h2>
      <p>You're all set. This email address will now receive:</p>
      <ul>
        <li>🚨 Real-time SLA breach alerts</li>
        <li>☀️ Daily digest at 9 AM IST</li>
      </ul>
      <p><a href="${dashboardUrl}" style="display:inline-block;background:#2D6A4F;color:#fff;padding:9px 18px;border-radius:6px;text-decoration:none;font-weight:500">Open Dashboard →</a></p>
    </div>`;
  const text = 'Prozoship — Email connected. You will now receive breach alerts and the daily digest.';
  return { subject, html, text };
}

module.exports = { send, isConfigured, breachEmail, digestEmail, testEmail };
