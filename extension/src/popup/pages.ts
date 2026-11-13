// Helpers for the extension pages (popup, onboarding).
import { API_BASE, DATA_COLLECTION, IS_FIREFOX, ext, perms } from '../shared/ext';
import { X_MATCHES } from '../shared/hosts';
import type { PageMsg } from '../shared/messages';
import type { Settings } from '../shared/types';

/** Every host that xslop needs: X for the button and the API for the votes (the API sends no CORS headers). */
const HOST_ACCESS = { origins: [...X_MATCHES, `${API_BASE}/*`] };

export const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} is missing`);
  return el as T;
};

export const sendPage = (msg: PageMsg): Promise<unknown> => ext.runtime.sendMessage(msg);
export const setSettings = (patch: Partial<Settings>): Promise<unknown> => sendPage({ t: 'settings', patch });

/**
 * Firefox 140+ asks you for optional data collection. Call this first thing in the click handler
 * (a user gesture). Browsers without that permission resolve true. A refusal or an error means no
 * consent; turning sharing off always succeeds.
 */
export async function askDataCollection(on: boolean): Promise<boolean> {
  if (!IS_FIREFOX) return true;
  try {
    if (on) return (await perms().request(DATA_COLLECTION)) === true;
    await perms().remove(DATA_COLLECTION);
  } catch {
    return !on;
  }
  return true;
}

/**
 * Firefox and Safari can run xslop without host access: you can decline it or take it back later.
 * Shows `box` with a real grant button until access is on. A browser that cannot ask shows `help`.
 */
export async function hostAccess(box: HTMLElement, button: HTMLButtonElement, help: HTMLElement): Promise<void> {
  const refresh = async (): Promise<void> => {
    box.hidden = await ext.permissions.contains(HOST_ACCESS).catch(() => true);
  };
  button.onclick = () => {
    // First thing in the click: the browser only asks during a user gesture.
    ext.permissions.request(HOST_ACCESS).then(
      (granted) => {
        box.hidden = granted;
        help.hidden = granted;
      },
      () => {
        help.hidden = false;
      },
    );
  };
  ext.permissions.onAdded?.addListener(() => void refresh());
  ext.permissions.onRemoved?.addListener(() => void refresh());
  await refresh();
}

/** Bind a switch to a setting. The share switch also asks for data collection on Firefox. */
export function bindSwitch(input: HTMLInputElement, key: 'share' | 'mute' | 'muteOnMark'): void {
  input.addEventListener('change', () => {
    const on = input.checked;
    const asked = key === 'share' ? askDataCollection(on) : Promise.resolve(true);
    void asked.then((ok) => {
      if (!ok) {
        input.checked = false;
        return;
      }
      void setSettings({ [key]: on });
    });
  });
}
