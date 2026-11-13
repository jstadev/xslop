-- xslop v1 schema. Unqualified names: the role's search_path selects the schema.

create table installs (
  id uuid primary key,
  public_key jsonb not null,
  created_at timestamptz not null default now(),
  ip_hash text not null,
  reputation real not null default 0.5,
  banned_at timestamptz,
  last_seen_at timestamptz,
  ext_version text
);
create index installs_ip_hash_idx on installs (ip_hash);

create table accounts (
  handle text primary key check (handle ~ '^[a-z0-9_]{1,15}$'),
  x_user_id text,
  display_handle text,
  first_seen_at timestamptz not null default now(),
  status text not null default 'none' check (status in ('none', 'flagged', 'confirmed', 'cleared')),
  score real not null default 0,
  tier smallint not null default 0 check (tier in (0, 1, 2)),
  seed boolean not null default false,
  seed_source text,
  profile jsonb,
  cleared_at timestamptz,
  override text check (override in ('confirm', 'clear')),
  parts jsonb,
  updated_at timestamptz not null default now()
);
create index accounts_status_score_idx on accounts (status, score desc);

create table votes (
  install_id uuid not null references installs on delete cascade,
  handle text not null references accounts,
  value smallint not null check (value in (0, 1)),
  tweet_id text,
  parent_tweet_id text,
  text text,
  posted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (install_id, handle)
);
create index votes_handle_idx on votes (handle, updated_at desc);

-- No install id here, by design (privacy).
create table sightings (
  tweet_id text primary key,
  handle text not null,
  parent_tweet_id text,
  parent_handle text,
  reply_at timestamptz not null,
  parent_at timestamptz,
  latency_sec integer,
  text_len integer,
  simhash text check (simhash ~ '^[0-9a-f]{16}$'),
  generic_score real,
  overlap_score real,
  has_media boolean,
  verified boolean,
  created_at timestamptz not null default now()
);
create index sightings_handle_reply_at_idx on sightings (handle, reply_at desc);
create index sightings_reply_at_idx on sightings (reply_at);

create table list_snapshots (
  version bigserial primary key,
  generated_at timestamptz not null default now(),
  count integer not null,
  body_gzip bytea not null,
  body_br bytea not null,
  delta jsonb,
  etag text not null
);

create table appeals (
  id uuid primary key,
  handle text not null references accounts,
  email text,
  message text not null,
  code text not null,
  status text not null default 'open' check (status in ('open', 'accepted', 'rejected')),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  note text,
  ip_hash text not null
);
create unique index appeals_one_open_idx on appeals (handle) where status = 'open';
create index appeals_status_created_idx on appeals (status, created_at desc);

create table admin_sessions (
  token_hash text primary key,
  csrf text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  ip_hash text not null
);

create table used_challenges (
  challenge_hash text primary key,
  expires_at timestamptz not null
);

create table jobs (
  name text primary key,
  last_run_at timestamptz,
  last_ok_at timestamptz,
  detail jsonb
);
