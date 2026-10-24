import { Readable } from 'node:stream';
import crypto from 'node:crypto';
import { db, hashKey, getOrCreateAdminKey } from './db.js';

export function resolveUrl(base, path) {
  let b = base.trim().replace(/\/+$/, '');
  let p = path.trim().replace(/^\/+/, '');
  if (b.endsWith('/v1') && p.startsWith('v1/')) {
    p = p.slice(3);
  }
  return `${b}/${p}`;
}

export function authenticateRequest(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { authenticated: false, error: 'Missing or invalid Authorization header' };
  }

  const rawKey = authHeader.slice(7).trim();
  const masterKey = getOrCreateAdminKey();

  if (rawKey === masterKey) {
    return { authenticated: true, keyName: 'master-admin', isMaster: true };
  }

  const hashed = hashKey(rawKey);
  const keyRow = db.prepare('SELECT id, name, is_active FROM keys WHERE key_hash = ?').get(hashed);

  if (!keyRow) {
    return { authenticated: false, error: 'Invalid API key' };
  }

  if (!keyRow.is_active) {
    return { authenticated: false, error: 'API key is deactivated' };
  }

  // Update last_used_at
  db.prepare('UPDATE keys SET last_used_at = ? WHERE id = ?').run(Date.now(), keyRow.id);

  return { authenticated: true, keyName: keyRow.name, isMaster: false };
}

export function resolveProviderAndModel(requestedModel) {
  const activeProviders = db.prepare(`
    SELECT * FROM providers 
    WHERE is_active = 1 
    ORDER BY priority DESC, created_at ASC
  `).all();

  if (!activeProviders || activeProviders.length === 0) {
    return null;
  }

  // 1. Check for provider prefix: <provider_name>/<model_name>
  for (const prov of activeProviders) {
    const raw = prov.name.trim().toLowerCase();
    const slug = raw.replace(/\s+/g, '-');
    const unders = raw.replace(/\s+/g, '_');
    const firstWord = raw.split(/[\s\-_]+/)[0];

    const prefixes = new Set([
      raw + '/',
      slug + '/',
      unders + '/',
      ...(firstWord ? [firstWord + '/'] : [])
    ]);

    for (const prefix of prefixes) {
      if (requestedModel.toLowerCase().startsWith(prefix)) {
        const upstreamModel = requestedModel.slice(prefix.length);
        if (!upstreamModel) continue;

        try {
          const models = JSON.parse(prov.models || '[]');
          if (Array.isArray(models)) {
            // Wildcard or explicit model support
            if (models.includes('*') || models.some(m => m.toLowerCase() === upstreamModel.toLowerCase())) {
              return { provider: prov, upstreamModel };
            }
          }
        } catch {}
      }
    }
  }

  // 2. Direct exact match in models list
  for (const prov of activeProviders) {
    try {
      const models = JSON.parse(prov.models || '[]');
      if (Array.isArray(models) && models.includes(requestedModel)) {
        return { provider: prov, upstreamModel: requestedModel };
      }
    } catch {}
  }

  // 3. Fallback to wildcard ('*') provider
  for (const prov of activeProviders) {
    try {
      const models = JSON.parse(prov.models || '[]');
      if (Array.isArray(models) && models.includes('*')) {
        return { provider: prov, upstreamModel: requestedModel };
      }
    } catch {}
  }

  return null;
}

