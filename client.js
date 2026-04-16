/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  db/client.js — PostgreSQL connection pool
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false,
});

pool.on('error', (err) => {
  console.error('[db] Pool error:', err.message);
});

// ─── Query helpers ────────────────────────────────────────────────────────────

export async function query(sql, params = []) {
  const start = Date.now();
  try {
    const result = await pool.query(sql, params);
    const ms = Date.now() - start;
    if (ms > 2000) console.warn(`[db] Slow query (${ms}ms):`, sql.slice(0, 80));
    return result;
  } catch (err) {
    console.error('[db] Query error:', err.message, '\nSQL:', sql.slice(0, 200));
    throw err;
  }
}

export async function queryOne(sql, params = []) {
  const result = await query(sql, params);
  return result.rows[0] ?? null;
}

export async function queryAll(sql, params = []) {
  const result = await query(sql, params);
  return result.rows;
}

export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function logEvent(level, eventType, message, data = null) {
  try {
    await query(
      `INSERT INTO tracker_events (level, event_type, message, data)
       VALUES ($1, $2, $3, $4)`,
      [level, eventType, message, data ? JSON.stringify(data) : null]
    );
  } catch {}
}

export { pool };
