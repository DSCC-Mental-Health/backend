
create table if not exists public.profiles (
  user_id     uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now()
);

alter table public.profiles
  add column if not exists company_id bigint references public.companies(id) on delete set null,
  add column if not exists support_preference text not null default 'any',
  add column if not exists updated_at timestamptz not null default now();

do $$ begin
  alter table public.profiles
    add constraint profiles_support_preference_check
    check (support_preference in ('anonymous', 'phone', 'any'));
exception when duplicate_object then null; end $$;

create index if not exists profiles_company_idx on public.profiles (company_id);

alter table public.profiles enable row level security;

drop policy if exists "own profile: select" on public.profiles;
drop policy if exists "own profile: insert" on public.profiles;
drop policy if exists "own profile: update" on public.profiles;
create policy "own profile: select" on public.profiles
  for select to authenticated using (user_id = auth.uid());
create policy "own profile: insert" on public.profiles
  for insert to authenticated with check (user_id = auth.uid());
create policy "own profile: update" on public.profiles
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());



create table public.insights (
  user_id       uuid primary key references auth.users(id) on delete cascade,
  cards         jsonb not null default '[]'::jsonb,
  generated_at  timestamptz not null default now(),
  data_through  timestamptz,
  model         text,

  constraint insights_cards_is_array check (jsonb_typeof(cards) = 'array')
);

alter table public.insights enable row level security;

create policy "own insights: select" on public.insights
  for select to authenticated using (user_id = auth.uid());

create policy "own insights: delete" on public.insights
  for delete to authenticated using (user_id = auth.uid());

create table public.tools (
  id            smallint generated always as identity primary key,
  slug          text not null unique check (slug ~ '^[a-z0-9-]+$'),
  name          text not null,
  summary       text not null,
  category      text not null,                    -- section on the Tools screen
  steps         jsonb not null default '[]'::jsonb check (jsonb_typeof(steps) = 'array'),
  cycles        smallint not null default 1 check (cycles between 1 and 50),
  duration_sec  integer not null check (duration_sec between 10 and 3600),
  sort_order    smallint not null default 0
);

alter table public.tools enable row level security;
create policy "read tools" on public.tools for select to authenticated using (true);



create table public.tool_sessions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  tool_id       smallint not null references public.tools(id) on delete restrict,
  completed     boolean not null default true,
  duration_sec  integer check (duration_sec between 0 and 7200),
  created_at    timestamptz not null default now()
);

create index tool_sessions_user_time_idx on public.tool_sessions (user_id, created_at desc);

alter table public.tool_sessions enable row level security;

create policy "own tool sessions: select" on public.tool_sessions
  for select to authenticated using (user_id = auth.uid());
create policy "own tool sessions: insert" on public.tool_sessions
  for insert to authenticated with check (user_id = auth.uid());
create policy "own tool sessions: delete" on public.tool_sessions
  for delete to authenticated using (user_id = auth.uid());



create table public.support_resources (
  id           smallint generated always as identity primary key,
  slug         text not null unique,
  name         text not null,
  description  text not null,
  channel      text not null check (channel in ('in_app', 'phone', 'in_person', 'text')),
  reveals      text not null check (reveals in ('nothing', 'number', 'identity')),
  tags         text[] not null default '{}',
  contact      jsonb not null default '{}'::jsonb,   -- { "phone": "...", "url": "...", "whatsapp": "..." }
  is_urgent    boolean not null default false,
  sort_order   smallint not null default 0,
  active       boolean not null default true
);

alter table public.support_resources enable row level security;
create policy "read support resources" on public.support_resources
  for select to authenticated using (active);


alter table public.companies
  add column if not exists paracounsellor_name    text,
  add column if not exists paracounsellor_details text;  



create table public.app_flags (
  key      text primary key,
  enabled  boolean not null default false,
  note     text
);

alter table public.app_flags enable row level security;
create policy "read flags" on public.app_flags for select to authenticated using (true);

