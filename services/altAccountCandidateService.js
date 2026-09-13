const { isTrustedLinkMethod } = require('../utils/linkTrust');

const REVIEW_STATUSES = new Set(['pending', 'confirmed', 'dismissed']);
const RAPID_SWITCH_SECONDS = 300;
const LIKELY_SWITCH_SECONDS = 120;
const ENFORCED_RPT_WAIT_MS = 60000;
const CONFIDENCE_RANK = { possible: 0, likely: 1, confirmed: 2 };

function pairKey(a, b) {
  const low = Math.min(Number(a), Number(b));
  const high = Math.max(Number(a), Number(b));
  return `${low}:${high}`;
}

function normalizeReviewStatus(status) {
  const normalized = String(status || '').trim().toLowerCase();
  if (!REVIEW_STATUSES.has(normalized)) {
    throw new Error('Invalid review status');
  }
  return normalized;
}

function accountSummary(account) {
  return {
    identityId: Number(account.identity_id),
    gamertag: account.gamertag || 'Unknown',
    platform: account.platform || 'unknown',
  };
}

function sessionsOverlap(left, right) {
  const leftStart = Date.parse(left.login_at);
  const leftEnd = Date.parse(left.logout_at);
  const rightStart = Date.parse(right.login_at);
  const rightEnd = Date.parse(right.logout_at);
  if (![leftStart, leftEnd, rightStart, rightEnd].every(Number.isFinite)) return false;
  return leftStart < rightEnd && rightStart < leftEnd;
}

function pairWasConcurrent(sessionsByIdentity, firstId, secondId) {
  const first = sessionsByIdentity.get(firstId) || [];
  const second = sessionsByIdentity.get(secondId) || [];
  for (const left of first) {
    for (const right of second) {
      if (sessionsOverlap(left, right)) return true;
    }
  }
  return false;
}

function buildReviewMap(reviews) {
  return new Map((reviews || []).map(review => [
    pairKey(review.identity_id_low, review.identity_id_high),
    {
      status: review.status || 'pending',
      notes: review.notes || '',
      reviewedAt: review.reviewed_at || null,
      reviewedBy: review.reviewed_by || null,
    },
  ]));
}

function createCandidate(accountsById, firstId, secondId, confidence, evidence, reviewMap) {
  const identityIds = [Math.min(firstId, secondId), Math.max(firstId, secondId)];
  return {
    identityIds,
    accounts: identityIds.map(id => accountSummary(accountsById.get(id))),
    confidence,
    evidence,
    review: reviewMap.get(pairKey(firstId, secondId)) || {
      status: 'pending',
      notes: '',
      reviewedAt: null,
      reviewedBy: null,
    },
  };
}

function firstSessionAfter(sessions, timestampMs) {
  let low = 0;
  let high = sessions.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (Date.parse(sessions[middle].login_at) <= timestampMs) low = middle + 1;
    else high = middle;
  }
  return low;
}

function distinctDaysLabel(count) {
  return Number(count) >= 2
    ? 'Handoffs occurred on separate days'
    : 'Handoffs observed on one day';
}

