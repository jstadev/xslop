-- xslop judging system v2 (SPEC 13.7). Adds columns and tables only, so the web process of the
-- previous release keeps working while the release switches.

alter table installs
  add column trusted boolean not null default false,
  add column standing boolean not null default false,
  add column good_marks integer not null default 0 check (good_marks >= 0);

alter table accounts
  drop constraint accounts_status_check,
  add constraint accounts_status_check check (status in ('none', 'pending', 'flagged', 'confirmed', 'cleared')),
  add column override_at timestamptz,
  add column clear_penalty boolean not null default true,
  add column confirmed_at timestamptz,
  add column identity text not null default 'unknown' check (identity in ('unknown', 'ok', 'gone', 'moved')),
  add column identity_at timestamptz,
  add column moved_to text check (moved_to ~ '^[a-z0-9_]{1,15}$'),
  add column protected boolean not null default false,
  -- The list publishes this id and mute sync mutes by it (SPEC 13.8).
  add constraint accounts_x_user_id_check check (x_user_id ~ '^[0-9]{1,20}$');

-- The old metric columns stay; nothing writes them. The score job reads only verified sightings.
alter table sightings add column verified_at timestamptz;
-- The score job reads the newest 50 verified sightings of each account in this order.
create index sightings_verified_idx on sightings (handle, reply_at desc, tweet_id desc) where verified_at is not null;

create table evidence (
  tweet_id text primary key check (tweet_id ~ '^[0-9]{1,20}$'),
  handle text not null references accounts,
  x_user_id text check (x_user_id ~ '^[0-9]{1,20}$'),
  ok boolean not null,
  checked_at timestamptz not null default now()
);
create index evidence_handle_idx on evidence (handle);

-- The votes of an account at the time of an admin clear. Strikes and the reputation of a clear read
-- these rows, so a vote that is deleted or changed later changes nothing. No reference to installs:
-- the network keeps its strike after the install is gone.
create table cleared_votes (
  handle text not null references accounts,
  install_id uuid not null,
  ip_hash text not null,
  value smallint not null check (value in (0, 1)),
  at timestamptz not null,
  cleared_at timestamptz not null,
  -- The standing of the install at the time of the clear: a strike needs it (SPEC 13.10 item 5).
  standing boolean not null default false,
  primary key (handle, install_id)
);

create table admin_log (
  id bigserial primary key,
  at timestamptz not null default now(),
  session text not null,
  action text not null,
  target text not null,
  before jsonb
);

alter table admin_sessions add column seen_at timestamptz not null default now();

-- Existing admin decisions get their time: a clear at its cleared_at, a confirm at the start of its
-- listing (the earliest time it can have, so no vote set after it is scored against it).
update accounts set override_at = coalesce(case override when 'clear' then cleared_at else listed_at end, updated_at)
  where override is not null;
-- A starter account is cleared without a penalty.
update accounts set clear_penalty = false where seed;
-- Existing clears keep the strikes that v1 gave them: the votes set before the clear, as they are now.
insert into cleared_votes (handle, install_id, ip_hash, value, at, cleared_at)
  select v.handle, v.install_id, i.ip_hash, v.value, v.updated_at, a.cleared_at
  from accounts a
  join votes v on v.handle = a.handle and v.updated_at < a.cleared_at
  join installs i on i.id = v.install_id
  where a.cleared_at is not null and not a.seed and a.override is distinct from 'confirm';
-- An account confirmed by votes keeps the time of its listing for the daily brake and the review queue.
update accounts set confirmed_at = coalesce(listed_at, updated_at)
  where status = 'confirmed' and override is null and not seed;
