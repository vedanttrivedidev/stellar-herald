-- =====================================================================
-- Stellar Herald · subscriber database (Supabase / Postgres)
--
-- HOW TO USE: Supabase dashboard > SQL Editor > New query > paste this
-- whole file > Run. You should see "Success. No rows returned".
-- It is safe to run again: every statement can be repeated.
-- =====================================================================

-- 1) TABLES ------------------------------------------------------------

-- One row per VERIFIED reader. Rows are added by the trigger in section 4,
-- and only after the reader has proven they own the email address.
create table if not exists public.subscribers (
  user_id            uuid primary key references auth.users (id) on delete cascade,
  email              text not null,
  subscribed         boolean not null default true,
  unsubscribe_token  uuid not null default gen_random_uuid(),
  created_at         timestamptz not null default now(),
  unsubscribed_at    timestamptz
);
create unique index if not exists subscribers_email_uniq on public.subscribers (lower(email));
create unique index if not exists subscribers_token_uniq on public.subscribers (unsubscribe_token);

-- The paper itself. Only signed-in readers can read it (section 3).
create table if not exists public.editions (
  edition_date  date primary key,
  data          jsonb not null,
  published_at  timestamptz not null default now()
);

-- One row per (edition, reader). Stops double-sending and records failures.
create table if not exists public.send_log (
  edition_date  date not null,
  user_id       uuid not null references auth.users (id) on delete cascade,
  status        text not null check (status in ('sent', 'failed')),
  attempts      integer not null default 1,
  detail        text,
  sent_at       timestamptz not null default now(),
  primary key (edition_date, user_id)
);

-- 2) LOCK EVERYTHING DOWN ---------------------------------------------
-- Row Level Security: with no matching policy, nobody can touch a table.
alter table public.subscribers enable row level security;
alter table public.editions    enable row level security;
alter table public.send_log    enable row level security;

-- Visitors who are not logged in get nothing at all.
revoke all on public.subscribers from anon, authenticated;
revoke all on public.editions    from anon, authenticated;
revoke all on public.send_log    from anon, authenticated;

-- 3) WHAT SIGNED-IN READERS MAY DO --------------------------------------
grant select on public.subscribers to authenticated;
grant select on public.editions    to authenticated;
-- (The daily job uses the secret key, which has full access.)
grant all on public.subscribers, public.editions, public.send_log to service_role;

drop policy if exists "readers see only their own subscription" on public.subscribers;
create policy "readers see only their own subscription"
  on public.subscribers for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "signed-in readers can read editions" on public.editions;
create policy "signed-in readers can read editions"
  on public.editions for select to authenticated
  using (true);

-- 4) AUTOMATIC SIGN-UP ---------------------------------------------------
-- When an address is VERIFIED (the reader typed the emailed code), add it to
-- the list. Unverified addresses are never added, so nobody can sign up
-- someone else's email and cause spam. The sign-up form passes the
-- "email me the daily edition" checkbox as user metadata "email_updates".
create or replace function public.handle_user_confirmed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  wants boolean;
begin
  if new.email is null or new.email_confirmed_at is null then
    return new;
  end if;
  wants := lower(coalesce(new.raw_user_meta_data ->> 'email_updates', 'true')) <> 'false';
  insert into public.subscribers (user_id, email, subscribed, unsubscribed_at)
  values (new.id, lower(new.email), wants, case when wants then null else now() end)
  on conflict do nothing;
  return new;
exception when others then
  -- Never block a login because of a mailing-list problem.
  raise warning 'handle_user_confirmed failed for %: %', new.id, sqlerrm;
  return new;
end;
$$;

drop trigger if exists on_auth_user_confirmed on auth.users;
create trigger on_auth_user_confirmed
  after insert or update of email_confirmed_at on auth.users
  for each row execute function public.handle_user_confirmed();

-- 5) UNSUBSCRIBE AND SETTINGS --------------------------------------------

-- The one-click link in every email calls this. No login needed, because
-- the token is a long random secret that only that reader's emails contain.
create or replace function public.unsubscribe_by_token(p_token uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
begin
  update public.subscribers
     set subscribed = false,
         unsubscribed_at = coalesce(unsubscribed_at, now())
   where unsubscribe_token = p_token;
  get diagnostics n = row_count;
  return n > 0;
end;
$$;

revoke all on function public.unsubscribe_by_token(uuid) from public, anon, authenticated;
grant execute on function public.unsubscribe_by_token(uuid) to anon, authenticated, service_role;

-- The Settings toggle (signed-in readers only). Also repairs a missing row.
create or replace function public.set_my_email_updates(p_on boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.subscribers (user_id, email, subscribed, unsubscribed_at)
  select u.id, lower(u.email), p_on, case when p_on then null else now() end
    from auth.users u
   where u.id = (select auth.uid())
     and u.email is not null
     and u.email_confirmed_at is not null
  on conflict (user_id) do update
     set subscribed = excluded.subscribed,
         unsubscribed_at = excluded.unsubscribed_at;
end;
$$;

revoke all on function public.set_my_email_updates(boolean) from public, anon, authenticated;
grant execute on function public.set_my_email_updates(boolean) to authenticated, service_role;

-- =====================================================================
-- ROLLBACK (only if you want to remove everything; this deletes the list):
--   drop trigger if exists on_auth_user_confirmed on auth.users;
--   drop function if exists public.handle_user_confirmed();
--   drop function if exists public.unsubscribe_by_token(uuid);
--   drop function if exists public.set_my_email_updates(boolean);
--   drop table if exists public.send_log, public.subscribers, public.editions;
-- =====================================================================
