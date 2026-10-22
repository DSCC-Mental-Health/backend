'use strict';

const { databaseError } = require('../lib/errors');
const { buildClaudePayload, validateCards } = require('./insightCards');
const { InsightGenerationError } = require('./claudeClient');

const MIN_CHECKINS = 5;
const PATTERN_WINDOW_DAYS = 3;
const EMPTY = Object.freeze({ generatedAt: null, cards: [] });

const toIso = (ts) => (ts ? new Date(ts).toISOString() : null);
const num = (v) => (v === null || v === undefined ? null : Number(v));

// GET /insights flow
//  1. Fewer than 5 check-ins → { generatedAt: null, cards: [] }. No Claude call.
//  2. Ask the database for a generation claim (claim_insight_generation).
//     It grants one only if: no other generation is in flight, the last
//     successful generation is older than 24 h (or there is none), the user's
//     data changed since then, and no failure back-off is running.
//     The row lock in that function makes this safe across concurrent requests
//     and multiple server instances.
//  3. No claim → return the cached cards (or empty).
//  4. Claim → compute aggregates AS THE USER (insight_stats, RLS applies),
//     whitelist them, ask Claude, validate the cards, store them with
//     complete_insight_generation.
//  5. Any failure → fail_insight_generation (releases the claim, starts a
//     back-off of 15 min doubling to 6 h) and return the previous cached cards.
//     A crashed request's claim expires after the lease and counts as a failure.
function createInsightsService({ supabase, claude, config, logger, reportError }) {
  async function readCache(db, userId) {
    const { data, error } = await db
      .from('insights').select('cards, generated_at').eq('user_id', userId).maybeSingle();
    if (error) throw databaseError('load your insights', error, logger);
    if (!data) return null;
    return { generatedAt: toIso(data.generated_at), cards: Array.isArray(data.cards) ? data.cards : [] };
  }

  async function countCheckins(db, userId) {
    const { count, error } = await db
      .from('daily_checkins').select('id', { count: 'exact', head: true }).eq('user_id', userId);
    if (error) throw databaseError('count your check-ins', error, logger);
    return count || 0;
  }

  async function releaseAfterFailure(service, userId, claimToken, code) {
    try {
      const { error } = await service.rpc('fail_insight_generation', {
        p_user_id: userId, p_claim_token: claimToken, p_error_code: code,
      });
      if (error) logger.error('insight_fail_release_failed', { pgCode: error.code });
    } catch (err) {
      // The lease will expire on its own and be counted as a failure.
      logger.error('insight_fail_release_failed', { name: err && err.name });
    }
  }

  async function getInsights(db, userId) {
    if ((await countCheckins(db, userId)) < MIN_CHECKINS) return EMPTY;

    const cached = await readCache(db, userId);
    const fallback = cached || EMPTY;

    const service = supabase.getServiceClient();
    if (!claude.enabled || !service) {
      logger.warn('insight_generation_not_configured', {
        claude: claude.enabled, serviceRole: Boolean(service),
      });
      return fallback;
    }

    const { data: claim, error: claimError } = await service.rpc('claim_insight_generation', {
      p_user_id: userId, p_lease_seconds: config.insightsLeaseSeconds,
    });
    if (claimError) {
      logger.error('insight_claim_failed', { pgCode: claimError.code });
      return fallback;
    }
    if (!claim || claim.claimed !== true) return fallback;

    const claimToken = claim.claim_token;
    try {
      const { data: stats, error: statsError } = await db.rpc('insight_stats');
      if (statsError) throw new InsightGenerationError('STATS_FAILED');

      const payload = buildClaudePayload(stats);
      const raw = await claude.generateCards(payload);
      const cards = validateCards(raw, payload.highkeys.map((h) => h.highkeyId));
      if (cards.length === 0) throw new InsightGenerationError('INVALID_OUTPUT');

      const { data: done, error: storeError } = await service.rpc('complete_insight_generation', {
        p_user_id: userId, p_claim_token: claimToken, p_cards: cards, p_model: claude.model,
      });
      if (storeError) throw new InsightGenerationError('STORE_REJECTED');
      if (!done || done.ok !== true) {
        // Our claim expired and someone else took over: show whatever is cached now.
        logger.warn('insight_claim_lost', {});
        return (await readCache(db, userId)) || fallback;
      }
      logger.info('insight_generated', { cards: cards.length });
      return { generatedAt: toIso(done.generated_at), cards };
    } catch (err) {
      const code = err instanceof InsightGenerationError ? err.code : 'UNEXPECTED';
      logger.warn('insight_generation_failed', { code });
      if (!(err instanceof InsightGenerationError) && reportError) {
        try { reportError(err); } catch { /* reporting must never break the response */ }
      }
      await releaseAfterFailure(service, userId, claimToken, code);
      return fallback;
    }
  }

  // GET /insights/patterns — mood before / during / after each company high-key.
  // Uses insight_patterns(3): before = the 3 Singapore calendar days before the
  // scheduled date, during = the scheduled date itself, after = the 3 days after.
  // Averages use moods.score (1–4) and are null when there are no check-ins.
  async function getPatterns(db) {
    const { data, error } = await db.rpc('insight_patterns', { p_window: PATTERN_WINDOW_DAYS });
    if (error) throw databaseError('compute your patterns', error, logger);
    const window = (avg, n) => {
      const samples = Number(n) || 0;
      return { avg: samples > 0 ? num(avg) : null, n: samples };
    };
    return {
      windowDays: PATTERN_WINDOW_DAYS,
      scale: { min: 1, max: 4 },
      highkeys: (data || []).map((r) => ({
        highkeyId: Number(r.highkey_id),
        name: r.name,
        weekNumber: r.week_number ?? null,
        scheduledDate: r.scheduled_date ?? null,
        before: window(r.before_avg, r.before_n),
        during: window(r.during_avg, r.during_n),
        after: window(r.after_avg, r.after_n),
      })),
    };
  }

  return { getInsights, getPatterns };
}

module.exports = { createInsightsService, MIN_CHECKINS, PATTERN_WINDOW_DAYS };
