-- =====================================================================
-- DSCC Mental Health App — 002: let commanders key in the BMT timeline
-- Run AFTER 001_bmt_timeline_and_checkins.sql
-- How to run: Supabase dashboard → SQL Editor → New query → paste all → Run
-- =====================================================================
--
-- What this adds:
--   commanders          – list of user accounts allowed to use the commander dashboard
--   company_commanders  – which commander(s) look after which company
--
-- Rules (enforced by the database, not just the app):
--   • Only commanders can create companies and add new highkeys.
--   • Whoever creates a company automatically becomes its commander.
--   • A commander can edit/delete ONLY their own companies and those
--     companies' timelines (company_highkeys).
--   • Recruits can still READ companies + timelines, but can't change them.
--   • Commanders still CANNOT read recruits' private check-ins.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. COMMANDERS — who is allowed on the commander dashboard
--    Add people here from the Supabase dashboard (Table Editor), using
--    their user id from Authentication → Users. The app can't add itself.
-- ---------------------------------------------------------------------
create table public.commanders (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  rank_name   text,                                 -- optional, e.g. '2LT Tan'
  created_at  timestamptz not null default now()
);


-- ---------------------------------------------------------------------
-- 2. COMPANY_COMMANDERS — join table: commander ↔ company they manage
-- ---------------------------------------------------------------------
create table public.company_commanders (
  company_id  bigint not null references public.companies(id)       on delete cascade,
  user_id     uuid   not null references public.commanders(user_id) on delete cascade,
  primary key (company_id, user_id)
);

create index company_commanders_user_idx on public.company_commanders (user_id);


-- Track who created each company (filled in automatically)
alter table public.companies
  add column created_by uuid default auth.uid() references auth.users(id) on delete set null;


-- ---------------------------------------------------------------------
-- 3. HELPER CHECKS used by the security rules below
-- ---------------------------------------------------------------------
create function public.is_commander()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from public.commanders where user_id = auth.uid());
$$;

create function public.is_company_commander(p_company_id bigint)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.company_commanders
    where company_id = p_company_id and user_id = auth.uid()
  );
$$;


-- ---------------------------------------------------------------------
-- 4. AUTO-ASSIGN: the commander who creates a company becomes its commander
-- ---------------------------------------------------------------------
create function public.assign_creator_as_commander()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.created_by is not null
     and exists (select 1 from public.commanders where user_id = new.created_by) then
    insert into public.company_commanders (company_id, user_id)
    values (new.id, new.created_by)
    on conflict do nothing;
  end if;
  return new;
end;
$$;

create trigger companies_assign_creator
  after insert on public.companies
  for each row execute function public.assign_creator_as_commander();


-- ---------------------------------------------------------------------
-- 5. SECURITY RULES (row-level security)
-- ---------------------------------------------------------------------
alter table public.commanders         enable row level security;
alter table public.company_commanders enable row level security;

-- A user can check whether THEY are a commander (so the app knows which screen to show)
create policy "see own commander row" on public.commanders
  for select to authenticated using (user_id = auth.uid());

-- A commander can see which companies they manage
create policy "see own company assignments" on public.company_commanders
  for select to authenticated using (user_id = auth.uid());

-- Companies: commanders create; only that company's commanders edit/delete
create policy "commanders create companies" on public.companies
  for insert to authenticated
  with check (public.is_commander() and created_by = auth.uid());
create policy "company commanders update" on public.companies
  for update to authenticated
  using (public.is_company_commander(id)) with check (public.is_company_commander(id));
create policy "company commanders delete" on public.companies
  for delete to authenticated
  using (public.is_company_commander(id));

-- Highkeys: shared master list — any commander can add a new one
-- (no edit/delete from the app, since other companies may use it)
create policy "commanders add highkeys" on public.highkeys
  for insert to authenticated with check (public.is_commander());

-- Timeline links: only that company's commanders can add/edit/remove
create policy "company commanders add timeline" on public.company_highkeys
  for insert to authenticated with check (public.is_company_commander(company_id));
create policy "company commanders edit timeline" on public.company_highkeys
  for update to authenticated
  using (public.is_company_commander(company_id))
  with check (public.is_company_commander(company_id));
create policy "company commanders remove timeline" on public.company_highkeys
  for delete to authenticated using (public.is_company_commander(company_id));


-- ---------------------------------------------------------------------
-- 6. CLEAN-UP: remove the sample company from 001 (real data comes from the dashboard)
-- ---------------------------------------------------------------------
delete from public.companies where name = 'Sample Company' and batch_number = '00/26';


-- =====================================================================
-- HANDY QUERIES for the commander dashboard (not run automatically)
-- =====================================================================
-- Am I a commander?
--   select exists (select 1 from commanders where user_id = auth.uid());
--
-- Onboarding step 1 — create the company batch (creator auto-assigned):
--   insert into companies (name, batch_number, start_date, end_date)
--   values ('Hotel Company', '03/26', '2026-10-05', '2026-12-07') returning id;
--
-- Onboarding step 2 — add each highkey to that company's timeline:
--   insert into company_highkeys (company_id, highkey_id, week_number, scheduled_date)
--   values (<company id>, <highkey id>, 3, '2026-10-21');
--
-- If a highkey isn't in the list yet:
--   insert into highkeys (name) values ('Night navigation') returning id;
--
-- My companies:
--   select c.* from companies c join company_commanders cc on cc.company_id = c.id
--   where cc.user_id = auth.uid() order by c.start_date desc;
