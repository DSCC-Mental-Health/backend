'use strict';

// Two jobs, both deliberately strict:
//
//  buildClaudePayload(stats) — turns the output of insight_stats() into the
//    ONLY data Claude ever sees. It is a whitelist: known aggregate fields
//    are copied, everything else (including any field added to the SQL later)
//    is dropped. Groups with fewer than MIN_GROUP_SIZE observations have their
//    average removed, so a single check-in's mood can't be read back.
//    No journal text, check-in notes, timestamps, record ids or user ids.
//
//  validateCards(raw, allowedHighkeyIds) — checks Claude's output before it
//    is stored or returned. Invalid cards are dropped, not repaired.

const MIN_GROUP_SIZE = 2;
const MAX_CARDS = 4;
const MAX_TITLE = 80;
const MAX_BODY = 280;

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const TIMES_OF_DAY = ['morning', 'afternoon', 'evening', 'night'];
const HIGHKEY_STATUS = ['past', 'today', 'upcoming', 'unscheduled'];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const arr = (v) => (Array.isArray(v) ? v : []);

function num(v) {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}
function count(v) {
  const n = typeof v === 'string' ? Number(v) : v;
  return Number.isInteger(n) && n >= 0 ? n : 0;
}
function avgIfEnough(avg, n) {
  return count(n) >= MIN_GROUP_SIZE ? num(avg) : null;
}
function cleanName(v, max = 80) {
  if (typeof v !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  return s || null;
}
const dateOrNull = (v) => (typeof v === 'string' && ISO_DATE.test(v) ? v : null);

function group(g) {
  const n = count(isObj(g) ? g.n : 0);
  return { avg: avgIfEnough(isObj(g) ? g.avg : null, n), n };
}
function week(w) {
  if (!isObj(w)) return null;
  const checkins = count(w.checkins);
  return { checkins, avg: avgIfEnough(w.avg, checkins), roughDays: count(w.rough_days), steadierDays: count(w.steadier_days) };
}
function bucketList(list, key, allowed) {
  return arr(list)
    .filter((b) => isObj(b) && allowed.includes(b[key]) && count(b.n) >= MIN_GROUP_SIZE)
    .map((b) => ({ [key]: b[key], avg: num(b.avg), n: count(b.n) }));
}

function buildClaudePayload(stats) {
  const s = isObj(stats) ? stats : {};
  const checkins = count(s.checkins);

  const labels = {};
  if (isObj(s.scale) && isObj(s.scale.labels)) {
    for (const score of ['1', '2', '3', '4']) {
      const label = cleanName(s.scale.labels[score], 20);
      if (label) labels[score] = label;
    }
  }

  return {
    scale: { min: 1, max: 4, labels },
    today: dateOrNull(s.today),
    checkins,
    daysLogged: count(s.days_logged),
    overallAvg: avgIfEnough(s.overall_avg, checkins),
    byWeekday: bucketList(s.by_weekday, 'weekday', WEEKDAYS),
    byTimeOfDay: bucketList(s.by_time_of_day, 'time_of_day', TIMES_OF_DAY),
    eveningsByWeekday: bucketList(s.by_weekday_evening, 'weekday', WEEKDAYS),
    thisWeek: week(s.this_week),
    lastWeek: week(s.last_week),
    highkeys: arr(s.highkeys).slice(0, 30)
      .filter((h) => isObj(h) && Number.isInteger(Number(h.highkey_id)) && cleanName(h.name))
      .map((h) => ({
        highkeyId: Number(h.highkey_id),
        name: cleanName(h.name),
        week: Number.isInteger(h.week) ? h.week : null,
        date: dateOrNull(h.date),
        status: HIGHKEY_STATUS.includes(h.status) ? h.status : 'unscheduled',
        before: group(h.before),
        during: group(h.during),
        after: group(h.after),
      })),
    tools: arr(s.tools).slice(0, 10)
      .filter((t) => isObj(t) && cleanName(t.name))
      .map((t) => ({
        name: cleanName(t.name),
        sessions: count(t.sessions),
        avgMoodWithin6hAfter: avgIfEnough(t.avg_mood_within_6h_after, t.n_after),
        nAfter: count(t.n_after),
      })),
  };
}

// --------------------------------------------------------------- output checks
// Heuristic guards on top of the prompt. A card that trips one is dropped.
const CLINICAL = /\b(diagnos\w*|depress\w*|disorder\w*|ptsd|bipolar|psychos\w*|psychotic|suicid\w*|self[- ]?harm\w*|clinical\w*|symptom\w*|mental illness\w*|trauma\w*|medicat\w*)\b/i;
const CAUSAL = /\b(because|caused?|causes|causing|due to|leads? to|led to|results? in|makes? you|made you|the reason)\b/i;
const LINK = /(https?:\/\/|www\.)/i;

function cleanText(v, max) {
  if (typeof v !== 'string') return null;
  const s = v
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  return s && s.length <= max ? s : null;
}

function validateCards(raw, allowedHighkeyIds) {
  const allowed = new Set(allowedHighkeyIds);
  const cards = [];
  for (const item of arr(raw).slice(0, 10)) {
    if (!isObj(item)) continue;
    if (!['pattern', 'event', 'tool'].includes(item.kind)) continue;
    const title = cleanText(item.title, MAX_TITLE);
    const body = cleanText(item.body, MAX_BODY);
    if (!title || !body) continue;
    const text = `${title} ${body}`;
    if (CLINICAL.test(text) || CAUSAL.test(text) || LINK.test(text)) continue;

    let highkeyId = null;
    if (item.kind === 'event') {
      if (!Number.isInteger(item.highkeyId) || !allowed.has(item.highkeyId)) continue;
      highkeyId = item.highkeyId;
    }
    cards.push({ id: `c${cards.length + 1}`, kind: item.kind, title, body, highkeyId });
    if (cards.length === MAX_CARDS) break;
  }
  return cards;
}

module.exports = { buildClaudePayload, validateCards, MIN_GROUP_SIZE, MAX_CARDS };
