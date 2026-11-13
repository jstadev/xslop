// Writes database.sql.gz: a v1.0.1 database that the v1.0.1 code itself filled, for the migration test.
// It runs that release's migrations, seed import, score job and web server against a throwaway Postgres.
// It reads the release folder and writes only this fixture. Usage: node make-dump.mjs <folder of the v1.0.1 release>

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { Bot, NetworkProxy, Postgres, Server, freePort, hashPassword, hex, run, serverEnv, solveProof } from '../../harness.mjs';

const release = process.argv[2];
if (!release) throw new Error('usage: node make-dump.mjs <folder of the v1.0.1 release>');

const postgres = await Postgres.start();
const port = await freePort();
let server;
const proxies = [];
const proxy = async (ip) => {
  const started = await NetworkProxy.start(port, ip);
  proxies.push(started);
  return started;
};

try {
  const databaseUrl = await postgres.createDatabase('xslop_v101');
  const site = await proxy('100.64.251.10');
  const adminUser = `ops_${hex(4)}`;
  const adminPassword = hex(18);
  const env = serverEnv({ release, databaseUrl, port, siteOrigin: site.origin, powBits: 8, adminUser, adminHash: await hashPassword(release, adminPassword), salt: hex(32), secret: hex(32) });
  const node = (script) => run(process.execPath, [script], { cwd: release, env });
  const job = async () => console.log((await node('server/dist/jobs/score.js')).trim());

  await node('server/dist/scripts/migrate.js');
  await node('server/dist/scripts/import-seed.js');
  await job();
  server = await Server.start(release, env, site.origin);

  const bots = [];
  for (let n = 1; n <= 8; n++) {
    const bot = new Bot(await proxy(n === 5 ? '2001:db8:5::1' : `100.64.${n}.10`));
    if ((await bot.install()) !== 201) throw new Error('install failed');
    bots.push(bot);
  }
  // The v1.0.1 scoring gives little weight to installs younger than a week, so these eight have the age of settled users.
  await postgres.superQuery('xslop_v101', "update xslop.installs set created_at = created_at - interval '14 days'");

  const vote = async (bot, handle, value, id) => {
    const res = await bot.signed('POST', '/api/v1/votes', { handle, value, tweetId: String(id), parentTweetId: String(id + 1), text: `text of ${id} under the v1.0.1 code`, postedAt: new Date(Date.now() - 3_600_000).toISOString(), context: 'reply' });
    if (res.status !== 200) throw new Error(`vote: ${res.status} ${await res.text()}`);
  };

  let tweet = 100_000;
  for (const [handle, count] of [['old_confirmed', 7], ['old_cleared', 7], ['old_rejected', 7], ['old_two_votes', 2]]) {
    for (const bot of bots.slice(0, count)) await vote(bot, handle, 'slop', tweet++);
  }
  await job();
  for (const bot of bots.slice(0, 3)) await vote(bot, 'old_mixed', 'slop', tweet++);
  for (const bot of bots.slice(3, 6)) await vote(bot, 'old_mixed', 'not_slop', tweet++);
  await vote(bots[7], 'old_confirmed', 'slop', tweet++);

  const now = Date.now();
  const items = Array.from({ length: 25 }, (_, i) => ({
    handle: 'old_confirmed', tweetId: String(500_000 + i), parentTweetId: String(600_000 + i), parentHandle: 'someone_else',
    replyAt: new Date(now - 60_000 * (i + 2)).toISOString(), parentAt: new Date(now - 60_000 * (i + 3)).toISOString(),
    textLen: 80 + i, simhash: (0x0123456789abc000n + BigInt(i)).toString(16).padStart(16, '0'), genericScore: 0.75, overlapScore: 0.1, hasMedia: false, verified: i % 2 === 0,
  }));
  const observed = await bots[0].signed('POST', '/api/v1/observations', { items });
  if (observed.status !== 202) throw new Error(`observations: ${observed.status} ${await observed.text()}`);

  const postJson = (path, body, headers = {}) => fetch(`${site.origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: site.origin, ...headers }, body: JSON.stringify(body) });

  async function appeal(handle, message) {
    const { challenge, difficulty } = await (await fetch(`${site.origin}/api/v1/challenge?purpose=appeal`)).json();
    const res = await postJson('/api/v1/appeals', { handle, email: null, message, challenge, nonce: solveProof(challenge, difficulty) });
    if (res.status !== 201) throw new Error(`appeal: ${res.status} ${await res.text()}`);
    return (await res.json()).appealId;
  }

  const accepted = await appeal('old_cleared', 'This account belongs to a person, please remove it.');
  const rejected = await appeal('old_rejected', 'This account also belongs to a person, please check.');
  await appeal('old_confirmed', 'This appeal stays open through the upgrade.');

  const login = await postJson('/api/admin/login', { username: adminUser, password: adminPassword });
  if (login.status !== 200) throw new Error(`login: ${login.status}`);
  const { csrf } = await login.json();
  const cookie = login.headers.getSetCookie()[0].split(';')[0];
  const admin = (path, body) => postJson(path, body, { cookie, 'x-csrf': csrf });
  for (const [id, decision] of [[accepted, 'accept'], [rejected, 'reject']]) {
    const res = await admin(`/api/admin/appeals/${id}/decide`, { decision, note: `decided ${decision} on v1.0.1` });
    if (res.status !== 200) throw new Error(`decide: ${res.status} ${await res.text()}`);
  }
  // v1.0.1 needs a higher bridged score than these eight raters reach, so an admin confirms this account, as an admin can.
  const confirmed = await admin('/api/admin/accounts/old_confirmed', { action: 'confirm' });
  if (confirmed.status !== 200) throw new Error(`confirm: ${confirmed.status} ${await confirmed.text()}`);
  const banned = await admin(`/api/admin/installs/${bots[6].id}/ban`, {});
  if (![200, 204].includes(banned.status)) throw new Error(`ban: ${banned.status} ${await banned.text()}`);
  await job();
  await server.stop();
  server = null;

  const dump = await run('docker', ['exec', postgres.container, 'pg_dump', '-U', 'postgres', '--no-owner', '--no-privileges', '--inserts', '--schema=xslop', 'xslop_v101']);
  const body = dump.split('\n').filter((line) => line && !line.startsWith('--')).join('\n');
  const compressed = gzipSync(`${body}\n`, { level: 9 });
  await writeFile(join(import.meta.dirname, 'database.sql.gz'), compressed);
  console.log(`database.sql.gz: ${compressed.length} bytes`);
} finally {
  await server?.stop();
  await postgres.stop();
  for (const started of proxies) await started.close();
}
