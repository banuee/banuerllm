import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { db, hashKey, getSetting, setSetting, getOrCreateAdminKey } from './db.js';
import { handleChatCompletions, handleGetModels, authenticateRequest, resolveUrl } from './proxy.js';
import { filterOpenRouterModels } from './filter.js';
import { pullFromGist, pushToGist } from './sync.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// Keep-Alive Worker
let keepaliveTimer = null;
function refreshKeepalive() {
  if (keepaliveTimer) {
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
  }

  const url = getSetting('render_keepalive_url');
  if (url && url.startsWith('http')) {
    keepaliveTimer = setInterval(async () => {
      try {
        const pingRes = await fetch(url, {
          headers: { 'User-Agent': 'banuerllm-pinger/1.0' }
        });
        setSetting('keepalive_last_ping', String(Date.now()));
        setSetting('keepalive_last_status', String(pingRes.status));
      } catch (err) {
        setSetting('keepalive_last_ping', String(Date.now()));
        setSetting('keepalive_last_status', 'error: ' + err.message);
      }
    }, 12 * 60 * 1000); // 12 minutes (Render sleeps at 15)
  }
}

export async function syncProviderModels(provider) {
  if (!provider || !provider.base_url || !provider.api_key) return [];
  const testUrl = resolveUrl(provider.base_url, 'v1/models');
  try {
    const resp = await fetch(testUrl, {
      headers: { 'Authorization': `Bearer ${provider.api_key}` },
      signal: AbortSignal.timeout(15000)
    });
    if (!resp.ok) return [];
    const body = await resp.json();
    let models = Array.isArray(body.data) ? body.data.map(m => m.id) : [];

    const isOR = (provider.name || '').toLowerCase().includes('openrouter') ||
                 (provider.base_url || '').toLowerCase().includes('openrouter');
    if (isOR) {
      models = filterOpenRouterModels(models);
    }

    if (models.length > 0) {
      db.prepare('UPDATE providers SET models = ? WHERE id = ?').run(JSON.stringify(models), provider.id);
      console.log(`[AutoSync] Synced ${models.length} models for ${provider.name}`);
    }
    return models;
  } catch (err) {
    console.error(`[AutoSync] Failed to sync models for ${provider.name}:`, err.message);
    return [];
  }
}

let modelSyncTimer = null;
function startPeriodicModelSync() {
  if (modelSyncTimer) clearInterval(modelSyncTimer);
  modelSyncTimer = setInterval(async () => {
    try {
      const activeProviders = db.prepare('SELECT * FROM providers WHERE is_active = 1').all();
      for (const prov of activeProviders) {
        if ((prov.name || '').toLowerCase().includes('openrouter') || prov.models !== '["*"]') {
          await syncProviderModels(prov);
        }
      }
    } catch (err) {
      console.error('[PeriodicSync] Error in periodic sync:', err.message);
    }
  }, 60 * 60 * 1000); // every 1 hour
}

// Helpers
function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = [];
    req.on('data', chunk => body.push(chunk));
    req.on('end', () => {
      if (body.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(body).toString('utf-8')));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  });
  res.end(JSON.stringify(data));
}

