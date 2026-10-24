import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import crypto from 'node:crypto';

const dbPath = process.env.DATABASE_PATH || './data/banuerllm.db';
mkdirSync(dirname(dbPath), { recursive: true });

export const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA synchronous = NORMAL;');

// Initialize tables
db.exec(`
  CREATE TABLE IF NOT EXISTS providers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    api_key TEXT NOT NULL,
    models TEXT NOT NULL DEFAULT '[]',
    is_active INTEGER DEFAULT 1,
    priority INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS keys (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    key_prefix TEXT NOT NULL,
    is_active INTEGER DEFAULT 1,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS logs (
    id TEXT PRIMARY KEY,
    timestamp INTEGER NOT NULL,
    key_name TEXT,
    model TEXT,
    provider_name TEXT,
    status_code INTEGER,
    latency_ms INTEGER,
    stream INTEGER DEFAULT 0,
    error TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp DESC);

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

export function hashKey(rawKey) {
  return crypto.createHash('sha256').update(rawKey.trim()).digest('hex');
}

export function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

export function setSetting(key, value) {
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

// Master Admin Key setup
export function getOrCreateAdminKey() {
  if (process.env.ADMIN_KEY) {
    return process.env.ADMIN_KEY;
  }
  let existing = getSetting('admin_key');
  if (!existing) {
    existing = 'banue-admin-' + crypto.randomBytes(12).toString('hex');
    setSetting('admin_key', existing);
  }
  return existing;
}

export function seedProvidersFromEnv() {
  if (!process.env.PROVIDERS_CONFIG) return;
  try {
    const count = db.prepare('SELECT COUNT(*) as c FROM providers').get().c;
    if (count === 0) {
      const list = JSON.parse(process.env.PROVIDERS_CONFIG);
      if (Array.isArray(list)) {
        for (const item of list) {
          if (item.name && item.base_url && item.api_key) {
            db.prepare(`
              INSERT INTO providers (id, name, base_url, api_key, models, is_active, priority, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
              item.id || crypto.randomUUID(),
              item.name.trim(),
              item.base_url.trim(),
              item.api_key.trim(),
              JSON.stringify(Array.isArray(item.models) ? item.models : ['*']),
              item.is_active ?? 1,
              item.priority || 0,
              Date.now()
            );
          }
        }
        console.log(`[Seed] Seeded ${list.length} providers from PROVIDERS_CONFIG`);
      }
    }
  } catch (err) {
    console.error('[Seed] Failed to parse PROVIDERS_CONFIG:', err.message);
  }
}

seedProvidersFromEnv();