create function public.flag_enabled(p_key text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce((select enabled from public.app_flags where key = p_key), false);
$$;



create table public.handoff_requests (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null default auth.uid() references auth.users(id) on delete cascade,
  company_id      bigint references public.companies(id) on delete set null,
  include_reason  boolean not null default false,
  reason          text check (char_length(reason) <= 1000),
  status          text not null default 'pending' check (status in ('pending', 'acknowledged', 'closed')),
  created_at      timestamptz not null default now(),

  constraint handoff_reason_only_if_opted_in check (reason is null or include_reason)
);

create index handoff_requests_user_idx on public.handoff_requests (user_id, created_at desc);

alter table public.handoff_requests enable row level security;

create policy "own handoffs: select" on public.handoff_requests
  for select to authenticated using (user_id = auth.uid());
create policy "own handoffs: insert (flag on)" on public.handoff_requests
  for insert to authenticated
  with check (user_id = auth.uid() and public.flag_enabled('paracounsellor_handoff'));
create policy "own handoffs: delete" on public.handoff_requests
  for delete to authenticated using (user_id = auth.uid());

create function public.sg_today()
returns date
language sql stable
as $$ select (now() at time zone 'Asia/Singapore')::date; $$;

create function public.my_company_id()
returns bigint
language sql stable security invoker set search_path = public
as $$ select company_id from public.profiles where user_id = auth.uid(); $$;


create function public.insight_patterns(p_window integer default 3)
returns table (
  highkey_id      bigint,
  name            text,
  week_number     smallint,
  scheduled_date  date,
  before_avg      numeric,
  before_n        integer,
  during_avg      numeric,
  during_n        integer,
  after_avg       numeric,
  after_n         integer
)
language sql stable security invoker set search_path = public
as $$
  with mine as (
    select (c.created_at at time zone 'Asia/Singapore')::date as d, m.score
    from public.daily_checkins c
    join public.moods m on m.id = c.mood_id
    where c.user_id = auth.uid()
  )
  select
    h.id, h.name, ch.week_number, ch.scheduled_date,
    round(avg(mine.score) filter (where mine.d between ch.scheduled_date - p_window and ch.scheduled_date - 1), 2),
    (count(*) filter (where mine.d between ch.scheduled_date - p_window and ch.scheduled_date - 1))::int,
    round(avg(mine.score) filter (where mine.d = ch.scheduled_date), 2),
    (count(*) filter (where mine.d = ch.scheduled_date))::int,
    round(avg(mine.score) filter (where mine.d between ch.scheduled_date + 1 and ch.scheduled_date + p_window), 2),
    (count(*) filter (where mine.d between ch.scheduled_date + 1 and ch.scheduled_date + p_window))::int
  from public.company_highkeys ch
  join public.highkeys h on h.id = ch.highkey_id
  left join mine
         on ch.scheduled_date is not null
        and mine.d between ch.scheduled_date - p_window and ch.scheduled_date + p_window
  where ch.company_id = public.my_company_id()
  group by h.id, h.name, ch.week_number, ch.scheduled_date
  order by ch.scheduled_date nulls last, ch.week_number;
$$;



create function public.insight_stats()
returns jsonb
language sql stable security invoker set search_path = public
as $$
  with mine as (
    select
      c.created_at,
      (c.created_at at time zone 'Asia/Singapore')            as local_ts,
      (c.created_at at time zone 'Asia/Singapore')::date      as d,
      m.score,
      m.name as mood
    from public.daily_checkins c
    join public.moods m on m.id = c.mood_id
    where c.user_id = auth.uid()
  ),
  bucketed as (
    select *,
      case
        when extract(hour from local_ts) between 5  and 11 then 'morning'
        when extract(hour from local_ts) between 12 and 17 then 'afternoon'
        when extract(hour from local_ts) between 18 and 23 then 'evening'
        else 'night'
      end as time_of_day,
      trim(to_char(local_ts, 'Day')) as weekday,
      extract(isodow from local_ts)::int as isodow
    from mine
  ),
  day_avg as (
    select d, avg(score) as avg_score from mine group by d
  ),
  weeks as (
    select
      date_trunc('week', public.sg_today())::date as this_mon,
      (date_trunc('week', public.sg_today()) - interval '7 days')::date as last_mon
  ),
  tool_after as (
    -- mood of the first check-in within 6 h after each completed tool session
    select t.slug, t.name, s.id as session_id,
      (select m.score from public.daily_checkins c join public.moods m on m.id = c.mood_id
        where c.user_id = auth.uid()
          and c.created_at > s.created_at
          and c.created_at <= s.created_at + interval '6 hours'
        order by c.created_at limit 1) as score_after
    from public.tool_sessions s
    join public.tools t on t.id = s.tool_id
    where s.user_id = auth.uid() and s.completed
  )
  select jsonb_build_object(
    'scale', jsonb_build_object('min', 1, 'max', 4, 'labels',
              (select jsonb_object_agg(score, name order by score) from public.moods)),
    'today', public.sg_today(),
    'checkins', (select count(*) from mine),
    'days_logged', (select count(distinct d) from mine),
    'first_checkin', (select min(d) from mine),
    'overall_avg', (select round(avg(score), 2) from mine),

    'by_weekday', coalesce((
      select jsonb_agg(jsonb_build_object('weekday', weekday, 'avg', a, 'n', n) order by isodow)
      from (select weekday, isodow, round(avg(score), 2) a, count(*) n
            from bucketed group by weekday, isodow having count(*) >= 2) x), '[]'::jsonb),

    'by_time_of_day', coalesce((
      select jsonb_agg(jsonb_build_object('time_of_day', time_of_day, 'avg', a, 'n', n)
                       order by array_position(array['morning','afternoon','evening','night'], time_of_day))
      from (select time_of_day, round(avg(score), 2) a, count(*) n
            from bucketed group by time_of_day having count(*) >= 2) x), '[]'::jsonb),

    'by_weekday_evening', coalesce((
      select jsonb_agg(jsonb_build_object('weekday', weekday, 'avg', a, 'n', n) order by isodow)
      from (select weekday, isodow, round(avg(score), 2) a, count(*) n
            from bucketed where time_of_day = 'evening'
            group by weekday, isodow having count(*) >= 2) x), '[]'::jsonb),

    'this_week', (
      select jsonb_build_object(
        'checkins', count(*),
        'avg', round(avg(score), 2),
        'rough_days',    (select count(*) from day_avg, weeks where day_avg.d >= weeks.this_mon and avg_score < 2),
        'steadier_days', (select count(*) from day_avg, weeks where day_avg.d >= weeks.this_mon and avg_score >= 3))
      from mine, weeks where mine.d >= weeks.this_mon),

    'last_week', (
      select jsonb_build_object(
        'checkins', count(*),
        'avg', round(avg(score), 2),
        'rough_days',    (select count(*) from day_avg, weeks where day_avg.d >= weeks.last_mon and day_avg.d < weeks.this_mon and avg_score < 2),
        'steadier_days', (select count(*) from day_avg, weeks where day_avg.d >= weeks.last_mon and day_avg.d < weeks.this_mon and avg_score >= 3))
      from mine, weeks where mine.d >= weeks.last_mon and mine.d < weeks.this_mon),

    'highkeys', coalesce((
      select jsonb_agg(jsonb_build_object(
        'highkey_id', p.highkey_id, 'name', p.name, 'week', p.week_number, 'date', p.scheduled_date,
        'status', case when p.scheduled_date is null then 'unscheduled'
                       when p.scheduled_date < public.sg_today() then 'past'
                       when p.scheduled_date = public.sg_today() then 'today'
                       else 'upcoming' end,
        'before', jsonb_build_object('avg', p.before_avg, 'n', p.before_n),
        'during', jsonb_build_object('avg', p.during_avg, 'n', p.during_n),
        'after',  jsonb_build_object('avg', p.after_avg,  'n', p.after_n)))
      from public.insight_patterns(3) p), '[]'::jsonb),

    'tools', coalesce((
      select jsonb_agg(jsonb_build_object(
        'slug', slug, 'name', name, 'sessions', sessions,
        'avg_mood_within_6h_after', avg_after, 'n_after', n_after))
      from (select slug, name, count(*) sessions,
                   round(avg(score_after), 2) avg_after, count(score_after) n_after
            from tool_after group by slug, name) x), '[]'::jsonb)
  );
$$;

-- Newest piece of data that insights depend on (used to decide "is there new data?")
create function public.insight_data_through()
returns timestamptz
language sql stable security invoker set search_path = public
as $$
  select greatest(
    (select max(created_at) from public.daily_checkins where user_id = auth.uid()),
    (select max(created_at) from public.tool_sessions  where user_id = auth.uid())
  );
$$;



insert into public.app_flags (key, enabled, note) values
  ('paracounsellor_handoff', false,
   'Keep OFF until professional sign-off. /support/handoff returns 403 FEATURE_DISABLED while off.');

insert into public.tools (slug, name, summary, category, steps, cycles, duration_sec, sort_order) values
  ('box-breathing', 'Box breathing',
   'In for four, hold four, out for four, hold four. The one instructors teach.',
   'Wound up right now',
   '[{"label":"Breathe in","cue":"In through your nose. Let your shoulders drop.","seconds":4},
     {"label":"Hold","cue":"Stay still. No need to force it.","seconds":4},
     {"label":"Breathe out","cue":"Slowly out through your mouth.","seconds":4},
     {"label":"Hold","cue":"Rest before the next breath.","seconds":4}]'::jsonb,
   11, 180, 1),

  ('longer-exhale', 'Longer exhale breathing',
   'In for four, out for six. Making the out-breath longer is what actually settles the body.',
   'Wound up right now',
   '[{"label":"Breathe in","cue":"In through your nose for four.","seconds":4},
     {"label":"Breathe out","cue":"Out slowly for six, like fogging a mirror.","seconds":6}]'::jsonb,
   12, 120, 2),

  ('grounding-54321', '5-4-3-2-1 grounding',
   'Name five things you can see, four you can feel, three you can hear. Pulls you out of your head and back into the room.',
   'Wound up right now',
   '[{"label":"things you can see","count":5,"cue":"Look around slowly. The light, a locker, a boot, the ceiling. Name them in your head."},
     {"label":"things you can feel","count":4,"cue":"Your boots. The bunk frame. Fabric on your arms. Air on your face. Name them in your head, one at a time."},
     {"label":"things you can hear","count":3,"cue":"Fans, footsteps, someone talking further away."},
     {"label":"things you can smell","count":2,"cue":"Fabric, soap, the air outside. Anything counts."},
     {"label":"thing you can taste","count":1,"cue":"Or one slow breath if nothing comes."}]'::jsonb,
   1, 180, 3),

  ('worry-list', 'Worry list',
   'Write down tomorrow''s worries and one next step for each, so they stop circling once you''re lying down.',
   'Can''t get to sleep',
   '[{"label":"List the worries","cue":"Everything about tomorrow that''s on your mind. Short is fine."},
     {"label":"One next step each","cue":"For each one, the smallest thing you could do about it. \"Ask my section mate\" counts."},
     {"label":"Park it","cue":"It''s written down. You don''t need to hold it in your head tonight."}]'::jsonb,
   1, 360, 4),

  ('body-scan', 'Wind-down body scan',
   'Move your attention slowly from feet to head and let each part go heavy. Works lying in a bunk.',
   'End of a hard day',
   '[{"label":"Feet and legs","cue":"Notice your feet, then calves, then thighs. Let them go heavy.","seconds":60},
     {"label":"Back and shoulders","cue":"Let your back sink into the bunk. Drop your shoulders.","seconds":60},
     {"label":"Arms and hands","cue":"Unclench your hands. Let your arms rest.","seconds":60},
     {"label":"Face and jaw","cue":"Soften your jaw and forehead.","seconds":60},
     {"label":"Whole body","cue":"Notice your whole body at once, breathing.","seconds":60}]'::jsonb,
   1, 300, 5);


