// Handle lookup (GET /api/v1/accounts/:handle) and the appeal flow with proof of work in a Web Worker.

import { ApiError, request } from './lib/api.ts';
import { bindCopy, h, req } from './lib/dom.ts';
import { formatCount, formatDate, formatPercent, formatRelative } from './lib/format.ts';
import { normalizeHandle, postUrl, profileUrl } from './lib/handle.ts';
import { describeError } from './lib/messages.ts';
import { runPow } from './lib/pow-client.ts';
import {
  isAppealCode,
  isUuid,
  parseAccount,
  parseAppealCreated,
  parseAppealState,
  parseChallenge,
  type Account,
  type AccountStatus,
} from './lib/schema.ts';

const STORE_KEY = 'xslop.appeal.v1';
const EMAIL = /^[^\s@]{1,64}@[^\s@.]+(\.[^\s@.]+)+$/;

interface SavedAppeal {
  appealId: string;
  handle: string;
  code: string;
}

const STATUS_LABEL: Record<AccountStatus, string> = {
  confirmed: 'Confirmed',
  flagged: 'Flagged',
  none: 'Not on the list',
};

function statusSummary(acc: Account): string {
  switch (acc.status) {
    case 'confirmed':
      return acc.seed
        ? 'On the shared list since the seed import. xslop hides this account for everyone who keeps the shared list on.'
        : 'On the shared list. xslop hides this account for everyone who keeps the shared list on.';
    case 'flagged':
      return 'Flagged, not confirmed yet. xslop hides it only for people who choose Strict mode.';
    case 'none':
      return 'Not on the list. xslop hides it only for people who marked it themselves.';
  }
}

// A bar from 0 to 1. The number next to it carries the value for screen readers.
function meter(share: number): HTMLElement {
  const fill = h('span');
  fill.style.transform = `scaleX(${share})`;
  return h('span', { class: 'signal-bar', role: 'presentation' }, fill);
}

function setError(input: HTMLInputElement | HTMLTextAreaElement, slot: HTMLElement, message: string): void {
  input.setAttribute('aria-invalid', message ? 'true' : 'false');
  slot.textContent = message;
}

function loadSaved(): SavedAppeal | null {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<SavedAppeal>;
    if (isUuid(v.appealId) && typeof v.handle === 'string' && normalizeHandle(v.handle) === v.handle && isAppealCode(v.code)) {
      return { appealId: v.appealId, handle: v.handle, code: v.code };
    }
  } catch {
    // Unreadable storage: treat as no saved appeal.
  }
  return null;
}

function save(appeal: SavedAppeal | null): void {
  try {
    if (appeal) localStorage.setItem(STORE_KEY, JSON.stringify(appeal));
    else localStorage.removeItem(STORE_KEY);
  } catch {
    // Storage can be off; the appeal still exists on the server.
  }
}

