-- xslop v1.1: public profile data of listed accounts, filled by the profiles job.

create table profiles (
  handle text primary key references accounts,
  x_id text check (x_id ~ '^[0-9]{1,20}$'),
  name text check (char_length(name) between 1 and 100),
  followers integer check (followers >= 0),
  avatar bytea check (octet_length(avatar) between 1 and 262144),
  avatar_type text check (avatar_type in ('image/jpeg', 'image/png', 'image/webp')),
  gone boolean not null default false,
  -- Runs in a row that got only 404. The source also answers 404 for live accounts, so one run proves nothing.
  misses smallint not null default 0 check (misses >= 0),
  -- The last attempt. A failed attempt on a row with data leaves this time, so the row stays due.
  fetched_at timestamptz not null default now(),
  constraint profiles_avatar_pair check ((avatar is null) = (avatar_type is null))
);
-- The web process reads max(fetched_at) every 15 s to see new profile data.
create index profiles_fetched_at_idx on profiles (fetched_at);

-- The web process reads the count and max(updated_at) of listed accounts every 15 s to see changed list data.
create index accounts_listed_updated_idx on accounts (updated_at) where tier >= 1;
