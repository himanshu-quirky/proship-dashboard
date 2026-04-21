'use strict';
/**
 * Supabase-backed persistent store.
 *
 * Why: Render free tier wipes the container's filesystem on every deploy,
 * which means settings (Slack webhook, email recipients, WA recipients,
 * WhatsApp Baileys session) are lost. Keeping these in Supabase means they
 * survive deploys AND are queryable/editable from the Supabase dashboard.
 *
 * Tables (created via SQL editor — see scripts/supabase-schema.sql):
 *   dashboard_settings (key text PK, value jsonb, updated_at timestamptz)
 *   dashboard_store    (key text PK, value jsonb, updated_at timestamptz)
 *   wa_auth            (key text PK, value jsonb, updated_at timestamptz)
 *
 * This module uses the Supabase service_role key, which bypasses RLS —
 * appropriate since this runs server-side and has no untrusted callers.
 */
const { createClient } = require('@supabase/supabase-js');

const URL = process.env.SUPABASE_URL || '';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';

let _client = null;
function client() {
  if (_client) return _client;
  if (!URL || !KEY) return null;
  _client = createClient(URL, KEY, { auth: { persistSession: false } });
  return _client;
}

function isEnabled() { return !!client(); }

// ── Generic KV helpers ───────────────────────────────────────────────────────
async function getRow(table, key) {
  const c = client();
  if (!c) return null;
  const { data, error } = await c.from(table).select('value').eq('key', key).maybeSingle();
  if (error) { console.error(`[sb] ${table} get ${key}:`, error.message); return null; }
  return data?.value ?? null;
}

async function setRow(table, key, value) {
  const c = client();
  if (!c) return false;
  const { error } = await c.from(table).upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  if (error) console.error(`[sb] ${table} set ${key}:`, error.message);
  return !error;
}

async function deleteRow(table, key) {
  const c = client();
  if (!c) return false;
  const { error } = await c.from(table).delete().eq('key', key);
  if (error) console.error(`[sb] ${table} del ${key}:`, error.message);
  return !error;
}

async function listRows(table, keyPrefix) {
  const c = client();
  if (!c) return [];
  let q = c.from(table).select('key, value');
  if (keyPrefix) q = q.like('key', `${keyPrefix}%`);
  const { data, error } = await q;
  if (error) { console.error(`[sb] ${table} list:`, error.message); return []; }
  return data || [];
}

// ── Settings helpers ─────────────────────────────────────────────────────────
async function loadSettings(defaults = {}) {
  const rows = await listRows('dashboard_settings');
  const out = { ...defaults };
  for (const r of rows) out[r.key] = r.value;
  return out;
}

async function saveSettings(settings) {
  const c = client();
  if (!c) return false;
  const rows = Object.entries(settings).map(([key, value]) => ({
    key, value, updated_at: new Date().toISOString()
  }));
  if (!rows.length) return true;
  const { error } = await c.from('dashboard_settings').upsert(rows, { onConflict: 'key' });
  if (error) console.error('[sb] saveSettings:', error.message);
  return !error;
}

async function saveSetting(key, value) {
  return setRow('dashboard_settings', key, value);
}

// ── Store helpers (delivery / pickup / cancellations) ────────────────────────
async function loadStore(defaults = {}) {
  const rows = await listRows('dashboard_store');
  const out = { ...defaults };
  for (const r of rows) out[r.key] = r.value;
  return out;
}

async function saveStoreKey(key, value) {
  return setRow('dashboard_store', key, value);
}

// ── WhatsApp auth state ──────────────────────────────────────────────────────
async function loadWAAuth() {
  const rows = await listRows('wa_auth');
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

async function saveWAAuth(key, value) { return setRow('wa_auth', key, value); }
async function deleteWAAuth(key)      { return deleteRow('wa_auth', key); }
async function clearAllWAAuth() {
  const c = client();
  if (!c) return false;
  const { error } = await c.from('wa_auth').delete().neq('key', '');
  return !error;
}

module.exports = {
  isEnabled,
  loadSettings, saveSettings, saveSetting,
  loadStore, saveStoreKey,
  loadWAAuth, saveWAAuth, deleteWAAuth, clearAllWAAuth,
  getRow, setRow, deleteRow, listRows
};