export function initAppeal(): void {
  const lookupForm = req<HTMLFormElement>('#lookup-form');
  const handleInput = req<HTMLInputElement>('#lookup-handle');
  const lookupError = req('#lookup-error');
  const lookupButton = req<HTMLButtonElement>('button[type="submit"]', lookupForm);
  const result = req('#account-result');
  const appealForm = req<HTMLFormElement>('#appeal-form');
  const formTitle = req('#appeal-form-title');
  const message = req<HTMLTextAreaElement>('#appeal-message');
  const messageError = req('#appeal-message-error');
  const count = req('#appeal-count');
  const email = req<HTMLInputElement>('#appeal-email');
  const emailError = req('#appeal-email-error');
  const submit = req<HTMLButtonElement>('#appeal-submit');
  const progress = req('#appeal-progress');
  const done = req('#appeal-done');

  let current: Account | null = null;
  let lookup: AbortController | null = null;
  let sending = false;

  function renderAccount(acc: Account): void {
    const head = h(
      'div',
      { class: 'account-head' },
      h('a', { class: 'account-handle', href: profileUrl(acc.handle), rel: 'noopener noreferrer' }, `@${acc.handle}`),
      h('span', { class: 'status', 'data-status': acc.status }, STATUS_LABEL[acc.status]),
      acc.seed ? h('span', { class: 'status', 'data-status': 'none' }, 'Seed account') : null,
    );
    const parts: Node[] = [head, h('p', { class: 'account-summary' }, statusSummary(acc))];
    // The server sends numbers only for a listed account (13.8). For any other account the page shows none.
    if (acc.status !== 'none') {
      parts.push(
        h(
          'dl',
          { class: 'facts' },
          h('div', null, h('dt', null, 'Score'), h('dd', null, `${Math.round(acc.score)} of 100`, meter(acc.score / 100))),
          h('div', null, h('dt', null, 'Slop votes'), h('dd', null, formatCount(acc.votes.slop))),
          h('div', null, h('dt', null, 'Not slop votes'), h('dd', null, formatCount(acc.votes.notSlop))),
          h('div', null, h('dt', null, 'Replies observed'), h('dd', null, formatCount(acc.sightings))),
        ),
      );
    }

    if (acc.status !== 'none' && acc.signals) {
      const { fastReplyShare, replies } = acc.signals;
      parts.push(h('p', { class: 'sub-title' }, 'Reply timing'));
      parts.push(
        h(
          'div',
          { class: 'signals' },
          h(
            'div',
            { class: 'signal' },
            h('span', null, `Replies within a minute, of ${formatCount(replies)} that the server checked`),
            meter(fastReplyShare),
            h('span', { class: 'signal-value' }, formatPercent(fastReplyShare)),
          ),
        ),
      );
    }

    if (acc.status !== 'none' && acc.evidence.length > 0) {
      parts.push(h('p', { class: 'sub-title' }, 'Newest replies that people marked as slop'));
      parts.push(
        h(
          'ul',
          { class: 'evidence' },
          ...acc.evidence.map((e) => {
            const url = postUrl(e.tweetId);
            return h('li', null, h('span', null, formatDate(e.at)), url ? h('a', { href: url, rel: 'noopener noreferrer' }, 'Open on x.com') : null);
          }),
        ),
      );
    }

    if (acc.appealOpen) {
      parts.push(h('p', { class: 'sub-title' }, `An appeal for @${acc.handle} is open. An admin checks it by hand. If you did not send it, send your own below.`));
    }
    result.replaceChildren(...parts);
    result.hidden = false;

    // An open appeal can come from anybody, so it never hides the form from the owner of the account.
    const canAppeal = acc.status === 'confirmed' || acc.status === 'flagged';
    appealForm.hidden = !canAppeal;
    if (canAppeal) formTitle.textContent = `Appeal for @${acc.handle}`;
    progress.textContent = '';
    progress.classList.remove('is-error');
  }

  lookupForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const handle = normalizeHandle(handleInput.value);
    if (!handle) {
      setError(handleInput, lookupError, 'Type a handle of 1 to 15 letters, digits or underscores.');
      handleInput.focus();
      return;
    }
    setError(handleInput, lookupError, '');
    handleInput.value = handle;
    lookup?.abort();
    const controller = new AbortController();
    lookup = controller;
    lookupButton.setAttribute('aria-busy', 'true');
    try {
      current = parseAccount(await request(`/api/v1/accounts/${handle}`, { signal: controller.signal }));
      renderAccount(current);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'aborted') return;
      current = null;
      result.hidden = true;
      appealForm.hidden = true;
      setError(handleInput, lookupError, describeError(err));
    } finally {
      if (lookup === controller) lookupButton.removeAttribute('aria-busy');
    }
  });

  message.addEventListener('input', () => {
    count.textContent = formatCount(message.value.trim().length);
    if (message.getAttribute('aria-invalid') === 'true') validateMessage();
  });

  function validateMessage(): boolean {
    const n = message.value.trim().length;
    const text = n < 20 ? `Write at least 20 characters (now ${n}).` : n > 2000 ? `Keep it to 2,000 characters (now ${formatCount(n)}).` : '';
    setError(message, messageError, text);
    return text === '';
  }

  function validateEmail(): boolean {
    const v = email.value.trim();
    const text = v && (v.length > 254 || !EMAIL.test(v)) ? 'Type a full email address, or leave the field empty.' : '';
    setError(email, emailError, text);
    return text === '';
  }

  email.addEventListener('blur', validateEmail);

  appealForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (sending || !current) return;
    const okMessage = validateMessage();
    const okEmail = validateEmail();
    if (!okMessage || !okEmail) {
      (okMessage ? email : message).focus();
      return;
    }
    const handle = current.handle;
    sending = true;
    submit.disabled = true;
    submit.setAttribute('aria-busy', 'true');
    progress.classList.remove('is-error');
    progress.textContent = 'Getting a check from the server…';
    try {
      const challenge = parseChallenge(await request('/api/v1/challenge?purpose=appeal'));
      progress.textContent = 'Running a short check in your browser…';
      const nonce = await runPow(challenge.challenge, challenge.difficulty, (tries) => {
        progress.textContent = `Running a short check in your browser: ${formatCount(tries)} tries`;
      });
      progress.textContent = 'Sending the appeal…';
      const created = parseAppealCreated(
        await request('/api/v1/appeals', {
          method: 'POST',
          body: {
            handle,
            email: email.value.trim() || null,
            message: message.value.trim(),
            challenge: challenge.challenge,
            nonce,
          },
          timeoutMs: 15_000,
        }),
      );
      const saved = { appealId: created.appealId, handle, code: created.code };
      save(saved);
      appealForm.hidden = true;
      appealForm.reset();
      count.textContent = '0';
      progress.textContent = '';
      showDone(saved, true);
    } catch (err) {
      progress.classList.add('is-error');
      if (err instanceof ApiError && err.code === 'appeal_open') {
        progress.textContent = `An appeal for @${handle} is already open. An admin checks it by hand.`;
      } else if (err instanceof ApiError) {
        progress.textContent = describeError(err);
      } else {
        progress.textContent = err instanceof Error ? err.message : describeError(err);
      }
    } finally {
      sending = false;
      submit.disabled = false;
      submit.removeAttribute('aria-busy');
    }
  });

  function showDone(appeal: SavedAppeal, focus: boolean): void {
    const title = h('h3', { class: 'h3', tabindex: '-1' }, `Appeal sent for @${appeal.handle}`);
    const copy = h('button', { type: 'button', class: 'btn btn-quiet btn-small' }, 'Copy code');
    bindCopy(copy, () => appeal.code);
    const state = h('p', { class: 'appeal-state', 'aria-live': 'polite' });
    const check = h('button', { type: 'button', class: 'btn btn-quiet btn-small' }, 'Check status');
    const forget = h('button', { type: 'button', class: 'btn-text' }, 'Forget this appeal');
    check.addEventListener('click', () => void refresh(appeal, state, check));
    forget.addEventListener('click', () => {
      save(null);
      done.hidden = true;
      done.replaceChildren();
      handleInput.focus();
    });
    done.replaceChildren(
      title,
      h('div', { class: 'code-row' }, h('span', { class: 'appeal-code', translate: 'no' }, appeal.code), copy),
      h(
        'ol',
        { class: 'done-steps' },
        h('li', null, `Put ${appeal.code} in your X bio, so it shows on your profile.`),
        h('li', null, 'Keep it there until the decision. An admin compares your bio with the code by hand.'),
        h('li', null, 'Come back to this page to check the status. This browser remembers the appeal.'),
      ),
      h('div', { class: 'code-row' }, check, forget),
      state,
    );
    done.hidden = false;
    if (focus) title.focus();
    void refresh(appeal, state, check);
  }

  async function refresh(appeal: SavedAppeal, state: HTMLElement, button: HTMLButtonElement): Promise<void> {
    button.setAttribute('aria-busy', 'true');
    try {
      const s = parseAppealState(await request(`/api/v1/appeals/${appeal.appealId}`));
      state.textContent =
        s.status === 'open'
          ? `Status: open. Sent ${formatRelative(s.createdAt)}.`
          : s.status === 'accepted'
            ? `Status: accepted${s.decidedAt ? ` on ${formatDate(s.decidedAt)}` : ''}. The account is cleared, so you can remove the code from your bio.`
            : `Status: rejected${s.decidedAt ? ` on ${formatDate(s.decidedAt)}` : ''}. The account stays on the list.`;
    } catch (err) {
      state.textContent = err instanceof ApiError && err.status === 404 ? 'The server does not know this appeal any more.' : describeError(err);
    } finally {
      button.removeAttribute('aria-busy');
    }
  }

  const saved = loadSaved();
  if (saved) showDone(saved, false);

  // The Appeal link on /sloppers names the account. Read it once on load.
  const wanted = normalizeHandle(new URLSearchParams(location.search).get('appeal') ?? '');
  if (wanted) {
    handleInput.value = wanted;
    lookupForm.requestSubmit();
  }
}
