// The SQLite file: one key/value table for the pods' set-up and saved looks.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

// Each entry upgrades the schema by one version (tracked in PRAGMA user_version).
const MIGRATIONS = [
  `
  CREATE TABLE pods_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `,
];

export function openDb(file) {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;');
  const { user_version: version } = db.prepare('PRAGMA user_version').get();
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return db;
}

// The store lib/pods keeps its set-up and looks in.
export function podsStore(db) {
  const get = db.prepare('SELECT value FROM pods_state WHERE key = ?');
  const put = db.prepare("INSERT OR REPLACE INTO pods_state (key, value, updated_at) VALUES (?, ?, datetime('now'))");
  return {
    get(key) {
      const r = get.get(String(key));
      return r ? JSON.parse(r.value) : undefined;
    },
    set(key, value) {
      put.run(String(key), JSON.stringify(value));
    },
  };
}
