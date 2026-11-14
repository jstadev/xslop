-- The first time an account is on the list. A later clear does not erase it, so a vote cast while
-- the account was public earns no good mark when an admin confirms it again (SPEC 13.5).

alter table accounts add column first_public_at timestamptz;

update accounts set first_public_at = listed_at where listed_at is not null;

update accounts a set first_public_at = least(a.first_public_at, s.at)
from (
  select subject as handle, min(at) as at from events
  where kind = 'status' and data#>>'{to,status}' in ('flagged', 'confirmed')
  group by subject
) s
where a.handle = s.handle and (a.first_public_at is null or s.at < a.first_public_at);

update accounts a set first_public_at = least(a.first_public_at, s.at)
from (
  select target as handle, min(at) as at from admin_log where action = 'confirm' group by target
) s
where a.handle = s.handle and (a.first_public_at is null or s.at < a.first_public_at);

-- A rename moves the earlier public time onto the new handle. The update touches only
-- first_public_at, so this trigger does not run again. least() keeps a non-null side.
create function xslop_move_first_public() returns trigger language plpgsql as $$
begin
  if new.identity = 'moved' and new.moved_to is not null
     and (old.identity is distinct from new.identity or old.moved_to is distinct from new.moved_to) then
    update accounts
       set first_public_at = least(first_public_at, new.first_public_at)
     where handle = new.moved_to and handle <> new.handle;
  end if;
  return null;
end;
$$;

create trigger xslop_move_first_public
  after update of identity, moved_to on accounts
  for each row execute function xslop_move_first_public();

-- The time a vote first carried standing. The vote route never writes this column, so a value
-- change moves updated_at and leaves this time in place. A delete removes the vote and keeps the
-- time on the network. The row does not name the install: only votes and cleared_votes do.
alter table votes add column standing_at timestamptz;

create table standing_spent (
  id bigint generated always as identity primary key,
  ip_hash text not null,
  handle text not null,
  at timestamptz not null
);
create index standing_spent_ip_at_idx on standing_spent (ip_hash, at);

create function xslop_keep_standing_spent() returns trigger language plpgsql as $$
begin
  if old.standing_at is not null then
    insert into standing_spent (ip_hash, handle, at)
    select i.ip_hash, old.handle, old.standing_at
    from installs i where i.id = old.install_id;
  end if;
  return old;
end;
$$;

create trigger xslop_keep_standing_spent
  before delete on votes
  for each row execute function xslop_keep_standing_spent();
