'use strict';

const { createClient } = require('@supabase/supabase-js');

// Builds Supabase clients for the API routes.
//
//  • createAuthClient()      — a fresh anon client used only to verify a token.
//  • createUserClient(token) — a fresh client per request that sends the user's
//                              token, so auth.uid() and row-level security apply.
//  • getServiceClient()      — service-role client, used ONLY for the three
//                              insight-generation functions. Never for user reads.
//
// No client ever stores a session (persistSession: false), so one user's
// session can't leak into another request.

const NO_SESSION = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false };

function createSupabaseFactory(config, createClientImpl = createClient) {
  let serviceClient;

  return {
    createAuthClient() {
      return createClientImpl(config.supabaseUrl, config.supabaseAnonKey, { auth: NO_SESSION });
    },

    createUserClient(accessToken) {
      return createClientImpl(config.supabaseUrl, config.supabaseAnonKey, {
        auth: NO_SESSION,
        global: { headers: { Authorization: `Bearer ${accessToken}` } },
      });
    },

    getServiceClient() {
      if (!config.supabaseServiceRoleKey) return null;
      if (!serviceClient) {
        serviceClient = createClientImpl(config.supabaseUrl, config.supabaseServiceRoleKey, { auth: NO_SESSION });
      }
      return serviceClient;
    },
  };
}

module.exports = { createSupabaseFactory };
