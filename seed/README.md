# Seed lists

The starter accounts of xslop come from public lists. Each list is one JSON file in this folder. There are two kinds: a public X list (`x_list`) and a public list on a web site (`site`).

`ai-slop-list.json` is the first one: the 793 members of the public X list "ai slop posters" (https://x.com/i/lists/2116659176894071283), made and kept by its owner on X. Anybody can open that list on X. The `source` block of the file names the list, its owner and the time of the copy (2026-11-07).

## Format

```json
{
  "source": {
    "kind": "x_list",
    "id": "2116659176894071283",
    "name": "ai slop posters",
    "owner": "<handle of the list owner>",
    "url": "https://x.com/i/lists/2116659176894071283",
    "memberCount": 793,
    "fetchedAt": "2026-11-07T16:15:00.795Z"
  },
  "accounts": [
    { "id": "<X user id>", "handle": "<handle as X shows it>", "createdAt": "<ISO time>", "verifiedType": "none", "followers": 0, "following": 0, "posts": 0 }
  ]
}
```

- `source.kind` is `x_list` and `source.id` is the numeric id of the list. The import reads only these two fields of `source`; the others tell a reader where the copy came from.
- Each account has exactly these fields: `id` (the X user id, digits only), `handle` (1 to 15 letters, digits or `_`), `createdAt` (the creation time of the account), `verifiedType`, and the counts `followers`, `following` and `posts` as X showed them at the time of the copy. A file holds no bio, no post text and nothing else.
- A handle or an X id appears once in a file.

## Format of a `site` file

```json
{
  "source": {
    "kind": "site",
    "id": "clankwall.vogel.dev",
    "name": "Clankwall reply flags",
    "url": "https://clankwall.vogel.dev/api/accounts.ndjson",
    "filter": "at least 2 flagged replies, and flagged replies are at least half of the sampled replies",
    "sourceCount": 2811,
    "accountCount": 1430,
    "fetchedAt": "2026-11-13T21:39:29Z"
  },
  "accounts": [
    { "id": "<X user id>", "handle": "<handle as the list shows it>" }
  ]
}
```

- `source.kind` is `site` and `source.id` is the host name of the list, in lower case (labels of a-z, 0-9 and inner `-`, at least one dot, at most 253 characters). The import reads only these two fields of `source`.
- Each account has exactly the keys `id` (digits only) and `handle` (same rules as above). Any other key fails the file. The row has no profile: xslop stores SQL NULL, not the JSON value `null`.
- `clankwall.json` is the copy of the public list of https://clankwall.vogel.dev/ (`accounts.ndjson`, which the site rates by its own checker on replies). It keeps an account only when the account has at least 2 flagged replies and the flagged replies are at least half of the sampled replies. xslop applied this filter when it copied the list: 2,811 accounts were on the list, 1,430 passed, and 1,046 of those are not in `ai-slop-list.json`. The file does not follow the list: it is the copy of its `fetchedAt` time.

## How xslop uses the files

`server/src/scripts/import-seed.ts` runs at each release, after the migrations. It reads every `*.json` file of this folder in name order and checks every file before it writes anything: one bad account stops the import.

- Each account becomes a starter account, with `seed_source` = `<source.kind>:<source.id>` of its file (`x_list:<id>` or `site:<host>`). When two files name the same handle or the same X id, the file that comes first in name order gives the account.
- The X id decides, not the handle. If a handle now belongs to another X id, or another row already holds the X id (the account renamed), the import leaves both rows alone. So the next owner of a handle never becomes a starter account.
- The import is idempotent. It never changes an admin decision (`override`, `cleared_at`), a vote, a stored X id or the identity check of an account.
- A starter account is on the global list from the first day. Votes do not remove it. It leaves the list only after an accepted appeal, an admin decision, or when the X facts job finds that the account moved to another handle (its state then moves with it). An account that the X facts job cannot find stays on the list and is checked again each day.
- The lists on X keep changing. A file does not follow its list: it is the copy of its `fetchedAt` time.

## Add a list

1. Copy the members of a public list into a new file, for example `seed/second-list.json`, in one of the formats above. Keep only the fields above.
2. Run `npm test`. The server tests read every file of this folder and check each account.
3. Release. The import adds the new starter accounts at the next release.

To remove an account that a list names by mistake, clear it in the admin console. Removing it from a file does not remove it from xslop.

The public `/sloppers` page names the list of a starter account in its record. If your account is in one of these files, appeal at https://x-slop.com/check.
