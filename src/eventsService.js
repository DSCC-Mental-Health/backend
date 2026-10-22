'use strict';

const { badRequest, forbidden, databaseError } = require('../lib/errors');
const { sgDateString, addDays, daysBetween } = require('../lib/sgDate');

const UPCOMING_DAYS = 14;

// Deterministic order: dated events first by date, then week number,
// then high-key id; undated events last.
function compareEvents(a, b) {
  const byDate = (a.scheduledDate === null) - (b.scheduledDate === null) ||
    (a.scheduledDate || '').localeCompare(b.scheduledDate || '');
  if (byDate) return byDate;
  const byWeek = (a.weekNumber === null) - (b.weekNumber === null) || (a.weekNumber || 0) - (b.weekNumber || 0);
  return byWeek || a.highkeyId - b.highkeyId;
}

function toEvent(row) {
  const hk = Array.isArray(row.highkeys) ? row.highkeys[0] : row.highkeys;
  return {
    highkeyId: Number(row.highkey_id),
    name: hk ? hk.name : null,
    weekNumber: row.week_number ?? null,
    scheduledDate: row.scheduled_date ?? null,
  };
}

function createEventsService({ logger, now }) {
  async function load(db, companyId, range) {
    let query = db
      .from('company_highkeys')
      .select('highkey_id, week_number, scheduled_date, highkeys(name)')
      .eq('company_id', companyId);
    if (range) query = query.gte('scheduled_date', range.from).lt('scheduled_date', range.toExclusive);
    query = query
      .order('scheduled_date', { ascending: true, nullsFirst: false })
      .order('week_number', { ascending: true, nullsFirst: false })
      .order('highkey_id', { ascending: true });
    const { data, error } = await query;
    if (error) throw databaseError('load the BMT schedule', error, logger);
    return (data || []).map(toEvent).sort(compareEvents);
  }

  // Which company's events may this user see?
  //  • recruit    → their enrolled company (any ?companyId is ignored)
  //  • commander  → ?companyId of a company they command; may be omitted if
  //                 they command exactly one
  //  • unassigned → 403 NOT_ENROLLED
  async function resolveCompanyId(req) {
    const { role, companyId } = req.auth;
    if (role === 'recruit') return companyId;
    if (role !== 'commander') {
      throw forbidden('NOT_ENROLLED', "Your account isn't linked to a company yet. Ask your commander to add you.");
    }

    const raw = req.query.companyId;
    if (raw === undefined) {
      const { data, error } = await req.db
        .from('company_commanders').select('company_id').eq('user_id', req.auth.userId);
      if (error) throw databaseError('load your companies', error, logger);
      if (data && data.length === 1) return Number(data[0].company_id);
      throw badRequest('COMPANY_ID_REQUIRED', 'Pass ?companyId= for the company you want to view.');
    }
    if (typeof raw !== 'string' || !/^[1-9][0-9]{0,15}$/.test(raw)) {
      throw badRequest('INVALID_COMPANY_ID', 'companyId must be a positive whole number.');
    }
    const id = Number(raw);
    const { data: allowed, error } = await req.db.rpc('is_company_commander', { p_company_id: id });
    if (error) throw databaseError('check company access', error, logger);
    if (!allowed) throw forbidden('NOT_YOUR_COMPANY', 'You are not a commander of that company.');
    return id;
  }

  return {
    resolveCompanyId,

    async listAll(req) {
      const companyId = await resolveCompanyId(req);
      return { companyId, events: await load(req.db, companyId) };
    },

    // Window, in Singapore calendar dates: from TODAY (inclusive) to
    // TODAY + 14 days (exclusive) — i.e. today plus the next 13 days.
    // Events without a scheduled date are left out.
    async listUpcoming(req) {
      const today = sgDateString(now());
      const toExclusive = addDays(today, UPCOMING_DAYS);
      const events = await load(req.db, req.auth.companyId, { from: today, toExclusive });
      return {
        companyId: req.auth.companyId,
        from: today,
        to: addDays(toExclusive, -1),
        events: events
          .filter((e) => e.scheduledDate && e.scheduledDate >= today && e.scheduledDate < toExclusive)
          .map((e) => ({ ...e, daysAway: daysBetween(today, e.scheduledDate) })),
      };
    },
  };
}

module.exports = { createEventsService, compareEvents, UPCOMING_DAYS };
