// ─────────────────────────────────────────────────────────────────────────────
// dev-fingerprint.js
//
// Behavioral fingerprint for token deployers. Aggregates every token we've
// seen that was deployed by a given wallet and scores the dev's track record.
// The scoring result can then boost/penalize new tokens by the same dev.
//
// Grade rubric (based on wins / losses / avg peak multiple):
//   ELITE     — 3+ launches, win rate >= 60%, avg peak >= 3x
//   PROVEN    — 2+ launches, win rate >= 40%, avg peak >= 1.5x
//   NEUTRAL   — <2 decided launches OR unknown outcome
//   SUSPECT   — 2+ launches, win rate 20-40%, or losses > wins
//   RUGGER    — losses >= 3 AND win rate < 20%
//
// Refreshes are lazy: if a fingerprint is older than 6h, rebuild from DB.
// ─────────────────────────────────────────────────────────────────────────────

const REFRESH_TTL_MS = 6 * 60 * 60_000;

function classify(stats) {
  const { total_launches: n, wins, losses, win_rate: wr, avg_peak_multiple: avgPeak } = stats;
  if (n < 2)                                      return 'NEUTRAL';
  if (losses >= 3 && wr < 0.20)                   return 'RUGGER';
  if (wr < 0.40 && losses >= wins)                return 'SUSPECT';
  if (n >= 3 && wr >= 0.60 && (avgPeak||0) >= 3)  return 'ELITE';
  if (wr >= 0.40 && (avgPeak||0) >= 1.5)          return 'PROVEN';
  return 'NEUTRAL';
}

