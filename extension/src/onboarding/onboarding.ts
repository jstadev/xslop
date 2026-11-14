// Onboarding tab (SPEC 12.7): three short steps. What a click does, the opt-ins, and what xslop sends.
import { muteOf } from '../shared/config';
import { ext } from '../shared/ext';
import { readStored } from '../shared/storage';
import { $, bindSwitch, hostAccess } from '../popup/pages';

const LAST_STEP = 3;
let step = 1;

function showStep(next: number): void {
  step = next;
  for (const section of document.querySelectorAll<HTMLElement>('.step')) section.hidden = section.id !== `step-${step}`;
  $('step-now').textContent = String(step);
  for (const [i, bar] of document.querySelectorAll('.progress span').entries()) bar.classList.toggle('on', i < step);
  // A screen reader hears the new step, and a keyboard continues from it.
  document.querySelector<HTMLElement>(`#step-${step} h1`)?.focus();
}

async function sync(): Promise<void> {
  const { settings, config } = await readStored(['settings', 'config']);
  $<HTMLInputElement>('mute-mark').checked = settings.muteOnMark;
  $<HTMLInputElement>('share').checked = settings.share;
  $<HTMLInputElement>('mute').checked = settings.mute;
  $('mute-max').textContent = String(muteOf(config).maxPerDay);
}

bindSwitch($<HTMLInputElement>('mute-mark'), 'muteOnMark');
bindSwitch($<HTMLInputElement>('share'), 'share');
bindSwitch($<HTMLInputElement>('mute'), 'mute');
for (const b of document.querySelectorAll<HTMLButtonElement>('button.next')) b.onclick = () => showStep(Math.min(step + 1, LAST_STEP));
for (const b of document.querySelectorAll<HTMLButtonElement>('button.back')) b.onclick = () => showStep(Math.max(step - 1, 1));
$('done').onclick = () => {
  void ext.tabs.update({ url: 'https://x.com/home' });
};
ext.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.settings || changes.config)) void sync();
});
void sync();
void hostAccess($('access'), $<HTMLButtonElement>('access-grant'), $('access-help'));