export function logRequest({ keyName, model, providerName, statusCode, latencyMs, stream, error }) {
  try {
    const id = crypto.randomUUID();
    db.prepare(`
      INSERT INTO logs (id, timestamp, key_name, model, provider_name, status_code, latency_ms, stream, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      Date.now(),
      keyName || 'unknown',
      model || 'unknown',
      providerName || 'none',
      statusCode || 0,
      latencyMs || 0,
      stream ? 1 : 0,
      error ? String(error).slice(0, 1000) : null
    );

    // Keep log table to reasonable size (last 2000 records)
    db.exec(`
      DELETE FROM logs WHERE id IN (
        SELECT id FROM logs ORDER BY timestamp DESC LIMIT -1 OFFSET 2000
      )
    `);
  } catch (err) {
    console.error('Failed to write log:', err);
  }
}

export async function handleChatCompletions(req, res, auth) {
  const startTime = Date.now();
  let bodyBuffer = [];

  for await (const chunk of req) {
    bodyBuffer.push(chunk);
  }

  const rawBody = Buffer.concat(bodyBuffer).toString('utf-8');
  let parsedBody;

  try {
    parsedBody = JSON.parse(rawBody);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: { message: 'Invalid JSON body', type: 'invalid_request_error', code: 400 }
    }));
    return;
  }

  const model = parsedBody.model;
  const isStream = Boolean(parsedBody.stream);

  if (!model) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: { message: 'Missing "model" in request body', type: 'invalid_request_error', code: 400 }
    }));
    return;
  }

  const resolved = resolveProviderAndModel(model);

  if (!resolved) {
    const latency = Date.now() - startTime;
    logRequest({
      keyName: auth.keyName,
      model,
      providerName: 'none',
      statusCode: 404,
      latencyMs: latency,
      stream: isStream,
      error: `No active provider configured for model: ${model}`
    });

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: {
        message: `Model "${model}" not found or no provider configured for it in banuerllm`,
        type: 'model_not_found',
        code: 404
      }
    }));
    return;
  }

  const { provider, upstreamModel } = resolved;
  const targetUrl = resolveUrl(provider.base_url, 'v1/chat/completions');

  // Strip provider prefix for upstream
  parsedBody.model = upstreamModel;
  const forwardBody = JSON.stringify(parsedBody);

  try {
    const upstreamRes = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${provider.api_key}`
      },
      body: forwardBody
    });

    if (isStream && upstreamRes.ok) {
      res.writeHead(upstreamRes.status, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      });

      if (upstreamRes.body) {
        const stream = Readable.fromWeb(upstreamRes.body);
        stream.pipe(res);

        stream.on('end', () => {
          const latency = Date.now() - startTime;
          logRequest({
            keyName: auth.keyName,
            model,
            providerName: provider.name,
            statusCode: upstreamRes.status,
            latencyMs: latency,
            stream: 1
          });
        });

        stream.on('error', (err) => {
          const latency = Date.now() - startTime;
          logRequest({
            keyName: auth.keyName,
            model,
            providerName: provider.name,
            statusCode: 500,
            latencyMs: latency,
            stream: 1,
            error: err.message
          });
        });
      } else {
        res.end();
      }
    } else {
      const responseData = await upstreamRes.text();
      const latency = Date.now() - startTime;

      logRequest({
        keyName: auth.keyName,
        model,
        providerName: provider.name,
        statusCode: upstreamRes.status,
        latencyMs: latency,
        stream: isStream ? 1 : 0,
        error: upstreamRes.ok ? null : responseData.slice(0, 500)
      });

      const contentType = upstreamRes.headers.get('content-type') || 'application/json';
      res.writeHead(upstreamRes.status, { 'Content-Type': contentType });
      res.end(responseData);
    }
  } catch (err) {
    const latency = Date.now() - startTime;
    logRequest({
      keyName: auth.keyName,
      model,
      providerName: provider.name,
      statusCode: 502,
      latencyMs: latency,
      stream: isStream ? 1 : 0,
      error: err.message
    });

    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: {
        message: `Upstream error contacting ${provider.name}: ${err.message}`,
        type: 'proxy_upstream_error',
        code: 502
      }
    }));
  }
}

export function handleGetModels(res) {
  const activeProviders = db.prepare('SELECT name, models FROM providers WHERE is_active = 1').all();
  const modelSet = new Set();

  for (const prov of activeProviders) {
    const rawName = (prov.name || '').trim();
    const slug = rawName.toLowerCase().replace(/\s+/g, '-');

    try {
      const parsed = JSON.parse(prov.models || '[]');
      if (Array.isArray(parsed)) {
        for (const m of parsed) {
          if (m && m !== '*') {
            // Unscoped model
            modelSet.add(m);
            // Provider-scoped model
            if (slug) {
              modelSet.add(`${slug}/${m}`);
            }
          }
        }
      }
    } catch {}
  }

  const modelList = Array.from(modelSet).map((id) => ({
    id,
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: 'banuerllm'
  }));

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    object: 'list',
    data: modelList
  }));
}
