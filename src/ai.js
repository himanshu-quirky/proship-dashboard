'use strict';
const fetch = require('node-fetch');

const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GROQ_KEY = process.env.GROQ_API_KEY;
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`;
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

async function callGemini(prompt) {
  const res = await fetch(GEMINI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini ${res.status}: ${err.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
}

async function callGroq(prompt) {
  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${GROQ_KEY}`
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 400
    })
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Groq ${res.status}: ${err.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || null;
}

function buildPrompt(store) {
  const { cancellations, pickup, delivery } = store;
  let prompt = `You are a logistics operations analyst reviewing a Prozo WMS shipment report. Write a 2–3 sentence plain-English summary of what is most urgent right now and why it matters. Be specific: name AWB numbers, days elapsed, and breach types when relevant. No corporate language, no fluff.\n\nDATA:`;

  if (cancellations?.kpis) {
    const k = cancellations.kpis;
    prompt += `\n\nSLA BREACHES — ${k.totalBreaches} total:\n`;
    prompt += `  • Delivery overdue: ${k.deliveryBreaches}\n`;
    prompt += `  • RTO overdue: ${k.rtoBreaches}\n`;
    prompt += `  • Pickup/Cancellation overdue: ${k.pickupCancellationBreaches}\n`;
    const top5 = (cancellations.shipments || []).slice(0, 5);
    if (top5.length) {
      prompt += `  Most critical: ${top5.map(s => `AWB ${s.awb} (${s.status}, ${s.daysElapsed} days elapsed)`).join('; ')}\n`;
    }
  }

  if (pickup?.kpis) {
    const k = pickup.kpis;
    prompt += `\nPENDING PIPELINE — ${k.totalPending} total: ${k.slaBreached} breached SLA, ${k.normalPipeline} within SLA\n`;
  }

  if (delivery?.kpis) {
    const k = delivery.kpis;
    prompt += `\nOVERALL PERFORMANCE — ${k.deliveryRate}% delivery rate, ${k.avgTAT} days avg TAT, ${k.onTimeDelivery}% on-time vs EDD\n`;
  }

  return prompt;
}

async function analyze(store) {
  const prompt = buildPrompt(store);
  try {
    return await callGemini(prompt);
  } catch (e) {
    console.warn('Gemini failed, falling back to Groq:', e.message);
    try {
      return await callGroq(prompt);
    } catch (e2) {
      console.error('Groq also failed:', e2.message);
      return null;
    }
  }
}

module.exports = { analyze, callGemini, callGroq };
