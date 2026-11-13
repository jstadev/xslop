-- xslop v1 hardening: reputation farming, install budget, appeal blocking, sighting batch linkage.

-- Start of the current listing. A vote whose value was set at or after it earns no reputation.
-- The score job sets it when an account reaches tier 1 or 2 and clears it at tier 0.
alter table accounts add column listed_at timestamptz;
update accounts set listed_at = now() where tier >= 1;

-- The 30-day install budget per network counts with this index. It also serves ip_hash lookups.
create index installs_ip_hash_created_idx on installs (ip_hash, created_at);
drop index installs_ip_hash_idx;

-- One open appeal per handle and network. The route allows at most 5 open appeals per handle,
-- so one network cannot block the real owner.
drop index appeals_one_open_idx;
create unique index appeals_open_network_idx on appeals (handle, ip_hash) where status = 'open';

-- Sightings keep the hour only, so the rows of one batch do not share an exact time.
alter table sightings alter column created_at set default date_trunc('hour', now());
update sightings set created_at = date_trunc('hour', created_at);
