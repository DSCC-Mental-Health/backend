
create table public.commanders (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  rank_name   text,                                 -- optional, e.g. '2LT Tan'
  created_at  timestamptz not null default now()
);



create table public.company_commanders (
  company_id  bigint not null references public.companies(id)       on delete cascade,
  user_id     uuid   not null references public.commanders(user_id) on delete cascade,
  primary key (company_id, user_id)
);

create index company_commanders_user_idx on public.company_commanders (user_id);


-- Track who created each company (filled in automatically)
alter table public.companies
  add column created_by uuid default auth.uid() references auth.users(id) on delete set null;



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


alter table public.commanders         enable row level security;
alter table public.company_commanders enable row level security;

create policy "see own commander row" on public.commanders
  for select to authenticated using (user_id = auth.uid());

create policy "see own company assignments" on public.company_commanders
  for select to authenticated using (user_id = auth.uid());


create policy "commanders create companies" on public.companies
  for insert to authenticated
  with check (public.is_commander() and created_by = auth.uid());
create policy "company commanders update" on public.companies
  for update to authenticated
  using (public.is_company_commander(id)) with check (public.is_company_commander(id));
create policy "company commanders delete" on public.companies
  for delete to authenticated
  using (public.is_company_commander(id));

create policy "commanders add highkeys" on public.highkeys
  for insert to authenticated with check (public.is_commander());

create policy "company commanders add timeline" on public.company_highkeys
  for insert to authenticated with check (public.is_company_commander(company_id));
create policy "company commanders edit timeline" on public.company_highkeys
  for update to authenticated
  using (public.is_company_commander(company_id))
  with check (public.is_company_commander(company_id));
create policy "company commanders remove timeline" on public.company_highkeys
  for delete to authenticated using (public.is_company_commander(company_id));


delete from public.companies where name = 'Sample Company' and batch_number = '00/26';

