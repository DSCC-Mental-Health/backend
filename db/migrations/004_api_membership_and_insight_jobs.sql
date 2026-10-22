-- =====================================================================
-- DSCC Mental Health App — 004: trusted membership + insight generation jobs
-- Run AFTER 001, 002 and 003. Does not edit or drop any existing data.
-- How to run: Supabase dashboard → SQL Editor → New query → paste all → Run
-- =====================================================================
--
-- Why this migration exists (found while building the Express API):
--
--  1. Nothing positively identified a RECRUIT, and a recruit's company came
--     from profiles.company_id, which recruits could set to any company
--     themselves. That value decides which company's high-keys, paraCounsellor
--     and handoff routing a user gets, so it must not be self-editable.
--     → new table company_recruits (written by company commanders or an admin)
--     → recruits can no longer write profiles.company_id
--     → my_company_id() now reads company_recruits
--
--  2. Insight generation (a paid Claude call) needed a database-backed lock so
--     two requests / two server instances can't both generate, plus a record
--     of failures so a broken call isn't retried immediately.
--     → new table insight_state + claim/complete/fail functions
--       (callable ONLY by the backend's service role)
--
--  3. The "regenerate only if data changed" check used the newest created_at,
--     which misses deletes and edits, and ignored high-key schedule changes.
--     → triggers bump insight_state.data_version on any change to a user's
--       check-ins, tool sessions, company membership, or company high-keys
--
--  4. Recruits could delete their cached insights row, which would have reset
--     the once-a-day limit. → that delete policy is removed.
--
--  5. handoff_requests accepted any company_id from the client.
--     → a trigger now sets it from company_recruits and forces safe defaults.
--     The feature flag stays OFF. This migration does not enable it.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. COMPANY_RECRUITS — the trusted "this user is a recruit of company X"
--    One company per recruit. Rows are created by:
--      • an admin in the SQL editor / service role (see README), or
--      • a commander of that company (for a future commander dashboard).
--    Recruits can read their own row but cannot create, move or delete it.
-- ---------------------------------------------------------------------
create table public.company_recruits (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  company_id  bigint not null references public.companies(id) on delete cascade,
  enrolled_by uuid default auth.uid() references auth.users(id) on delete set null,
  enrolled_at timestamptz not null default now()
);

create index company_recruits_company_idx on public.company_recruits (company_id);

alter table public.company_recruits enable row level security;

create policy "recruit sees own enrolment" on public.company_recruits
  for select to authenticated using (user_id = auth.uid());
create policy "company commanders see their recruits" on public.company_recruits
  for select to authenticated using (public.is_company_commander(company_id));
create policy "company commanders enrol recruits" on public.company_recruits
  for insert to authenticated with check (public.is_company_commander(company_id));
create policy "company commanders move recruits" on public.company_recruits
  for update to authenticated
  using (public.is_company_commander(company_id))
  with check (public.is_company_commander(company_id));
create policy "company commanders remove recruits" on public.company_recruits
  for delete to authenticated using (public.is_company_commander(company_id));

-- A commander account can't also be enrolled as a recruit.
create function public.company_recruits_not_commander()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if exists (select 1 from public.commanders where user_id = new.user_id) then
    raise exception 'user % is a commander and cannot be enrolled as a recruit', new.user_id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger company_recruits_not_commander
  before insert or update on public.company_recruits
  for each row execute function public.company_recruits_not_commander();


-- ---------------------------------------------------------------------
-- 2. PROFILES — recruits may only change their support preference.
--    profiles.company_id is kept (no data is dropped) but is no longer used
--    for anything and can no longer be written by app users.
-- ---------------------------------------------------------------------
revoke insert, update on public.profiles from anon, authenticated;
grant insert (support_preference), update (support_preference) on public.profiles to authenticated;

comment on column public.profiles.company_id is
  'DEPRECATED since 004 — self-reported and untrusted. Company membership lives in company_recruits.';

-- The caller's company now comes from the trusted table.
create or replace function public.my_company_id()
returns bigint
language sql stable security invoker set search_path = public
as $$ select company_id from public.company_recruits where user_id = auth.uid(); $$;

-- Everything the API needs to authorise a request, in one round trip.
-- Runs as the caller, so RLS applies (each user only sees their own rows).
create function public.my_membership()
returns jsonb
language sql stable security invoker set search_path = public
as $$
  select jsonb_build_object(
    'is_commander',       exists (select 1 from public.commanders where user_id = auth.uid()),
    'company_id',         (select company_id from public.company_recruits where user_id = auth.uid()),
    'has_profile',        exists (select 1 from public.profiles where user_id = auth.uid()),
    'support_preference', (select support_preference from public.profiles where user_id = auth.uid())
  );
$$;

revoke execute on function public.my_membership() from public, anon;
grant execute on function public.my_membership() to authenticated;


-- ---------------------------------------------------------------------
-- 3. INSIGHTS cache — no client writes or deletes at all
--    (deleting the cache must not reset the once-per-24-hours limit)
-- ---------------------------------------------------------------------
drop policy if exists "own insights: delete" on public.insights;
revoke insert, update, delete on public.insights from anon, authenticated;


-- ---------------------------------------------------------------------
-- 4. INSIGHT_STATE — one row per user: data version + generation lock
--    Clients have no access at all; only the service role touches it,
--    through the three functions below.
-- ---------------------------------------------------------------------
create table public.insight_state (
  user_id             uuid primary key references auth.users(id) on delete cascade,
  data_version        bigint not null default 1,   -- bumped on every relevant data change
  generated_version   bigint,                      -- data_version the cached cards were built from
  last_generated_at   timestamptz,                 -- last SUCCESSFUL generation
  claim_token         uuid,                        -- non-null while a generation is in flight
  claim_data_version  bigint,
  claim_expires_at    timestamptz,
  last_attempt_at     timestamptz,
  failure_count       integer not null default 0,
  next_attempt_at     timestamptz,                 -- back-off after a failure
  last_error_code     text check (char_length(last_error_code) <= 64)
);

alter table public.insight_state enable row level security;   -- and no policies
revoke all on public.insight_state from anon, authenticated;

-- Users who already have cached cards from 003: treat those cards as up to date,
-- so nobody is regenerated just because this migration ran.
insert into public.insight_state (user_id, data_version, generated_version, last_generated_at)
select user_id, 1, 1, generated_at from public.insights
on conflict (user_id) do nothing;


-- Back-off after the n-th consecutive failure: 15 min, 30 min, 1 h, 2 h, 4 h, then 6 h.
create function public.insight_backoff(p_failures integer)
returns interval
language sql immutable
as $$
  select least(interval '6 hours',
               interval '15 minutes' * power(2, least(greatest(p_failures, 1) - 1, 5))::integer);
$$;


-- CLAIM — atomically decide whether THIS request may call Claude.
-- Returns {claimed: true, claim_token} or {claimed: false, reason}.
-- reason: not_enough_data | in_progress | fresh | unchanged | backoff
create function public.claim_insight_generation(p_user_id uuid, p_lease_seconds integer default 90)
returns jsonb
language plpgsql volatile security definer set search_path = public
as $$
declare
  s        public.insight_state%rowtype;
  v_token  uuid;
  v_lease  integer := least(greatest(coalesce(p_lease_seconds, 90), 30), 600);
begin
  if (select count(*) from public.daily_checkins where user_id = p_user_id) < 5 then
    return jsonb_build_object('claimed', false, 'reason', 'not_enough_data');
  end if;

  insert into public.insight_state (user_id) values (p_user_id) on conflict (user_id) do nothing;
  -- Row lock: concurrent claims for the same user queue here, one at a time.
  select * into s from public.insight_state where user_id = p_user_id for update;

  -- A claim whose lease ran out means that attempt died (crash, timeout).
  -- Count it as a failure so a crash loop can't keep making paid calls.
  if s.claim_token is not null and s.claim_expires_at <= now() then
    update public.insight_state
       set claim_token = null, claim_data_version = null, claim_expires_at = null,
           failure_count = failure_count + 1,
           next_attempt_at = s.claim_expires_at + public.insight_backoff(failure_count + 1),
           last_error_code = 'LEASE_EXPIRED'
     where user_id = p_user_id
     returning * into s;
  end if;

  if s.claim_token is not null then
    return jsonb_build_object('claimed', false, 'reason', 'in_progress');
  end if;
  if s.last_generated_at is not null and s.last_generated_at > now() - interval '24 hours' then
    return jsonb_build_object('claimed', false, 'reason', 'fresh');
  end if;
  if s.generated_version is not null and s.generated_version = s.data_version then
    return jsonb_build_object('claimed', false, 'reason', 'unchanged');
  end if;
  if s.next_attempt_at is not null and s.next_attempt_at > now() then
    return jsonb_build_object('claimed', false, 'reason', 'backoff');
  end if;

  v_token := gen_random_uuid();
  update public.insight_state
     set claim_token = v_token,
         claim_data_version = s.data_version,
         claim_expires_at = now() + make_interval(secs => v_lease),
         last_attempt_at = now()
   where user_id = p_user_id;

  return jsonb_build_object('claimed', true, 'claim_token', v_token);
end;
$$;


-- COMPLETE — store validated cards and release the claim.
-- Returns {ok: true, generated_at} or {ok: false, reason: 'claim_lost'}.
-- Raises (and stores nothing) if the cards are malformed.
create function public.complete_insight_generation(
  p_user_id uuid, p_claim_token uuid, p_cards jsonb, p_model text)
returns jsonb
language plpgsql volatile security definer set search_path = public
as $$
declare
  s       public.insight_state%rowtype;
  c       jsonb;
  v_now   timestamptz := now();
  v_ids   bigint[];
begin
  select * into s from public.insight_state where user_id = p_user_id for update;
  if not found or s.claim_token is distinct from p_claim_token then
    return jsonb_build_object('ok', false, 'reason', 'claim_lost');
  end if;

  -- Defence in depth: the API validates too.
  if jsonb_typeof(p_cards) <> 'array'
     or jsonb_array_length(p_cards) not between 1 and 4 then
    raise exception 'cards must be an array of 1-4 items' using errcode = 'check_violation';
  end if;

  select coalesce(array_agg(ch.highkey_id), '{}') into v_ids
    from public.company_highkeys ch
    join public.company_recruits cr on cr.company_id = ch.company_id
   where cr.user_id = p_user_id;

  for c in select value from jsonb_array_elements(p_cards) loop
    if jsonb_typeof(c) <> 'object'
       or jsonb_typeof(c->'id') <> 'string'
       or coalesce(c->>'kind', '') not in ('pattern', 'event', 'tool')
       or jsonb_typeof(c->'title') <> 'string' or char_length(c->>'title') not between 1 and 80
       or jsonb_typeof(c->'body')  <> 'string' or char_length(c->>'body')  not between 1 and 280
       or not (c ? 'highkeyId')
       or (jsonb_typeof(c->'highkeyId') not in ('null', 'number'))
       or (c->>'kind' = 'event' and (jsonb_typeof(c->'highkeyId') <> 'number'
                                     or not ((c->>'highkeyId')::bigint = any (v_ids))))
       or (c->>'kind' <> 'event' and jsonb_typeof(c->'highkeyId') <> 'null')
       or (select count(*) from jsonb_object_keys(c)) <> 5
    then
      raise exception 'malformed insight card' using errcode = 'check_violation';
    end if;
  end loop;

  insert into public.insights (user_id, cards, generated_at, model)
  values (p_user_id, p_cards, v_now, left(p_model, 100))
  on conflict (user_id) do update
     set cards = excluded.cards, generated_at = excluded.generated_at, model = excluded.model;

  update public.insight_state
     set generated_version = s.claim_data_version,
         last_generated_at = v_now,
         claim_token = null, claim_data_version = null, claim_expires_at = null,
         failure_count = 0, next_attempt_at = null, last_error_code = null
   where user_id = p_user_id;

  return jsonb_build_object('ok', true, 'generated_at', v_now);
end;
$$;


-- FAIL — release the claim and start the back-off. Cached cards are untouched.
create function public.fail_insight_generation(
  p_user_id uuid, p_claim_token uuid, p_error_code text)
returns boolean
language plpgsql volatile security definer set search_path = public
as $$
begin
  update public.insight_state
     set claim_token = null, claim_data_version = null, claim_expires_at = null,
         failure_count = failure_count + 1,
         next_attempt_at = now() + public.insight_backoff(failure_count + 1),
         last_error_code = left(coalesce(p_error_code, 'UNKNOWN'), 64)
   where user_id = p_user_id and claim_token = p_claim_token;
  return found;
end;
$$;

-- Only the backend (service role) may run these. Supabase grants EXECUTE on new
-- public functions to anon/authenticated by default, so revoke explicitly.
revoke execute on function public.claim_insight_generation(uuid, integer)        from public, anon, authenticated;
revoke execute on function public.complete_insight_generation(uuid, uuid, jsonb, text) from public, anon, authenticated;
revoke execute on function public.fail_insight_generation(uuid, uuid, text)      from public, anon, authenticated;
grant  execute on function public.claim_insight_generation(uuid, integer)        to service_role;
grant  execute on function public.complete_insight_generation(uuid, uuid, jsonb, text) to service_role;
grant  execute on function public.fail_insight_generation(uuid, uuid, text)      to service_role;


-- ---------------------------------------------------------------------
-- 5. INVALIDATION — bump data_version whenever an input to insights changes
--    (insert, update or delete). UPDATE-only on insight_state: a user with no
--    state row has never been generated, so there is nothing to invalidate,
--    and it keeps account deletion (cascades) from re-creating rows.
-- ---------------------------------------------------------------------
create function public.bump_insight_version_for_user()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    update public.insight_state set data_version = data_version + 1 where user_id = old.user_id;
  end if;
  if tg_op in ('INSERT', 'UPDATE') and (tg_op = 'INSERT' or new.user_id is distinct from old.user_id) then
    update public.insight_state set data_version = data_version + 1 where user_id = new.user_id;
  end if;
  return null;
end;
$$;

create trigger daily_checkins_bump_insights
  after insert or update or delete on public.daily_checkins
  for each row execute function public.bump_insight_version_for_user();
create trigger tool_sessions_bump_insights
  after insert or update or delete on public.tool_sessions
  for each row execute function public.bump_insight_version_for_user();
create trigger company_recruits_bump_insights
  after insert or update or delete on public.company_recruits
  for each row execute function public.bump_insight_version_for_user();

create function public.bump_insight_version_for_company()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  update public.insight_state s
     set data_version = data_version + 1
    from public.company_recruits cr
   where cr.user_id = s.user_id
     and cr.company_id in (
       case when tg_op <> 'INSERT' then old.company_id end,
       case when tg_op <> 'DELETE' then new.company_id end);
  return null;
end;
$$;

create trigger company_highkeys_bump_insights
  after insert or update or delete on public.company_highkeys
  for each row execute function public.bump_insight_version_for_company();

-- High-key renames change card text too.
create function public.bump_insight_version_for_highkey()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  update public.insight_state s
     set data_version = data_version + 1
    from public.company_recruits cr
    join public.company_highkeys ch on ch.company_id = cr.company_id
   where cr.user_id = s.user_id and ch.highkey_id = new.id;
  return null;
end;
$$;

create trigger highkeys_bump_insights
  after update of name on public.highkeys
  for each row execute function public.bump_insight_version_for_highkey();

revoke execute on function public.bump_insight_version_for_user()    from public, anon, authenticated;
revoke execute on function public.bump_insight_version_for_company() from public, anon, authenticated;
revoke execute on function public.bump_insight_version_for_highkey() from public, anon, authenticated;
revoke execute on function public.company_recruits_not_commander()   from public, anon, authenticated;


-- ---------------------------------------------------------------------
-- 6. HANDOFF_REQUESTS — company comes from trusted membership, never the client.
--    Still blocked by the 'paracounsellor_handoff' flag in the INSERT policy (003).
-- ---------------------------------------------------------------------
create function public.handoff_requests_set_trusted_fields()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  select company_id into new.company_id from public.company_recruits where user_id = new.user_id;
  if new.company_id is null then
    raise exception 'only enrolled recruits can request a handoff' using errcode = 'insufficient_privilege';
  end if;
  new.status := 'pending';
  new.created_at := now();
  if not new.include_reason then
    new.reason := null;
  end if;
  return new;
end;
$$;

create trigger handoff_requests_trusted_fields
  before insert on public.handoff_requests
  for each row execute function public.handoff_requests_set_trusted_fields();

revoke execute on function public.handoff_requests_set_trusted_fields() from public, anon, authenticated;


-- =====================================================================
-- PROVISIONING (not run automatically) — enrol a recruit by email:
--   insert into public.company_recruits (user_id, company_id)
--   select id, <company id> from auth.users where email = 'recruit@example.com';
-- Move a recruit:   update public.company_recruits set company_id = <id> where user_id = '<uuid>';
-- Remove:           delete from public.company_recruits where user_id = '<uuid>';
-- =====================================================================