insert into public.support_resources (slug, name, description, channel, reveals, tags, contact, is_urgent, sort_order) values
  ('mindline-sg', 'mindline.sg',
   'Opens inside Steady. Anonymous self-help tools and an AI chat. No sign-up, no phone number.',
   'in_app', 'nothing', array['In-app', '24/7', 'Free'],
   '{"url": "https://mindline.sg"}', false, 1),

  ('saf-counselling-hotline', 'SAF Counselling Hotline',
   'Phone. Counsellors who know NS. You choose how much to say about who you are.',
   'phone', 'number', array['Phone', 'NS-specific', '24/7'],
   '{"phone": "1800-278-0022"}', false, 2),

  ('unit-paracounsellor', 'Your unit paraCounsellor',
   'A trained peer inside your unit. Steady shows you who they are and how to approach them — it doesn''t message them for you.',
   'in_person', 'identity', array['In person', 'Free'],
   '{}', false, 3),

  ('national-mindline-1771', 'national mindline 1771',
   'Singapore''s national mental health helpline. Call or WhatsApp, any time.',
   'phone', 'number', array['Phone', 'WhatsApp', '24/7'],
   '{"phone": "1771", "whatsapp": "6669 1771"}', true, 10),

  ('sos-1767', 'Samaritans of Singapore (SOS)',
   'If you''re thinking about suicide or in crisis. Call or text, any time.',
   'phone', 'number', array['Phone', 'WhatsApp', '24/7'],
   '{"phone": "1767", "whatsapp": "9151 1767"}', true, 11),

  ('emergency-995', 'Emergency — ambulance 995',
   'If someone is in immediate danger. Also tell the nearest commander or duty staff.',
   'phone', 'identity', array['Phone', 'Emergency'],
   '{"phone": "995"}', true, 12);
