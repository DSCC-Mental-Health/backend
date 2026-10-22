'use strict';

// Reads configuration from environment variables (loaded from .env by dotenv
// in src/app.js). Secrets stay on the server: nothing here is ever sent to
// the frontend.

function intFromEnv(env, name, fallback, min, max) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be a whole number between ${min} and ${max}`);
  }
  return n;
}

function loadConfig(env = process.env) {
  const claudeTimeoutMs = intFromEnv(env, 'CLAUDE_TIMEOUT_MS', 30000, 5000, 120000);
  const leaseSeconds = intFromEnv(env, 'INSIGHTS_CLAIM_LEASE_SECONDS', 90, 30, 600);

  return {
    supabaseUrl: env.SUPABASE_URL || null,
    supabaseAnonKey: env.SUPABASE_ANON_KEY || null,
    // Used ONLY for the insight-generation functions. Never for user reads.
    supabaseServiceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY || null,

    anthropicApiKey: env.ANTHROPIC_API_KEY || null,
    anthropicModel: env.ANTHROPIC_MODEL || 'claude-haiku-5-5',
    claudeTimeoutMs,
    // The lock must outlive the slowest Claude call, or a second request
    // could start a duplicate generation.
    insightsLeaseSeconds: Math.max(leaseSeconds, Math.ceil(claudeTimeoutMs / 1000) + 30),
  };
}

module.exports = { loadConfig };
