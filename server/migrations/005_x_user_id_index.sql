-- The index on the X id that SPEC 13.11 names. The X facts job (CLAIMED_BY, the rename) and the seed
-- import look accounts up by X id; without it each lookup reads the whole accounts table.

create index accounts_x_user_id_idx on accounts (x_user_id) where x_user_id is not null;
