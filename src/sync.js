import { db, getSetting, setSetting } from './db.js';

const VAULT_REPO = 'banuee/banuerllm-vault';
const VAULT_FILE = 'data.json';
const GIST_DESC = 'banuerllm-database-storage';
const GIST_FILE = 'banuerllm_backup.json';

function getGithubToken() {
  return (process.env.GITHUB_TOKEN || getSetting('github_token') || '').trim();
}

function restorePayload(payload) {
  if (!payload || typeof payload !== 'object') return false;

  // Restore providers if none exist currently
  const currentProvCount = db.prepare('SELECT COUNT(*) as c FROM providers').get().c;
  if (Array.isArray(payload.providers) && payload.providers.length > 0 && currentProvCount === 0) {
    for (const p of payload.providers) {
      db.prepare(`
        INSERT INTO providers (id, name, base_url, api_key, models, is_active, priority, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          base_url = excluded.base_url,
          api_key = excluded.api_key,
          models = excluded.models,
          is_active = excluded.is_active,
          priority = excluded.priority
      `).run(
        p.id,
        p.name,
        p.base_url,
        p.api_key,
        JSON.stringify(Array.isArray(p.models) ? p.models : ['*']),
        p.is_active ?? 1,
        p.priority || 0,
        p.created_at || Date.now()
      );
    }
    console.log(`[VaultSync] Restored ${payload.providers.length} providers from backup!`);
  }

  // Restore virtual keys if none exist currently
  const currentKeyCount = db.prepare('SELECT COUNT(*) as c FROM keys').get().c;
  if (Array.isArray(payload.keys) && payload.keys.length > 0 && currentKeyCount === 0) {
    for (const k of payload.keys) {
      db.prepare(`
        INSERT INTO keys (id, name, key_hash, key_prefix, is_active, created_at, last_used_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO NOTHING
      `).run(
        k.id,
        k.name,
        k.key_hash,
        k.key_prefix,
        k.is_active ?? 1,
        k.created_at || Date.now(),
        k.last_used_at || null
      );
    }
    console.log(`[VaultSync] Restored ${payload.keys.length} virtual keys from backup!`);
  }

  // Restore settings
  if (payload.settings && typeof payload.settings === 'object') {
    for (const [k, v] of Object.entries(payload.settings)) {
      if (!getSetting(k)) {
        setSetting(k, String(v));
      }
    }
  }

  return true;
}

function dumpPayload() {
  const providers = db.prepare('SELECT * FROM providers').all().map(p => ({
    ...p,
    models: JSON.parse(p.models || '[]')
  }));
  const keys = db.prepare('SELECT * FROM keys').all();
  const settingsRows = db.prepare('SELECT key, value FROM settings').all();
  const settings = {};
  for (const row of settingsRows) {
    if (row.key !== 'github_token') {
      settings[row.key] = row.value;
    }
  }

  return {
    version: 1,
    saved_at: Date.now(),
    providers,
    keys,
    settings
  };
}

export async function pullFromGist() {
  const token = getGithubToken();
  if (!token) return false;

  // 1. Try private repository first
  try {
    const res = await fetch(`https://api.github.com/repos/${VAULT_REPO}/contents/${VAULT_FILE}`, {
      headers: {
        'Authorization': `token ${token}`,
        'User-Agent': 'banuerllm-syncer'
      }
    });

    if (res.ok) {
      const data = await res.json();
      if (data.content) {
        const decoded = Buffer.from(data.content, 'base64').toString('utf-8');
        const payload = JSON.parse(decoded);
        return restorePayload(payload);
      }
    }
  } catch (err) {
    console.error('[VaultSync] Error pulling from repo:', err.message);
  }

  // 2. Fallback to Gist
  try {
    const res = await fetch('https://api.github.com/gists', {
      headers: {
        'Authorization': `token ${token}`,
        'User-Agent': 'banuerllm-syncer'
      }
    });
    if (!res.ok) return false;
    const gists = await res.json();
    const existing = Array.isArray(gists) ? gists.find(g => g.description === GIST_DESC) : null;
    if (!existing) return false;

    const gistRes = await fetch(`https://api.github.com/gists/${existing.id}`, {
      headers: {
        'Authorization': `token ${token}`,
        'User-Agent': 'banuerllm-syncer'
      }
    });
    if (!gistRes.ok) return false;
    const gistData = await gistRes.json();
    const fileObj = gistData.files && gistData.files[GIST_FILE];
    if (fileObj && fileObj.content) {
      return restorePayload(JSON.parse(fileObj.content));
    }
  } catch (err) {
    console.error('[GistSync] Error pulling from gist fallback:', err.message);
  }

  return false;
}

export async function pushToGist() {
  const token = getGithubToken();
  if (!token) return false;

  const payload = dumpPayload();
  const contentBase64 = Buffer.from(JSON.stringify(payload, null, 2), 'utf-8').toString('base64');

  // 1. Try private repository first
  try {
    let sha = null;
    const checkRes = await fetch(`https://api.github.com/repos/${VAULT_REPO}/contents/${VAULT_FILE}`, {
      headers: {
        'Authorization': `token ${token}`,
        'User-Agent': 'banuerllm-syncer'
      }
    });
    if (checkRes.ok) {
      const existing = await checkRes.json();
      sha = existing.sha;
    }

    const putRes = await fetch(`https://api.github.com/repos/${VAULT_REPO}/contents/${VAULT_FILE}`, {
      method: 'PUT',
      headers: {
        'Authorization': `token ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'banuerllm-syncer'
      },
      body: JSON.stringify({
        message: `Auto-backup ${new Date().toISOString()}`,
        content: contentBase64,
        ...(sha ? { sha } : {})
      })
    });

    if (putRes.ok) {
      console.log(`[VaultSync] Synced ${payload.providers.length} providers & ${payload.keys.length} keys to ${VAULT_REPO}`);
      return true;
    } else {
      console.error(`[VaultSync] Repo sync failed with status ${putRes.status}`);
    }
  } catch (err) {
    console.error('[VaultSync] Error pushing to repo:', err.message);
  }

  return false;
}
