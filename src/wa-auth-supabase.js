'use strict';
/**
 * Baileys auth state backed by Supabase.
 *
 * Baileys ships `useMultiFileAuthState(dir)` which writes each auth key as a
 * separate JSON file. That doesn't survive Render free-tier redeploys (the
 * container's disk is wiped). This module provides a drop-in replacement
 * that stores the same key/value pairs in Supabase's `wa_auth` table so the
 * WhatsApp session persists across deploys.
 *
 * Baileys serializes some values as Buffer/Uint8Array which JSON can't
 * round-trip natively. The library ships BufferJSON (replacer/reviver)
 * helpers for exactly this; we reuse them.
 */
const sb = require('./supabase-store');

async function useSupabaseAuthState(baileys) {
  const { BufferJSON, initAuthCreds } = baileys;

  // Load existing state (all rows in wa_auth)
  const rows = await sb.loadWAAuth();
  let creds;
  try {
    creds = rows.creds
      ? JSON.parse(JSON.stringify(rows.creds), BufferJSON.reviver)
      : initAuthCreds();
  } catch (e) {
    console.warn('[wa-sb] creds parse error, starting fresh:', e.message);
    creds = initAuthCreds();
  }

  // Revive cached signal-store keys
  const cache = {};
  for (const [k, v] of Object.entries(rows)) {
    if (k === 'creds') continue;
    try {
      cache[k] = JSON.parse(JSON.stringify(v), BufferJSON.reviver);
    } catch (e) {
      console.warn('[wa-sb] cache parse error for', k, e.message);
    }
  }

  const keys = {
    get: async (type, ids) => {
      const out = {};
      for (const id of ids) {
        const k = `${type}-${id}`;
        if (cache[k] !== undefined) { out[id] = cache[k]; continue; }
        const v = await sb.getRow('wa_auth', k);
        if (v == null) continue;
        try {
          const revived = JSON.parse(JSON.stringify(v), BufferJSON.reviver);
          cache[k] = revived;
          out[id] = revived;
        } catch (e) { /* ignore bad row */ }
      }
      return out;
    },
    set: async (data) => {
      // data: { [category]: { [id]: value | null } }
      const tasks = [];
      for (const category in data) {
        for (const id in data[category]) {
          const k = `${category}-${id}`;
          const value = data[category][id];
          if (value) {
            cache[k] = value;
            // Serialize through BufferJSON so buffers become {type:'Buffer', data:[...]}
            const serialized = JSON.parse(JSON.stringify(value, BufferJSON.replacer));
            tasks.push(sb.saveWAAuth(k, serialized));
          } else {
            delete cache[k];
            tasks.push(sb.deleteWAAuth(k));
          }
        }
      }
      await Promise.all(tasks);
    }
  };

  const saveCreds = async () => {
    const serialized = JSON.parse(JSON.stringify(creds, BufferJSON.replacer));
    await sb.saveWAAuth('creds', serialized);
  };

  return {
    state: { creds, keys },
    saveCreds
  };
}

module.exports = { useSupabaseAuthState };
