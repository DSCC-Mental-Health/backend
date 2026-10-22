'use strict';

const { badRequest, forbidden, databaseError } = require('../lib/errors');
const { requireObjectBody } = require('../lib/validate');

// support_resources.reveals → what using the option reveals about you.
const REVEALS_LABEL = {
  nothing: 'Nothing revealed',
  number: 'Shows your number',
  identity: "They'll know it's you",
};

// Filtering rule, by the user's stored profiles.support_preference:
//   anonymous → only options that reveal nothing
//   phone     → options that reveal nothing or your phone number
//   any       → every option (also used when the user has no profile yet)
// Urgent options ("If you need help right now") are ALWAYS returned, in
// `urgent`, whatever the preference.
const ALLOWED_REVEALS = {
  anonymous: ['nothing'],
  phone: ['nothing', 'number'],
  any: ['nothing', 'number', 'identity'],
};
const DEFAULT_PREFERENCE = 'any';
const PARACOUNSELLOR_SLUG = 'unit-paracounsellor';
const HANDOFF_FLAG = 'paracounsellor_handoff';
const MAX_REASON_LENGTH = 1000;

function createSupportService({ logger }) {
  async function paraCounsellorFor(req) {
    if (req.auth.role !== 'recruit') return null;
    const { data, error } = await req.db
      .from('companies')
      .select('paracounsellor_name, paracounsellor_details')
      .eq('id', req.auth.companyId)
      .maybeSingle();
    if (error) throw databaseError('load your paraCounsellor', error, logger);
    if (!data || !data.paracounsellor_name) return null;
    return { name: data.paracounsellor_name, details: data.paracounsellor_details ?? null };
  }

  return {
    async listResources(req) {
      const stored = req.auth.supportPreference;
      const preference = ALLOWED_REVEALS[stored] ? stored : DEFAULT_PREFERENCE;

      const { data, error } = await req.db
        .from('support_resources')
        .select('slug, name, description, channel, reveals, tags, contact, is_urgent, sort_order, active')
        .eq('active', true)
        .order('sort_order', { ascending: true })
        .order('slug', { ascending: true });
      if (error) throw databaseError('load support options', error, logger);

      const rows = (data || []).filter((r) => r.active !== false)
        .sort((a, b) => a.sort_order - b.sort_order || a.slug.localeCompare(b.slug));
      const person = await paraCounsellorFor(req);

      const shape = (r) => ({
        slug: r.slug,
        name: r.name,
        description: r.description,
        channel: r.channel,
        reveals: r.reveals,
        revealsLabel: REVEALS_LABEL[r.reveals] || null,
        tags: r.tags || [],
        contact: r.contact || {},
        ...(r.slug === PARACOUNSELLOR_SLUG ? { person } : {}),
      });

      return {
        supportPreference: preference,
        preferenceSource: ALLOWED_REVEALS[stored] ? 'profile' : 'default',
        resources: rows
          .filter((r) => !r.is_urgent && ALLOWED_REVEALS[preference].includes(r.reveals))
          .map(shape),
        urgent: rows.filter((r) => r.is_urgent).map(shape),
      };
    },

    // paraCounsellor handoff. OFF until professional sign-off: the flag lives
    // in app_flags and is also enforced by the database INSERT policy.
    // The company is set by a database trigger from company_recruits; the
    // reason text is only stored when includeReason is explicitly true.
    // Nothing is sent to anyone outside the database.
    async requestHandoff(req) {
      const { data: enabled, error: flagError } = await req.db.rpc('flag_enabled', { p_key: HANDOFF_FLAG });
      if (flagError) logger.warn('handoff_flag_check_failed', { pgCode: flagError.code });
      if (flagError || enabled !== true) {
        throw forbidden('FEATURE_DISABLED',
          'paraCounsellor handoff is not available yet. You can still see how to reach your paraCounsellor in Support.');
      }

      const input = requireObjectBody(req.body, ['includeReason', 'reason'], { optional: true });
      if (input.includeReason !== undefined && typeof input.includeReason !== 'boolean') {
        throw badRequest('INVALID_INCLUDE_REASON', 'includeReason must be true or false.');
      }
      const includeReason = input.includeReason === true;
      let reason = null;
      if (includeReason) {
        if (typeof input.reason !== 'string' || !input.reason.trim()) {
          throw badRequest('INVALID_REASON', 'reason is required when includeReason is true.');
        }
        // eslint-disable-next-line no-control-regex
        reason = input.reason.trim().replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
        if (reason.length > MAX_REASON_LENGTH) {
          throw badRequest('INVALID_REASON', `reason must be at most ${MAX_REASON_LENGTH} characters.`);
        }
      }
      // If includeReason is not true, any reason text is dropped here and never stored.

      const { data, error } = await req.db
        .from('handoff_requests')
        .insert({ user_id: req.auth.userId, include_reason: includeReason, reason })
        .select('id, status, include_reason, created_at')
        .single();
      if (error) {
        if (error.code === '42501') {
          throw forbidden('FEATURE_DISABLED', 'paraCounsellor handoff is not available yet.');
        }
        throw databaseError('save the handoff request', error, logger);
      }
      return { id: data.id, status: data.status, reasonStored: Boolean(data.include_reason && reason), createdAt: data.created_at };
    },
  };
}

module.exports = { createSupportService, ALLOWED_REVEALS, REVEALS_LABEL, HANDOFF_FLAG };
