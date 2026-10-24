import { db, getSetting, setSetting } from './db.js';

const GIST_DESC = 'banuerllm-database-storage';
const GIST_FILE = 'banuerllm_backup.json';

function getGithubToken() {
  return (process.env.GITHUB_TOKEN || getSetting('github_token') || '').trim();
}

export async function fetchOrCreateGist() {
  const token = getGithubToken();
  if (!token) return null;

  try {
    // 1. List user gists
    const res = await fetch('https://api.github.com/gists', {
      headers: {
        'Authorization': `token ${token}`,
        'User-Agent': 'banuerllm-syncer'
      }
    });

    if (!res.ok) {
      console.error(`[GistSync] Failed to list gists: ${res.status}`);
      return null;
    }

    const gists = await res.json();
    const existing = Array.isArray(gists) ? gists.find(g => g.description === GIST_DESC) : null;

    if (existing) {
      return existing.id;
    }

    // 2. Create private gist if not found
    const createRes = await fetch('https://api.github.com/gists', {
      method: 'POST',
      headers: {
        'Authorization': `token ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'banuerllm-syncer'
      },
      body: JSON.stringify({
        description: GIST_DESC,
        public: false,
        files: {
          [GIST_FILE]: {
            content: JSON.stringify({ version: 1, providers: [], keys: [] }, null, 2)
          }
        }
      })
    });

    if (createRes.ok) {
      const created = await createRes.json();
      console.log(`[GistSync] Created new private gist for storage: ${created.id}`);
      return created.id;
    }
  } catch (err) {
    console.error('[GistSync] Error finding/creating gist:', err.message);
  }
  return null;
}

export async function pullFromGist() {
  const token = getGithubToken();
  if (!token) return false;

  const gistId = await fetchOrCreateGist();
  if (!gistId) return false;

  try {
    const res = await fetch(`https://api.github.com/gists/${gistId}`, {
      headers: {
        'Authorization': `token ${token}`,
        'User-Agent': 'banuerllm-syncer'
      }
    });

    if (!res.ok) return false;
    const data = await res.json();
    const fileObj = data.files && data.files[GIST_FILE];
    if (!fileObj || !fileObj.content) return false;

    const payload = JSON.parse(fileObj.content);

    // Only restore if database is empty or has fewer providers
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
      console.log(`[GistSync] Restored ${payload.providers.length} providers from GitHub Gist!`);
    }

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
      console.log(`[GistSync] Restored ${payload.keys.length} virtual keys from GitHub Gist!`);
    }

    if (payload.settings && typeof payload.settings === 'object') {
      for (const [k, v] of Object.entries(payload.settings)) {
        if (!getSetting(k)) {
          setSetting(k, String(v));
        }
      }
    }

    return true;
  } catch (err) {
    console.error('[GistSync] Error pulling from gist:', err.message);
    return false;
  }
}

export async function pushToGist() {
  const token = getGithubToken();
  if (!token) return false;

  const gistId = await fetchOrCreateGist();
  if (!gistId) return false;

  try {
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

    const payload = {
      version: 1,
      saved_at: Date.now(),
      providers,
      keys,
      settings
    };

    const res = await fetch(`https://api.github.com/gists/${gistId}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `token ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'banuerllm-syncer'
      },
      body: JSON.stringify({
        description: GIST_DESC,
        files: {
          [GIST_FILE]: {
            content: JSON.stringify(payload, null, 2)
          }
        }
      })
    });

    if (res.ok) {
      console.log(`[GistSync] Database saved to GitHub Gist (${providers.length} providers, ${keys.length} keys)`);
      return true;
    }
  } catch (err) {
    console.error('[GistSync] Error pushing to gist:', err.message);
  }
  return false;
}
