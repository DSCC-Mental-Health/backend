'use strict';

const { badRequest, notFound, databaseError } = require('../lib/errors');
const { requireObjectBody } = require('../lib/validate');

const SLUG = /^[a-z0-9-]{1,64}$/;
// Same bounds as the tool_sessions.duration_sec CHECK constraint (003).
const MAX_DURATION_SEC = 7200;

const summary = (t) => ({
  slug: t.slug,
  name: t.name,
  summary: t.summary,
  category: t.category,
  durationSec: t.duration_sec,
});

function createToolsService({ logger }) {
  async function findTool(db, slug) {
    if (typeof slug !== 'string' || !SLUG.test(slug)) throw notFound('TOOL_NOT_FOUND', 'No technique with that name.');
    const { data, error } = await db
      .from('tools')
      .select('id, slug, name, summary, category, steps, cycles, duration_sec')
      .eq('slug', slug)
      .maybeSingle();
    if (error) throw databaseError('load the technique', error, logger);
    if (!data) throw notFound('TOOL_NOT_FOUND', 'No technique with that name.');
    return data;
  }

  return {
    async list(db) {
      const { data, error } = await db
        .from('tools')
        .select('slug, name, summary, category, duration_sec, sort_order')
        .order('sort_order', { ascending: true })
        .order('slug', { ascending: true });
      if (error) throw databaseError('load techniques', error, logger);
      const rows = [...(data || [])].sort((a, b) => a.sort_order - b.sort_order || a.slug.localeCompare(b.slug));
      return { tools: rows.map(summary) };
    },

    async get(db, slug) {
      const tool = await findTool(db, slug);
      return { ...summary(tool), cycles: tool.cycles, steps: Array.isArray(tool.steps) ? tool.steps : [] };
    },

    // body: { "completed": true, "durationSec": 240 }
    // user_id always comes from the verified token, never from the body.
    async logSession(db, userId, slug, body) {
      const input = requireObjectBody(body, ['completed', 'durationSec']);
      if (typeof input.completed !== 'boolean') {
        throw badRequest('INVALID_COMPLETED', 'completed is required and must be true or false.');
      }
      const durationSec = input.durationSec === undefined ? null : input.durationSec;
      if (durationSec !== null &&
          (!Number.isInteger(durationSec) || durationSec < 0 || durationSec > MAX_DURATION_SEC)) {
        throw badRequest('INVALID_DURATION', `durationSec must be a whole number from 0 to ${MAX_DURATION_SEC}, or null.`);
      }

      const tool = await findTool(db, slug);
      const { data, error } = await db
        .from('tool_sessions')
        .insert({ user_id: userId, tool_id: tool.id, completed: input.completed, duration_sec: durationSec })
        .select('id, completed, duration_sec, created_at')
        .single();
      if (error) throw databaseError('save the session', error, logger);

      return {
        id: data.id,
        slug: tool.slug,
        completed: data.completed,
        durationSec: data.duration_sec,
        createdAt: data.created_at,
      };
    },
  };
}

module.exports = { createToolsService, MAX_DURATION_SEC };
