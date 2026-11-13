// Small helpers shared by the drivers and the scenario.
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Calls `read` until it returns a truthy value. Throws with `what` when the time runs out. */
export async function poll(read, { what = 'condition', ms = 30_000, every = 150 } = {}) {
  const end = Date.now() + ms;
  let last;
  for (;;) {
    try {
      last = await read();
    } catch (e) {
      last = e;
      if (Date.now() >= end) throw new Error(`${what}: ${e.message ?? e}`);
      await sleep(every);
      continue;
    }
    if (last && !(last instanceof Error)) return last;
    if (Date.now() >= end) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await sleep(every);
  }
}

/** Returns `step(name, fn)`: runs `fn`, records pass or fail in `results`, and never throws. The value of `fn` is the evidence. */
export const stepper = (results) => async (name, fn) => {
  try {
    results.push({ name, pass: true, evidence: (await fn()) ?? '' });
  } catch (e) {
    results.push({ name, pass: false, evidence: e.message ?? String(e) });
  }
};
