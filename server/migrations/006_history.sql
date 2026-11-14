-- xslop admin console v3 (SPEC 14.1): the history of the jobs and of admin changes. Adds tables, a column and
-- indexes only, so the web process of the previous release keeps working while the release switches.

-- Changes of status, identity and standing, written by the score job and the X facts job in the transaction of the change.
create table events (
  id bigserial primary key,
  at timestamptz not null default now(),
  source text not null check (source in ('score', 'facts')),
  kind text not null check (kind in ('status', 'identity', 'standing')),
  -- A handle, or an install id for 'standing'.
  subject text not null,
  data jsonb not null
);
create index events_subject_idx on events (subject, id desc);
create index events_kind_idx on events (kind, id desc);
create index events_at_idx on events (at);

-- Every run of a job that did work or failed.
create table job_runs (
  id bigserial primary key,
  job text not null check (job in ('score', 'profiles')),
  started_at timestamptz not null,
  ended_at timestamptz not null default now(),
  ok boolean not null,
  detail jsonb not null
);
create index job_runs_job_idx on job_runs (job, id desc);
-- The activity feed shows failed runs only.
create index job_runs_failed_idx on job_runs (ended_at) where not ok;

-- The answer of the change; null for login and logout.
alter table admin_log add column after jsonb;

-- The activity feed reads each source newest first, and the account and install pages read their own rows.
create index admin_log_at_idx on admin_log (at);
create index admin_log_target_idx on admin_log (target, at);
create index votes_updated_idx on votes (updated_at);
create index installs_created_idx on installs (created_at);
create index appeals_created_idx on appeals (created_at);
create index appeals_handle_idx on appeals (handle, created_at);

-- No row keeps an ip_hash (SPEC 14.1): the rows that a confirm logged from cleared_votes name their network by its label,
-- the first 8 hex characters of sha256(ip_hash), like every admin answer.
update admin_log set before = jsonb_set(before, '{clearedVotes}', (
    select jsonb_agg(case when e ? 'ip_hash'
                          then (e - 'ip_hash') || jsonb_build_object('network', substr(encode(sha256(convert_to(e->>'ip_hash', 'UTF8')), 'hex'), 1, 8))
                          else e end)
    from jsonb_array_elements(before->'clearedVotes') e))
  where jsonb_path_exists(before, '$.clearedVotes[*].ip_hash');
