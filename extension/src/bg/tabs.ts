// Messages from the background to the content scripts on X tabs.
import { ext } from '../shared/ext';
import { X_MATCHES } from '../shared/hosts';
import type { BgMsg } from '../shared/messages';

/** Sends to every X tab and does not wait for the answers: a frozen tab never answers. */
export async function broadcast(msg: BgMsg): Promise<void> {
  const tabs = await ext.tabs.query({ url: X_MATCHES }).catch(() => []);
  for (const t of tabs) if (t.id !== undefined) ext.tabs.sendMessage(t.id, msg).catch(() => null);
}
