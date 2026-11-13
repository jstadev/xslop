import { createPgDb } from '../db.js';
import { requireDatabaseUrl } from '../env.js';
import { computeScores } from '../scoring/index.js';
import { runScoreJob } from './score-job.js';

// Run by the xslop-score timer every 5 minutes and once per release (section 10).
const db = createPgDb(requireDatabaseUrl(), 2);
try {
  const r = await runScoreJob(db, computeScores);
  console.log(JSON.stringify({ job: 'score', ...r }));
} catch (err) {
  console.error(JSON.stringify({ job: 'score', error: err instanceof Error ? err.message : String(err) }));
  process.exitCode = 1;
} finally {
  await db.close();
}
