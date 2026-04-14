/**
 * db-patch.js — Safe column migration for launch data fields
 *
 * Add this to your db.js initDb() function, or run once on startup.
 * Uses try/catch per column so existing columns don't crash the migration.
 *
 * USAGE: import { runMigrations } from './db-patch.js';
 *        Call runMigrations(db) inside your initDb() after table creation.
 */

'use strict';

export function runMigrations(db) {
  console.log('[db-patch] Running column migrations...');

  // Each entry: [table, column, type, default]
  const candidateCols = [
    ['launch_quality_score',       'REAL',    'NULL'],
    ['launch_unique_buyer_ratio',  'REAL',    'NULL'],
    ['launch_top_buyer_share',     'REAL',    'NULL'],
    ['launch_top3_buyer_share',    'REAL',    'NULL'],
    ['launch_tx_count',            'INTEGER', 'NULL'],
    ['launch_unique_buyers',       'INTEGER', 'NULL'],
    ['sniper_wallet_count',        'INTEGER', 'NULL'],
    ['buy_sell_ratio_1h',          'REAL',    'NULL'],
    ['buy_sell_ratio_6h',          'REAL',    'NULL'],
    ['volume_velocity',            'REAL',    'NULL'],
    ['buy_velocity',               'REAL',    'NULL'],
    ['breakout_score',             'REAL',    'NULL'],
    ['recovery_score',             'REAL',    'NULL'],
    ['holder_dist_score',          'REAL',    'NULL'],
    ['fresh_wallet_inflows',       'INTEGER', 'NULL'],
    ['bundle_risk_helius',         'TEXT',    'NULL'],
    ['bot_source',                 'TEXT',    'NULL'],
    ['sltp',                       'TEXT',    'NULL'],
    ['wallet_intel_score',         'REAL',    'NULL'],
    ['cluster_risk',               'TEXT',    'NULL'],
    ['coordination_intensity',     'TEXT',    'NULL'],
    ['momentum_grade',             'TEXT',    'NULL'],
    ['survival_score',             'REAL',    'NULL'],
    ['unique_buyers_5min',         'INTEGER', 'NULL'],
    ['buy_velocity_per_min',       'REAL',    'NULL'],
  ];

  const callCols = [
    ['bot_source', 'TEXT', 'NULL'],
    ['sltp',       'TEXT', 'NULL'],
  ];

  let added = 0;
  let skipped = 0;

  for (const [col, type, def] of candidateCols) {
    try {
      db.exec(`ALTER TABLE candidates ADD COLUMN ${col} ${type} DEFAULT ${def}`);
      added++;
      console.log(`[db-patch] ✓ candidates.${col}`);
    } catch (e) {
      // Column already exists — totally fine
      skipped++;
    }
  }

  for (const [col, type, def] of callCols) {
    try {
      db.exec(`ALTER TABLE calls ADD COLUMN ${col} ${type} DEFAULT ${def}`);
      added++;
      console.log(`[db-patch] ✓ calls.${col}`);
    } catch (e) {
      skipped++;
    }
  }

  console.log(`[db-patch] Done — ${added} added, ${skipped} already existed`);
}