function verifyAdmin(req) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) return false;
  const token = authHeader.slice(7).trim();
  const masterKey = getOrCreateAdminKey();
  return token === masterKey;
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function serveStatic(res, reqPath) {
  let safePath = path.normalize(reqPath).replace(/^(\.\.[\/\\])+/, '');
  if (safePath === '/' || safePath === '') safePath = '/index.html';

  const fullPath = path.join(PUBLIC_DIR, safePath);
  if (!fullPath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.stat(fullPath, (err, stats) => {
    if (err || !stats.isFile()) {
      // Fallback to index.html for SPA routes
      const indexPath = path.join(PUBLIC_DIR, 'index.html');
      fs.readFile(indexPath, (readErr, content) => {
        if (readErr) {
          res.writeHead(404);
          res.end('Not found');
        } else {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(content);
        }
      });
      return;
    }

    const ext = path.extname(fullPath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(fullPath).pipe(res);
  });
}

// Request Dispatcher
const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  // 1. Health / Ping (For Render Keepalive & Uptime monitors)
  if (pathname === '/health' || pathname === '/ping') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('pong');
    return;
  }

  // 2. OpenAI-Compatible Gateway Routes
  if (pathname === '/v1/chat/completions' && req.method === 'POST') {
    const auth = authenticateRequest(req.headers['authorization']);
    if (!auth.authenticated) {
      sendJson(res, 401, {
        error: { message: auth.error, type: 'invalid_request_error', code: 401 }
      });
      return;
    }
    await handleChatCompletions(req, res, auth);
    return;
  }

  if (pathname === '/v1/models' && req.method === 'GET') {
    const auth = authenticateRequest(req.headers['authorization']);
    if (!auth.authenticated) {
      sendJson(res, 401, {
        error: { message: auth.error, type: 'invalid_request_error', code: 401 }
      });
      return;
    }
    handleGetModels(res);
    return;
  }

  // 3. Admin / Dashboard REST API
  if (pathname.startsWith('/api/')) {
    // Auth check for admin routes (except auth check endpoint)
    if (pathname === '/api/auth/check' && req.method === 'POST') {
      const isValid = verifyAdmin(req);
      sendJson(res, 200, { valid: isValid });
      return;
    }

    if (!verifyAdmin(req)) {
      sendJson(res, 401, { error: 'Unauthorized: valid master admin key required' });
      return;
    }

    // Status summary
    if (pathname === '/api/status' && req.method === 'GET') {
      const provCount = db.prepare('SELECT COUNT(*) as c FROM providers').get().c;
      const activeProvCount = db.prepare('SELECT COUNT(*) as c FROM providers WHERE is_active = 1').get().c;
      const keyCount = db.prepare('SELECT COUNT(*) as c FROM keys').get().c;
      const activeKeyCount = db.prepare('SELECT COUNT(*) as c FROM keys WHERE is_active = 1').get().c;
      const logCount = db.prepare('SELECT COUNT(*) as c FROM logs').get().c;

      sendJson(res, 200, {
        providers: { total: provCount, active: activeProvCount },
        keys: { total: keyCount, active: activeKeyCount },
        total_requests: logCount,
        uptime_seconds: Math.floor(process.uptime()),
        keepalive: {
          url: getSetting('render_keepalive_url') || '',
          last_ping: getSetting('keepalive_last_ping') ? Number(getSetting('keepalive_last_ping')) : null,
          last_status: getSetting('keepalive_last_status') || null
        }
      });
      return;
    }

    // Providers CRUD
    if (pathname === '/api/providers' && req.method === 'GET') {
      const providers = db.prepare('SELECT * FROM providers ORDER BY priority DESC, created_at DESC').all();
      const safeProviders = providers.map(p => ({
        ...p,
        models: JSON.parse(p.models || '[]'),
        api_key_masked: p.api_key ? (p.api_key.slice(0, 4) + '...' + p.api_key.slice(-4)) : ''
      }));
      sendJson(res, 200, safeProviders);
      return;
    }

    if (pathname === '/api/providers' && req.method === 'POST') {
      const data = await parseJsonBody(req);
      if (!data.name || !data.base_url || !data.api_key) {
        sendJson(res, 400, { error: 'Name, base_url and api_key are required' });
        return;
      }
      const id = crypto.randomUUID();
      const modelsJson = JSON.stringify(Array.isArray(data.models) ? data.models : ['*']);
      db.prepare(`
        INSERT INTO providers (id, name, base_url, api_key, models, is_active, priority, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        data.name.trim(),
        data.base_url.trim(),
        data.api_key.trim(),
        modelsJson,
        data.is_active ?? 1,
        Number(data.priority) || 0,
        Date.now()
      );
      pushToGist().catch(() => {});
      sendJson(res, 201, { id, message: 'Provider added' });
      return;
    }

    if (pathname.startsWith('/api/providers/') && req.method === 'PUT') {
      const id = pathname.replace('/api/providers/', '');
      const data = await parseJsonBody(req);
      const existing = db.prepare('SELECT * FROM providers WHERE id = ?').get(id);
      if (!existing) {
        sendJson(res, 404, { error: 'Provider not found' });
        return;
      }

      const name = data.name ? data.name.trim() : existing.name;
      const baseUrl = data.base_url ? data.base_url.trim() : existing.base_url;
      const apiKey = data.api_key ? data.api_key.trim() : existing.api_key;
      const modelsJson = data.models ? JSON.stringify(data.models) : existing.models;
      const isActive = data.is_active !== undefined ? (data.is_active ? 1 : 0) : existing.is_active;
      const priority = data.priority !== undefined ? Number(data.priority) : existing.priority;

      db.prepare(`
        UPDATE providers 
        SET name = ?, base_url = ?, api_key = ?, models = ?, is_active = ?, priority = ?
        WHERE id = ?
      `).run(name, baseUrl, apiKey, modelsJson, isActive, priority, id);

      pushToGist().catch(() => {});
      sendJson(res, 200, { message: 'Provider updated' });
      return;
    }

    if (pathname.startsWith('/api/providers/') && req.method === 'DELETE') {
      const id = pathname.replace('/api/providers/', '');
      db.prepare('DELETE FROM providers WHERE id = ?').run(id);
      pushToGist().catch(() => {});
      sendJson(res, 200, { message: 'Provider deleted' });
      return;
    }

    // Manual on-demand sync provider models
    if (pathname.startsWith('/api/providers/') && pathname.endsWith('/sync') && req.method === 'POST') {
      const id = pathname.replace('/api/providers/', '').replace('/sync', '');
      const provider = db.prepare('SELECT * FROM providers WHERE id = ?').get(id);
      if (!provider) {
        sendJson(res, 404, { error: 'Provider not found' });
        return;
      }
      const models = await syncProviderModels(provider);
      sendJson(res, 200, { ok: true, count: models.length, models });
      return;
    }

    // Test connection / probe provider models
    if (pathname === '/api/providers/test' && req.method === 'POST') {
      const { base_url, api_key, name } = await parseJsonBody(req);
      if (!base_url || !api_key) {
        sendJson(res, 400, { error: 'base_url and api_key required' });
        return;
      }
      const testUrl = resolveUrl(base_url, 'v1/models');
      const start = Date.now();
      try {
        const resp = await fetch(testUrl, {
          headers: { 'Authorization': `Bearer ${api_key}` },
          signal: AbortSignal.timeout(12000)
        });
        const latency = Date.now() - start;
        if (resp.ok) {
          const body = await resp.json();
          let models = Array.isArray(body.data) ? body.data.map(m => m.id) : [];

          const isOR = (name || '').toLowerCase().includes('openrouter') ||
                       (base_url || '').toLowerCase().includes('openrouter');
          if (isOR) {
            models = filterOpenRouterModels(models);
          }

          sendJson(res, 200, { ok: true, status: resp.status, latency_ms: latency, models });
        } else {
          const errText = await resp.text();
          sendJson(res, 200, { ok: false, status: resp.status, latency_ms: latency, error: errText.slice(0, 300) });
        }
      } catch (err) {
        sendJson(res, 200, { ok: false, status: 0, latency_ms: Date.now() - start, error: err.message });
      }
      return;
    }

    // Virtual Keys CRUD
    if (pathname === '/api/keys' && req.method === 'GET') {
      const keys = db.prepare('SELECT id, name, key_prefix, is_active, created_at, last_used_at FROM keys ORDER BY created_at DESC').all();
      sendJson(res, 200, keys);
      return;
    }

    if (pathname === '/api/keys' && req.method === 'POST') {
      const { name } = await parseJsonBody(req);
      if (!name) {
        sendJson(res, 400, { error: 'Name required' });
        return;
      }
      const rawKey = 'sk-banue-' + crypto.randomBytes(24).toString('hex');
      const prefix = rawKey.slice(0, 16) + '...';
      const hashed = hashKey(rawKey);
      const id = crypto.randomUUID();

      db.prepare(`
        INSERT INTO keys (id, name, key_hash, key_prefix, is_active, created_at)
        VALUES (?, ?, ?, ?, 1, ?)
      `).run(id, name.trim(), hashed, prefix, Date.now());

      pushToGist().catch(() => {});
      // Return rawKey once so user can copy it
      sendJson(res, 201, { id, name: name.trim(), key: rawKey, prefix });
      return;
    }

    if (pathname.startsWith('/api/keys/') && req.method === 'DELETE') {
      const id = pathname.replace('/api/keys/', '');
      db.prepare('DELETE FROM keys WHERE id = ?').run(id);
      pushToGist().catch(() => {});
      sendJson(res, 200, { message: 'Key deleted' });
      return;
    }

    // Logs list
    if (pathname === '/api/logs' && req.method === 'GET') {
      const logs = db.prepare('SELECT * FROM logs ORDER BY timestamp DESC LIMIT 100').all();
      sendJson(res, 200, logs);
      return;
    }

    // Keepalive configuration
    if (pathname === '/api/keepalive' && req.method === 'POST') {
      const { url: pingerUrl } = await parseJsonBody(req);
      setSetting('render_keepalive_url', (pingerUrl || '').trim());
      refreshKeepalive();
      sendJson(res, 200, { message: 'Keepalive updated', url: pingerUrl });
      return;
    }

    // Backup & Restore
    if (pathname === '/api/backup' && req.method === 'GET') {
      const providers = db.prepare('SELECT * FROM providers').all();
      const keys = db.prepare('SELECT * FROM keys').all();
      const keepaliveUrl = getSetting('render_keepalive_url') || '';
      sendJson(res, 200, {
        version: 1,
        exported_at: Date.now(),
        providers: providers.map(p => ({
          ...p,
          models: JSON.parse(p.models || '[]')
        })),
        keys,
        keepalive_url: keepaliveUrl
      });
      return;
    }

    if (pathname === '/api/backup' && req.method === 'POST') {
      const data = await parseJsonBody(req);
      if (Array.isArray(data.providers)) {
        for (const p of data.providers) {
          if (p.name && p.base_url && p.api_key) {
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
              p.id || crypto.randomUUID(),
              p.name.trim(),
              p.base_url.trim(),
              p.api_key.trim(),
              JSON.stringify(Array.isArray(p.models) ? p.models : ['*']),
              p.is_active ?? 1,
              Number(p.priority) || 0,
              p.created_at || Date.now()
            );
          }
        }
      }

      if (Array.isArray(data.keys)) {
        for (const k of data.keys) {
          if (k.name && k.key_hash && k.key_prefix) {
            db.prepare(`
              INSERT INTO keys (id, name, key_hash, key_prefix, is_active, created_at, last_used_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO NOTHING
            `).run(
              k.id || crypto.randomUUID(),
              k.name,
              k.key_hash,
              k.key_prefix,
              k.is_active ?? 1,
              k.created_at || Date.now(),
              k.last_used_at || null
            );
          }
        }
      }

      if (data.keepalive_url) {
        setSetting('render_keepalive_url', data.keepalive_url.trim());
        refreshKeepalive();
      }

      pushToGist().catch(() => {});
      sendJson(res, 200, { message: 'Backup restored successfully' });
      return;
    }

    // Settings API
    if (pathname === '/api/settings' && req.method === 'GET') {
      const token = process.env.GITHUB_TOKEN || getSetting('github_token') || '';
      sendJson(res, 200, {
        system_prompt_mode: getSetting('system_prompt_mode') || 'passthrough',
        global_system_prompt: getSetting('global_system_prompt') || '',
        github_token_masked: token ? (token.slice(0, 7) + '...' + token.slice(-4)) : '',
        render_keepalive_url: getSetting('render_keepalive_url') || ''
      });
      return;
    }

    if (pathname === '/api/settings' && req.method === 'POST') {
      const data = await parseJsonBody(req);
      if (data.system_prompt_mode) {
        setSetting('system_prompt_mode', data.system_prompt_mode.trim());
      }
      if (data.global_system_prompt !== undefined) {
        setSetting('global_system_prompt', data.global_system_prompt.trim());
      }
      if (data.github_token) {
        setSetting('github_token', data.github_token.trim());
        await pullFromGist();
      }
      if (data.render_keepalive_url !== undefined) {
        setSetting('render_keepalive_url', data.render_keepalive_url.trim());
        refreshKeepalive();
      }
      await pushToGist();
      sendJson(res, 200, { message: 'Settings updated' });
      return;
    }

    // Force Sync with Gist
    if (pathname === '/api/sync/gist' && req.method === 'POST') {
      const { action } = await parseJsonBody(req);
      if (action === 'push') {
        const ok = await pushToGist();
        sendJson(res, 200, { ok, message: ok ? 'Сохранено в GitHub Gist' : 'Ошибка сохранения' });
      } else {
        const ok = await pullFromGist();
        sendJson(res, 200, { ok, message: ok ? 'Восстановлено из GitHub Gist' : 'Ошибка загрузки' });
      }
      return;
    }

    // 404 for unknown /api/
    sendJson(res, 404, { error: 'API route not found' });
    return;
  }

  // 4. Static UI assets
  if (req.method === 'GET') {
    serveStatic(res, pathname);
    return;
  }

  res.writeHead(405);
  res.end('Method not allowed');
});

// Start Server
server.listen(PORT, HOST, async () => {
  const masterKey = getOrCreateAdminKey();
  refreshKeepalive();
  startPeriodicModelSync();
  await pullFromGist().catch(() => {});
  console.log(`\n========================================`);
  console.log(`🚀 banuerllm running on http://${HOST}:${PORT}`);
  console.log(`🔑 Master Admin Key: ${masterKey}`);
  console.log(`========================================\n`);
});
