// Web Worker: solves the proof of work off the main thread and reports progress.

import { solve } from './lib/pow.ts';

interface WorkerScope {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: unknown): void;
}

const scope = self as unknown as WorkerScope;
let busy = false;

scope.onmessage = async (event) => {
  const data = event.data as { challenge?: unknown; bits?: unknown } | null;
  if (busy || !data || typeof data.challenge !== 'string' || typeof data.bits !== 'number') {
    scope.postMessage({ type: 'error', message: 'bad request' });
    return;
  }
  busy = true;
  try {
    const result = await solve(data.challenge, data.bits, {
      onProgress: (tries) => scope.postMessage({ type: 'progress', tries }),
    });
    scope.postMessage({ type: 'done', nonce: result.nonce, tries: result.tries });
  } catch (err) {
    scope.postMessage({ type: 'error', message: err instanceof Error ? err.message : 'failed' });
  } finally {
    busy = false;
  }
};
