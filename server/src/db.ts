import Database from "better-sqlite3";
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { config } from "./config.js";

// We persist each room as a single JSON blob keyed by its code, plus an
// `expires_at` column the sweep can index on. All shared state lives in memory
// (see rooms.ts); SQLite is the durable mirror so a restart rehydrates rooms.
// Access is exclusively via prepared statements — no string-built SQL.

let db: Database.Database;

export function initDb(): void {
  const dir = path.dirname(config.dbPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  db = new Database(config.dbPath);
  db.pragma("journal_mode = WAL");
  // The DB stores host/player tokens in plaintext, so keep it readable only by
  // the service user (defense in depth — the systemd sandbox already isolates
  // it). chmod the dir in case it pre-existed with looser perms, then the DB
  // file and its WAL/SHM siblings. Each is best-effort: not being the owner or
  // a sibling not yet existing must not stop the server from booting.
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* not owner / unsupported FS — non-fatal */
  }
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      chmodSync(config.dbPath + suffix, 0o600);
    } catch {
      /* sibling may not exist yet — recreated and re-chmod'd on next boot */
    }
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS rooms (
      code       TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      data       TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_rooms_expires ON rooms(expires_at);
  `);
}

const stmts = {
  upsert: () =>
    db.prepare(
      `INSERT INTO rooms (code, expires_at, updated_at, data)
       VALUES (@code, @expiresAt, @updatedAt, @data)
       ON CONFLICT(code) DO UPDATE SET
         expires_at = excluded.expires_at,
         updated_at = excluded.updated_at,
         data = excluded.data`,
    ),
  loadAll: () => db.prepare(`SELECT code, data FROM rooms WHERE expires_at > ?`),
  expired: () => db.prepare(`SELECT code FROM rooms WHERE expires_at <= ?`),
};

export function saveRoom(code: string, expiresAt: number, data: string): void {
  stmts.upsert().run({ code, expiresAt, updatedAt: Date.now(), data });
}

/** Load all non-expired rooms' JSON (called once on boot). */
export function loadRooms(now: number): { code: string; data: string }[] {
  return stmts.loadAll().all(now) as { code: string; data: string }[];
}

/** Return + delete all expired room codes. */
export function purgeExpired(now: number): string[] {
  const rows = stmts.expired().all(now) as { code: string }[];
  const codes = rows.map((r) => r.code);
  if (codes.length) {
    const del = db.prepare(`DELETE FROM rooms WHERE expires_at <= ?`);
    del.run(now);
  }
  return codes;
}