function computeScore(stats) {
  const { total_launches: n, win_rate: wr, avg_peak_multiple: avgPeak, losses } = stats;
  if (n === 0) return 50;
  // Base: win rate is the dominant signal
  let score = (wr ?? 0) * 60;
  // Peak multiple bonus (capped at +20)
  score += Math.min((avgPeak ?? 0) * 4, 20);
  // Sample-size confidence
  score += Math.min(n * 3, 15);
  // Loss penalty
  score -= losses * 3;
  return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * Rebuild a dev's fingerprint from audit_archive + candidates data.
 * Writes to dev_fingerprints (UPSERT).
 */
export function rebuildDevFingerprint(deployer, dbInstance) {
  if (!deployer || !dbInstance) return null;
  try {
    // Pull every launch we've seen by this deployer. We use BOTH sources:
    //   audit_archive for resolved/promoted tokens
    //   candidates table for anything else we scored that referenced this dev
    const row = dbInstance.prepare(`
      SELECT
        COUNT(*)                                                 as total_launches,
        SUM(CASE WHEN outcome='WIN'  THEN 1 ELSE 0 END)          as wins,
        SUM(CASE WHEN outcome='LOSS' THEN 1 ELSE 0 END)          as losses,
        SUM(CASE WHEN outcome='PENDING' OR outcome IS NULL THEN 1 ELSE 0 END) as pending,
        AVG(peak_multiple)                                        as avg_peak_multiple,
        MAX(peak_multiple)                                        as best_peak_multiple,
        MIN(CASE WHEN outcome='LOSS' THEN peak_multiple END)      as worst_loss_multiple,
        AVG(composite_score)                                      as avg_composite_score,
        MIN(created_at)                                           as first_seen_at,
        MAX(created_at)                                           as last_launch_at
      FROM audit_archive
      WHERE deployer_verdict IS NOT NULL OR contract_address IS NOT NULL
        AND contract_address IN (
          SELECT contract_address FROM candidates WHERE deployer_verdict = ?
        )
    `).get(deployer) || {};

    // Fallback: if audit_archive path returned nothing, aggregate from candidates
    if (!row.total_launches) {
      const alt = dbInstance.prepare(`
        SELECT
          COUNT(*) as total_launches,
          0 as wins, 0 as losses, COUNT(*) as pending,
          AVG(composite_score) as avg_composite_score,
          MIN(created_at) as first_seen_at,
          MAX(created_at) as last_launch_at
        FROM candidates
        WHERE deployer_verdict = ?
      `).get(deployer) || {};
      Object.assign(row, alt);
    }

    const decided = (row.wins || 0) + (row.losses || 0);
    row.win_rate = decided > 0 ? row.wins / decided : null;
    row.total_launches = row.total_launches || 0;
    const grade = classify(row);
    const fingerprint_score = computeScore(row);

    dbInstance.prepare(`
      INSERT INTO dev_fingerprints (
        deployer_address, total_launches, wins, losses, pending,
        avg_peak_multiple, best_peak_multiple, worst_loss_multiple,
        avg_composite_score, win_rate, fingerprint_score, grade,
        first_seen_at, last_launch_at, refreshed_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
      ON CONFLICT(deployer_address) DO UPDATE SET
        total_launches      = excluded.total_launches,
        wins                = excluded.wins,
        losses              = excluded.losses,
        pending             = excluded.pending,
        avg_peak_multiple   = excluded.avg_peak_multiple,
        best_peak_multiple  = excluded.best_peak_multiple,
        worst_loss_multiple = excluded.worst_loss_multiple,
        avg_composite_score = excluded.avg_composite_score,
        win_rate            = excluded.win_rate,
        fingerprint_score   = excluded.fingerprint_score,
        grade               = excluded.grade,
        last_launch_at      = excluded.last_launch_at,
        refreshed_at        = datetime('now')
    `).run(
      deployer, row.total_launches, row.wins||0, row.losses||0, row.pending||0,
      row.avg_peak_multiple, row.best_peak_multiple, row.worst_loss_multiple,
      row.avg_composite_score, row.win_rate, fingerprint_score, grade,
      row.first_seen_at || null, row.last_launch_at || null,
    );
    return { ...row, grade, fingerprint_score };
  } catch (err) {
    console.warn('[dev-fingerprint] rebuild failed:', err.message);
    return null;
  }
}

/**
 * Read a dev's fingerprint, lazily rebuilding if stale or missing.
 */
export function getDevFingerprint(deployer, dbInstance) {
  if (!deployer || !dbInstance) return null;
  try {
    const existing = dbInstance.prepare(
      `SELECT * FROM dev_fingerprints WHERE deployer_address=?`
    ).get(deployer);
    if (existing) {
      const age = Date.now() - new Date(existing.refreshed_at + 'Z').getTime();
      if (age < REFRESH_TTL_MS) return existing;
    }
    return rebuildDevFingerprint(deployer, dbInstance);
  } catch { return null; }
}

/**
 * Score adjustment for a candidate based on the deployer's fingerprint.
 * Returns { delta, reason } to feed into the scorer layer.
 */
export function devScoreAdjustment(fingerprint) {
  if (!fingerprint || !fingerprint.grade) return { delta: 0, reason: null };
  switch (fingerprint.grade) {
    case 'ELITE':
      return { delta: +15, reason: `Elite dev (${fingerprint.wins}W/${fingerprint.losses}L · ${Math.round((fingerprint.win_rate||0)*100)}% WR · best ${fingerprint.best_peak_multiple?.toFixed?.(1) ?? '?'}x)` };
    case 'PROVEN':
      return { delta: +8, reason: `Proven dev (${fingerprint.wins}W/${fingerprint.losses}L · avg peak ${fingerprint.avg_peak_multiple?.toFixed?.(1) ?? '?'}x)` };
    case 'SUSPECT':
      return { delta: -10, reason: `Suspect dev (${fingerprint.wins}W/${fingerprint.losses}L — subpar record)` };
    case 'RUGGER':
      return { delta: -30, reason: `RUGGER dev (${fingerprint.losses} losses, ${Math.round((fingerprint.win_rate||0)*100)}% WR)` };
    default:
      return { delta: 0, reason: null };
  }
}
