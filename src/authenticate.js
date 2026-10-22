'use strict';

const { ApiError, databaseError } = require('../lib/errors');

// Bearer-token authentication for the API routes.
//
// 1. Verifies the Supabase access token (Authorization: Bearer <token>).
// 2. Creates a request-scoped Supabase client carrying that token, so every
//    query runs as the user and row-level security applies.
// 3. Loads the user's role from TRUSTED tables only (commanders,
//    company_recruits) via my_membership(). Roles in the request body or in
//    user-editable auth metadata are never used.
//
// Sets:
//   req.auth = { userId, role: 'recruit' | 'commander' | 'unassigned',
//                companyId, supportPreference, hasProfile }
//   req.db   = Supabase client acting as this user (for this request only)
//
// The token itself is not stored on req and is never logged.

const BEARER = /^Bearer ([A-Za-z0-9\-_.~+/]+=*)$/;

function roleFrom(membership) {
  if (membership.is_commander) return 'commander';
  if (membership.company_id !== null && membership.company_id !== undefined) return 'recruit';
  return 'unassigned';
}

function createAuthenticate({ supabase, logger }) {
  return async function authenticate(req, res, next) {
    const match = BEARER.exec(req.get('authorization') || '');
    if (!match) {
      throw new ApiError(401, 'UNAUTHENTICATED', 'Missing or invalid Authorization header. Use "Bearer <access_token>".');
    }
    const accessToken = match[1];

    let result;
    try {
      result = await supabase.createAuthClient().auth.getUser(accessToken);
    } catch (err) {
      logger.warn('auth_unavailable', { name: err && err.name });
      throw new ApiError(503, 'AUTH_UNAVAILABLE', 'Could not verify your session. Try again shortly.');
    }

    const { data, error } = result || {};
    if (error) {
      const status = Number(error.status) || 0;
      if (status === 0 || status >= 500) {
        logger.warn('auth_unavailable', { status });
        throw new ApiError(503, 'AUTH_UNAVAILABLE', 'Could not verify your session. Try again shortly.');
      }
      throw new ApiError(401, 'INVALID_TOKEN', 'Invalid or expired token.');
    }
    if (!data || !data.user || !data.user.id) {
      throw new ApiError(401, 'INVALID_TOKEN', 'Invalid or expired token.');
    }

    const db = supabase.createUserClient(accessToken);
    const { data: membership, error: membershipError } = await db.rpc('my_membership');
    if (membershipError || !membership) throw databaseError('load your account', membershipError, logger);

    req.db = db;
    req.auth = Object.freeze({
      userId: data.user.id,
      role: roleFrom(membership),
      companyId: membership.company_id ?? null,
      supportPreference: membership.support_preference ?? null,
      hasProfile: Boolean(membership.has_profile),
    });
    next();
  };
}

module.exports = { createAuthenticate, roleFrom };