function formatWaitDuration(durationMs) {
  const totalSeconds = Math.max(0, Math.floor(Number(durationMs) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function behaviorEvidenceFromAggregate(row) {
  const eventCount = Number(row.event_count);
  const strictCount = Number(row.strict_count);
  const distinctDays = Number(row.distinct_days);
  const waitCount = Number(row.enforced_wait_count || 0);
  const evidence = [
    {
      type: 'rapid_switches',
      label: eventCount === 1
        ? `Account handoff within ${RAPID_SWITCH_SECONDS / 60} minutes`
        : `Repeated account handoffs within ${RAPID_SWITCH_SECONDS / 60} minutes`,
      count: eventCount,
      strictCount,
      minimumDelaySeconds: Number(row.minimum_delay_seconds),
    },
    {
      type: 'distinct_days',
      label: distinctDaysLabel(distinctDays),
      count: distinctDays,
    },
  ];
  if (Number(row.strict_direction_count) >= 2) {
    evidence.push({
      type: 'bidirectional_switches',
      label: 'Handoffs occurred in both directions',
    });
  }
  if (waitCount === 0) {
    evidence.push({
      type: 'never_concurrent',
      label: 'No overlapping completed sessions were observed',
    });
  }
  const minimumWaitMs = Number(row.minimum_wait_duration_ms);
  const maximumWaitMs = Number(row.maximum_wait_duration_ms);
  if (waitCount > 0 && Number.isFinite(minimumWaitMs) && Number.isFinite(maximumWaitMs)) {
    const range = minimumWaitMs === maximumWaitMs
      ? formatWaitDuration(minimumWaitMs)
      : `${formatWaitDuration(minimumWaitMs)}–${formatWaitDuration(maximumWaitMs)}`;
    evidence.push({
      type: 'rpt_login_wait',
      label: `RPT login-state waits observed: ${range}`,
      count: waitCount,
      minimumWaitSeconds: minimumWaitMs / 1000,
      maximumWaitSeconds: maximumWaitMs / 1000,
    });
  }
  return evidence;
}

function buildAltCandidates({ accounts = [], sessions = [], reviews = [], behaviorCandidates = [] }) {
  const accountsById = new Map(accounts.map(account => [Number(account.identity_id), account]));
  const reviewMap = buildReviewMap(reviews);
  const candidates = new Map();

  const linkedGroups = new Map();
  for (const account of accounts) {
    if (!account.linked_user_id || !isTrustedLinkMethod(account.verification_method)) continue;
    const linkedUserId = String(account.linked_user_id);
    if (!linkedGroups.has(linkedUserId)) linkedGroups.set(linkedUserId, []);
    linkedGroups.get(linkedUserId).push(Number(account.identity_id));
  }
  for (const identityIds of linkedGroups.values()) {
    const uniqueIds = [...new Set(identityIds)].sort((a, b) => a - b);
    for (let i = 0; i < uniqueIds.length; i++) {
      for (let j = i + 1; j < uniqueIds.length; j++) {
        const firstId = uniqueIds[i];
        const secondId = uniqueIds[j];
        candidates.set(pairKey(firstId, secondId), createCandidate(
          accountsById,
          firstId,
          secondId,
          'confirmed',
          [{
            type: 'verified_discord_owner',
            label: 'Both accounts have trusted ownership verification to the same Discord user',
          }],
          reviewMap
        ));
      }
    }
  }

  const validSessions = sessions
    .filter(item => accountsById.has(Number(item.identity_id)))
    .filter(item => Number.isFinite(Date.parse(item.login_at)) && Number.isFinite(Date.parse(item.logout_at)))
    .map(item => ({ ...item, identity_id: Number(item.identity_id) }))
    .sort((a, b) => Date.parse(a.login_at) - Date.parse(b.login_at));
  const sessionsByIdentity = new Map();
  for (const item of validSessions) {
    if (!sessionsByIdentity.has(item.identity_id)) sessionsByIdentity.set(item.identity_id, []);
    sessionsByIdentity.get(item.identity_id).push(item);
  }

  const transitions = new Map();
  for (const ending of validSessions) {
    const logoutMs = Date.parse(ending.logout_at);
    const firstFollowingIndex = firstSessionAfter(validSessions, logoutMs);
    for (let index = firstFollowingIndex; index < validSessions.length; index++) {
      const starting = validSessions[index];
      const loginMs = Date.parse(starting.login_at);
      const delaySeconds = Math.floor((loginMs - logoutMs) / 1000);
      if (delaySeconds > RAPID_SWITCH_SECONDS) break;
      if (ending.identity_id === starting.identity_id) continue;
      const key = pairKey(ending.identity_id, starting.identity_id);
      if (!transitions.has(key)) {
        transitions.set(key, {
          firstId: Math.min(ending.identity_id, starting.identity_id),
          secondId: Math.max(ending.identity_id, starting.identity_id),
          events: [],
          days: new Set(),
        });
      }
      const transition = transitions.get(key);
      transition.events.push({
        delaySeconds,
        at: ending.logout_at,
        direction: `${ending.identity_id}>${starting.identity_id}`,
      });
      transition.days.add(new Date(logoutMs).toISOString().slice(0, 10));
      break;
    }
  }

  for (const transition of transitions.values()) {
    const strictEvents = transition.events.filter(event => event.delaySeconds <= LIKELY_SWITCH_SECONDS);
    const strictDirections = new Set(strictEvents.map(event => event.direction));
    if (strictEvents.length < 2 || strictDirections.size < 2) continue;
    if (pairWasConcurrent(sessionsByIdentity, transition.firstId, transition.secondId)) continue;

    const strictSwitches = strictEvents.length;
    const strictDays = new Set(strictEvents.map(event => String(event.at).slice(0, 10)));
    const confidence = strictSwitches >= 3 && strictDays.size >= 2 ? 'likely' : 'possible';
    const delays = transition.events.map(event => event.delaySeconds);
    const behaviorEvidence = [
      {
        type: 'rapid_switches',
        label: `Repeated account handoffs within ${RAPID_SWITCH_SECONDS / 60} minutes`,
        count: transition.events.length,
        strictCount: strictSwitches,
        minimumDelaySeconds: Math.min(...delays),
      },
      {
        type: 'distinct_days',
        label: distinctDaysLabel(transition.days.size),
        count: transition.days.size,
      },
      {
        type: 'bidirectional_switches',
        label: 'Handoffs occurred in both directions',
      },
      {
        type: 'never_concurrent',
        label: 'No overlapping completed sessions were observed',
      },
    ];
    const key = pairKey(transition.firstId, transition.secondId);
    const existing = candidates.get(key);
    if (existing) {
      existing.evidence.push(...behaviorEvidence);
    } else {
      candidates.set(key, createCandidate(
        accountsById,
        transition.firstId,
        transition.secondId,
        confidence,
        behaviorEvidence,
        reviewMap
      ));
    }
  }

  for (const row of behaviorCandidates) {
    const firstId = Number(row.identity_id_low);
    const secondId = Number(row.identity_id_high);
    if (!accountsById.has(firstId) || !accountsById.has(secondId)) continue;
    const strictDays = Number(row.strict_distinct_days);
    const hasEnforcedRPTWait = Number(row.enforced_wait_count || 0) > 0;
    const confidence = hasEnforcedRPTWait
      ? 'confirmed'
      : (Number(row.strict_count) >= 3 && strictDays >= 2 ? 'likely' : 'possible');
    const evidence = behaviorEvidenceFromAggregate(row);
    const key = pairKey(firstId, secondId);
    const existing = candidates.get(key);
    if (existing) {
      existing.evidence.push(...evidence);
      if (CONFIDENCE_RANK[confidence] > CONFIDENCE_RANK[existing.confidence]) {
        existing.confidence = confidence;
      }
    } else {
      candidates.set(key, createCandidate(
        accountsById,
        firstId,
        secondId,
        confidence,
        evidence,
        reviewMap
      ));
    }
  }

  for (const review of reviews) {
    const firstId = Number(review.identity_id_low);
    const secondId = Number(review.identity_id_high);
    const key = pairKey(firstId, secondId);
    if (candidates.has(key) || !accountsById.has(firstId) || !accountsById.has(secondId)) continue;
    candidates.set(key, createCandidate(
      accountsById,
      firstId,
      secondId,
      review.status === 'confirmed' ? 'confirmed' : 'possible',
      [{
        type: 'persisted_review',
        label: 'Persisted moderator decision; current detection evidence is no longer available',
      }],
      reviewMap
    ));
  }

  const confidenceOrder = { confirmed: 0, likely: 1, possible: 2 };
  return [...candidates.values()].sort((a, b) =>
    confidenceOrder[a.confidence] - confidenceOrder[b.confidence]
    || a.identityIds[0] - b.identityIds[0]
    || a.identityIds[1] - b.identityIds[1]
  );
}

async function loadAltCandidates(db, serverId) {
  const [accounts, behaviorCandidates, reviews] = await Promise.all([
    db.query(`
      SELECT DISTINCT ON (pi.id)
        pi.id AS identity_id,
        pi.platform,
        pg.gamertag,
        la.user_id AS linked_user_id,
        la.verification_method
      FROM player_identities pi
      JOIN player_server_activity psa
        ON psa.identity_id = pi.id
       AND psa.server_id = ?
      JOIN player_gamertags pg
        ON pg.identity_id = pi.id
       AND pg.server_id = psa.server_id
       AND pg.is_current_gamertag = 1
      JOIN servers s ON s.id = psa.server_id AND s.status = 'active'
      JOIN guilds g ON g.id = s.guild_id AND g.status = 'approved'
      LEFT JOIN server_player_memberships spm
        ON spm.identity_id = pi.id
       AND spm.server_id = ?
       AND spm.status = 'active'
      LEFT JOIN linked_accounts la
        ON la.id = spm.source_link_id
       AND la.identity_id = spm.identity_id
       AND la.user_id = spm.user_id
      ORDER BY pi.id,
        CASE la.verification_method
          WHEN 'emote_challenge' THEN 1
          WHEN 'admin_approved' THEN 2
          ELSE 3
        END
    `, [serverId, serverId]),
    db.query(`
      WITH transitions AS (
        SELECT
          LEAST(ending.identity_id, starting.identity_id) AS identity_id_low,
          GREATEST(ending.identity_id, starting.identity_id) AS identity_id_high,
          EXTRACT(EPOCH FROM (starting.login_at - ending.logout_at)) AS delay_seconds,
          (ending.logout_at AT TIME ZONE 'UTC')::date AS transition_day,
          ending.identity_id::text || '>' || starting.identity_id::text AS direction,
          login_wait.wait_duration_ms AS login_wait_duration_ms
        FROM player_sessions starting
        JOIN servers s ON s.id = starting.server_id AND s.status = 'active'
        JOIN guilds g ON g.id = s.guild_id AND g.status = 'approved'
        JOIN LATERAL (
          SELECT ending.identity_id, ending.logout_at
          FROM player_sessions ending
          WHERE ending.server_id = starting.server_id
            AND ending.logout_at IS NOT NULL
            AND ending.logout_at < starting.login_at
            AND ending.logout_at >= starting.login_at - INTERVAL '5 minutes'
            AND ending.identity_id <> starting.identity_id
          ORDER BY ending.logout_at DESC
          LIMIT 1
        ) ending ON TRUE
        LEFT JOIN LATERAL (
          SELECT login_wait.wait_duration_ms
          FROM rpt_login_wait_events login_wait
          WHERE login_wait.server_id = starting.server_id
            AND login_wait.identity_id = starting.identity_id
            AND login_wait.wait_duration_ms >= ${ENFORCED_RPT_WAIT_MS}
            AND login_wait.queue_entered_at BETWEEN starting.login_at - INTERVAL '5 seconds'
                                                AND starting.login_at + INTERVAL '5 seconds'
          ORDER BY ABS(EXTRACT(EPOCH FROM (login_wait.queue_entered_at - starting.login_at)))
          LIMIT 1
        ) login_wait ON TRUE
        WHERE starting.server_id = ?
          AND starting.login_at >= NOW() - INTERVAL '90 days'
      ), aggregated AS (
        SELECT
          identity_id_low,
          identity_id_high,
          COUNT(*) AS event_count,
          COUNT(*) FILTER (WHERE delay_seconds <= 120) AS strict_count,
          COUNT(DISTINCT transition_day) AS distinct_days,
          COUNT(DISTINCT transition_day) FILTER (WHERE delay_seconds <= 120) AS strict_distinct_days,
          COUNT(DISTINCT direction) AS direction_count,
          COUNT(DISTINCT direction) FILTER (WHERE delay_seconds <= 120) AS strict_direction_count,
          MIN(delay_seconds) AS minimum_delay_seconds,
          COUNT(login_wait_duration_ms) AS enforced_wait_count,
          MIN(login_wait_duration_ms) AS minimum_wait_duration_ms,
          MAX(login_wait_duration_ms) AS maximum_wait_duration_ms
        FROM transitions
        GROUP BY identity_id_low, identity_id_high
        HAVING COUNT(login_wait_duration_ms) >= 1
            OR (
              COUNT(*) FILTER (WHERE delay_seconds <= 120) >= 2
              AND COUNT(DISTINCT direction) FILTER (WHERE delay_seconds <= 120) >= 2
            )
      )
      SELECT aggregated.*
      FROM aggregated
      WHERE (
        aggregated.enforced_wait_count >= 1
        OR NOT EXISTS (
          SELECT 1
          FROM player_sessions older
          JOIN player_sessions newer
            ON newer.server_id = older.server_id
           AND newer.identity_id = aggregated.identity_id_high
           AND newer.logout_at IS NOT NULL
           AND tstzrange(newer.login_at, newer.logout_at, '[)')
               && tstzrange(older.login_at, older.logout_at, '[)')
          WHERE older.server_id = ?
            AND older.identity_id = aggregated.identity_id_low
            AND older.logout_at IS NOT NULL
        )
      )
      AND (
        aggregated.enforced_wait_count >= 1
        OR NOT EXISTS (
          SELECT 1
          FROM player_position_snapshots first_sighting
          JOIN player_position_snapshots second_sighting
            ON second_sighting.server_id = first_sighting.server_id
           AND second_sighting.identity_id = aggregated.identity_id_high
           AND second_sighting.timestamp = first_sighting.timestamp
          WHERE first_sighting.server_id = ?
            AND first_sighting.identity_id = aggregated.identity_id_low
        )
      )
    `, [serverId, serverId, serverId]),
    db.query(`
      SELECT aar.identity_id_low, aar.identity_id_high, aar.status,
             aar.notes, aar.reviewed_at, aar.reviewed_by
      FROM alt_account_reviews aar
      JOIN servers s ON s.id = aar.server_id AND s.status = 'active'
      JOIN guilds g ON g.id = s.guild_id AND g.status = 'approved'
      WHERE aar.server_id = ?
    `, [serverId]),
  ]);

  return buildAltCandidates({ accounts, behaviorCandidates, reviews });
}

module.exports = {
  buildAltCandidates,
  loadAltCandidates,
  normalizeReviewStatus,
};
