// Runs the proof of work in a dedicated worker so typing and scrolling stay smooth.

const TIMEOUT_MS = 180_000;

export function runPow(challenge: string, bits: number, onProgress: (tries: number) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('../pow.worker.ts', import.meta.url), { type: 'module', name: 'xslop-pow' });
    } catch {
      reject(new Error('This browser cannot run the check in the background.'));
      return;
    }
    const timer = window.setTimeout(() => finish(new Error('The check took too long. Try again.')), TIMEOUT_MS);
    function finish(error: Error | null, nonce?: string): void {
      window.clearTimeout(timer);
      worker.terminate();
      if (error) reject(error);
      else resolve(nonce ?? '');
    }
    worker.onmessage = (event: MessageEvent<unknown>) => {
      const msg = event.data as { type?: unknown; tries?: unknown; nonce?: unknown } | null;
      if (!msg) return;
      if (msg.type === 'progress' && typeof msg.tries === 'number') onProgress(msg.tries);
      else if (msg.type === 'done' && typeof msg.nonce === 'string' && msg.nonce.length <= 32) finish(null, msg.nonce);
      else if (msg.type === 'error') finish(new Error('The check failed. Try again.'));
    };
    worker.onerror = () => finish(new Error('The check failed. Try again.'));
    worker.postMessage({ challenge, bits });
  });
}
