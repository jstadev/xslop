// #appeals/open|accepted|rejected (SPEC 5.6, 13.8): the owners' messages with the bio code, what an accept strikes, and the
// three decisions.

import { h } from '../../lib/dom.ts';
import { marksSentence } from '../explain.ts';
import { listFrom, num, obj, str, type Row } from '../rows.ts';
import { APPEAL_STATES, type AppealState, UUID_RE } from '../route.ts';
import { api, overview } from '../session.ts';
import { accountLink, guarded, note, pill, say, table, time } from '../ui.ts';
import { head, tabs, type Ctx } from '../view.ts';

const NOTE: Record<AppealState, string> = {
  open: 'Each owner put the code in the X bio. Open the profile, check the code, then decide. Accept clears the account and publishes the list at once; with penalty, its slop voters lose standing and their networks can get strikes.',
  accepted: 'Appeals that you accepted. Their accounts are cleared.',
  rejected: 'Appeals that you rejected. Their accounts stayed as they were.',
};

function decision(r: Row, after: () => Promise<void>): Node | string {
  const id = str(r, 'appealId', 'id');
  if (!UUID_RE.test(id)) return 'This appeal has no valid id.';
  const handle = str(r, 'handle');
  const field = h('input', { type: 'text', maxlength: 500, 'aria-label': `Note for @${handle}`, placeholder: 'note (optional)…' });
  const decide = (decision: 'accept' | 'reject', penalty?: boolean) => async () => {
    const body = { decision, note: field.value.trim(), ...(penalty === undefined ? {} : { penalty }) };
    await api(`/api/admin/appeals/${id}/decide`, { method: 'POST', body });
    say(decision === 'accept' ? `Appeal for @${handle} accepted ${penalty ? 'with' : 'without'} a penalty. The account is cleared.` : `Appeal for @${handle} rejected.`);
    await after();
  };
  const seed = obj(r.account).seed === true;
  return h(
    'div',
    { class: 'decide' },
    field,
    // A starter account was public from the first day: its clear has no penalty (13.8).
    seed ? null : guarded('Accept with penalty', 'btn-primary', decide('accept', true)),
    guarded('Accept without penalty', seed ? 'btn-primary' : 'btn-quiet', decide('accept', false)),
    guarded('Reject', 'btn-danger', decide('reject')),
  );
}

export async function appeals(route: { status: AppealState }, ctx: Ctx): Promise<Node[]> {
  const { status } = route;
  const [ov, body] = await Promise.all([overview(ctx.signal), api(`/api/admin/appeals?status=${status}`, { signal: ctx.signal })]);
  const items = listFrom(body, 'appeals');
  const open = num(ov, 'appealsOpen');
  const account = (r: Row): Node => {
    const a = obj(r.account);
    return h('div', { class: 'who' }, accountLink(str(r, 'handle')), str(a, 'status') ? h('div', { class: 'stack' }, pill(str(a, 'status')), a.seed === true ? h('span', { class: 'who-sub' }, 'starter account') : null) : null);
  };
  return [
    head('Appeals', 'Owners who ask to leave the list.'),
    tabs(
      'Appeal states',
      APPEAL_STATES.map((s) => ({ href: `#appeals/${s}`, text: `${s.charAt(0).toUpperCase()}${s.slice(1)}`, count: s === 'open' ? open : null, current: s === status })),
    ),
    note(NOTE[status]),
    table(
      `${status} appeals`,
      [
        { label: 'Account', cell: account },
        { label: 'Bio code', cell: (r) => h('code', null, str(r, 'code')) },
        { label: 'Message', className: 'wide', cell: (r) => h('bdi', null, str(r, 'message')) },
        { label: 'Email', className: 'wrap', cell: (r) => str(r, 'email') || 'none given' },
        { label: 'Sent', cell: (r) => time(str(r, 'createdAt')) },
        ...(status === 'open'
          ? [
              { label: 'Marks', term: 'strike' as const, className: 'wrap', cell: (r: Row) => marksSentence(obj(r.marks)) },
              { label: 'Decision', className: 'acts', cell: (r: Row) => decision(r, ctx.afterWrite) },
            ]
          : [
              { label: 'Decided', cell: (r: Row) => time(str(r, 'decidedAt')) },
              { label: 'Note', className: 'wide', cell: (r: Row) => str(r, 'note') || 'no note' },
            ]),
      ],
      items,
      status === 'open' ? 'No open appeals. No owner of a listed account asked to leave the list.' : `No ${status} appeals yet.`,
      'appeals-table',
    ),
  ];
}
