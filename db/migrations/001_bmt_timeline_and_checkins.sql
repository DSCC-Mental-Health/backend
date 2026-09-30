

create table public.companies (
  id            bigint generated always as identity primary key,
  name          text not null,                
  batch_number  text not null,                 -- e.g. '03/26' (text so formats like 03/26 work)
  start_date    date not null,                 -- enlistment / batch start
  end_date      date not null,                 -- POP / batch end
  created_at    timestamptz not null default now(),

  constraint companies_dates_valid check (end_date >= start_date),
  constraint companies_name_batch_unique unique (name, batch_number)
);



create table public.highkeys (
  id    bigint generated always as identity primary key,
  name  text not null unique
);



create table public.company_highkeys (
  company_id      bigint not null references public.companies(id) on delete cascade,
  highkey_id      bigint not null references public.highkeys(id)  on delete restrict,
  week_number     smallint check (week_number between 1 and 20),
  scheduled_date  date,

  primary key (company_id, highkey_id)
);

create index company_highkeys_highkey_idx on public.company_highkeys (highkey_id);


create table public.moods (
  id     smallint primary key,
  name   text not null unique,
  score  smallint not null unique check (score between 1 and 10),
  color  text                                 
);



create table public.daily_checkins (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid()
                references auth.users(id) on delete cascade,
  mood_id     smallint not null references public.moods(id),
  note        text check (char_length(note) <= 2000),   
  created_at  timestamptz not null default now()       
);

create index daily_checkins_user_time_idx on public.daily_checkins (user_id, created_at desc);


alter table public.companies        enable row level security;
alter table public.highkeys         enable row level security;
alter table public.company_highkeys enable row level security;
alter table public.moods            enable row level security;
alter table public.daily_checkins   enable row level security;

create policy "read companies"        on public.companies        for select to authenticated using (true);
create policy "read highkeys"         on public.highkeys         for select to authenticated using (true);
create policy "read company_highkeys" on public.company_highkeys for select to authenticated using (true);
create policy "read moods"            on public.moods            for select to authenticated using (true);

create policy "own checkins: select" on public.daily_checkins
  for select to authenticated using (user_id = auth.uid());
create policy "own checkins: insert" on public.daily_checkins
  for insert to authenticated with check (user_id = auth.uid());
create policy "own checkins: update" on public.daily_checkins
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own checkins: delete" on public.daily_checkins
  for delete to authenticated using (user_id = auth.uid());




insert into public.moods (id, name, score, color) values
  (1, 'Rough', 1, '#D9652B'),
  (2, 'Mixed', 2, '#F0B232'),
  (3, 'Okay',  3, '#8FA89B'),
  (4, 'Good',  4, '#3F7F74');

insert into public.highkeys (name) values
  ('Confinement'),
  ('First 4 km route march'),
  ('SOC'),
  ('Live firing'),
  ('Field camp'),
  ('8 km route march'),
  ('12 km route march'),
  ('16 km route march'),
  ('IPPT'),
  ('24 km route march'),
  ('POP');

insert into public.companies (name, batch_number, start_date, end_date)
values ('Sample Company', '00/26', '2026-09-01', '2026-11-02');

insert into public.company_highkeys (company_id, highkey_id, week_number, scheduled_date)
select c.id, h.id, v.week, v.day::date
from public.companies c
join (values
  ('Confinement',            1, '2026-09-01'),
  ('First 4 km route march', 2, '2026-09-10'),
  ('SOC',                    3, '2026-09-16'),
  ('Live firing',            4, '2026-09-23'),
  ('Field camp',             5, '2026-09-28'),
  ('16 km route march',      7, '2026-10-14'),
  ('POP',                    9, '2026-11-01')
) as v(highkey, week, day) on true
join public.highkeys h on h.name = v.highkey
where c.name = 'Sample Company' and c.batch_number = '00/26';


