// The public criteria, served verbatim at GET /api/v1/criteria. Every number comes from the constants
// that the engine uses, so this text cannot drift from the code. Customer copy (SPEC.md 12.1): direct
// second person, no first person, no em-dash.
import { NETWORK_DAILY_VOTES, STANDING_DAILY, STRIKE_LIMIT, STRIKE_MAX_CROWD, STRIKE_WINDOW_DAYS } from './network.js';
import { GOOD_MARKS_PER_ACCOUNT } from './reputation.js';
import {
  ANCHORS_CONFIRM, ANCHORS_FLAG, CLEARED_RETURN_MIN_NETWORKS, CONFIRM_MIN_NETWORKS, CONFIRM_MIN_TRUST, CONFIRM_SHARE_BOUND, EVIDENCE_CONFIRM,
  EVIDENCE_FLAG, FLAG_MIN_NETWORKS, FLAG_SHARE_BOUND, MAX_AUTO_CONFIRMS_PER_DAY, MAX_AUTO_FLAGS_PER_DAY, PROTECTED_MIN_FOLLOWERS,
} from './rules.js';
import {
  AGE_FACTOR_FIRST_DAY, AGE_FACTOR_FIRST_WEEK, NEW_INSTALL_TRUST, REPUTATION_PRIOR, STANDING_MIN_AGE_DAYS, STANDING_MIN_GOOD_MARKS, STANDING_MIN_REPUTATION,
} from './weight.js';

export interface CriteriaTier { status: 'flagged' | 'confirmed'; title: string; summary: string; rules: string[] }
export interface Criteria { version: number; tiers: CriteriaTier[]; weights: string[]; protections: string[]; appeal: string }

const percent = (share: number): string => `${Math.round(share * 100)}%`;
const thousands = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const networks = (n: number): string => (n === 1 ? '1 of those networks has' : `${n} of those networks have`);
const evidence = (n: number): string => `Evidence check: the marks of at least ${n === 1 ? '1 network name' : `${n} networks name`} a post that the server itself fetched from X and found written by this account.`;

// How many brand-new installs, each on its own network, reach the trust floor of a confirm.
const NEW_INSTALLS_TO_CONFIRM = Math.ceil(CONFIRM_MIN_TRUST / NEW_INSTALL_TRUST);

export const CRITERIA: Readonly<Criteria> = Object.freeze<Criteria>({
  version: 2,
  tiers: [
    {
      status: 'flagged',
      title: 'Flagged',
      summary: `An account is flagged when people on at least ${FLAG_MIN_NETWORKS} different networks mark it as slop, at least ${ANCHORS_FLAG} of them with standing, and the server checked that the account exists on X and wrote a post that they marked. The extension hides flagged accounts only if you set strictness to Strict.`,
      rules: [
        `At least ${FLAG_MIN_NETWORKS} different networks marked the account as slop. A network is one internet connection, so a second install on the same connection adds nothing.`,
        `At least ${networks(ANCHORS_FLAG)} standing. Marks from installs without standing never list an account alone: the account waits in the review queue until a person decides or people with standing agree.`,
        'The server checked that the handle exists on X and still belongs to the same account.',
        evidence(EVIDENCE_FLAG),
        `"Not slop" votes from people with standing count against the marks. A cautious estimate of the share of slop among the people with standing must be ${percent(FLAG_SHARE_BOUND)} or higher. If it is lower, a person decides.`,
        `At most ${MAX_AUTO_FLAGS_PER_DAY} accounts become flagged automatically in 24 hours. The others wait for the next day or for a person.`,
      ],
    },
    {
      status: 'confirmed',
      title: 'Confirmed',
      summary: `An account is confirmed when people on at least ${CONFIRM_MIN_NETWORKS} different networks mark it as slop, at least ${ANCHORS_CONFIRM} of them with standing, and the server verified the posts that they marked. An admin can also confirm it. The extension hides confirmed accounts unless you set strictness to Off, and mute sync, if you turn it on, can mute them on your X account.`,
      rules: [
        `At least ${CONFIRM_MIN_NETWORKS} different networks marked the account as slop. Together they must carry at least ${percent(CONFIRM_MIN_TRUST)} of one fully trusted vote. A brand-new install carries ${percent(NEW_INSTALL_TRUST)}, so marks from brand-new installs alone need at least ${NEW_INSTALLS_TO_CONFIRM} different networks.`,
        `At least ${networks(ANCHORS_CONFIRM)} standing.`,
        evidence(EVIDENCE_CONFIRM),
        `"Not slop" votes from people with standing count against the marks. A cautious estimate of the share of slop among the people with standing must be ${percent(CONFIRM_SHARE_BOUND)} or higher. If it is lower, a person decides.`,
        'When the people who rated the account have a track record of disagreeing with each other, marks from one side of that split alone do not confirm it. A person decides.',
        `At most ${MAX_AUTO_CONFIRMS_PER_DAY} accounts become confirmed automatically in 24 hours. The others wait for the next day or for a person.`,
        'Accounts from the public starter list are confirmed from the first day. Votes do not remove a starter account. If one of them is your account, use the appeal form at https://x-slop.com/check.',
        'An admin can confirm or clear any account by hand.',
      ],
    },
  ],
  weights: [
    'One network is one voice. If you and a housemate vote from the same internet connection, your votes count once. If one of you has standing, the votes of that install make the voice of the connection.',
    `Standing: your install has standing when it is at least ${STANDING_MIN_AGE_DAYS} days old, has at least ${STANDING_MIN_GOOD_MARKS} good marks and has a reputation of at least ${percent(STANDING_MIN_REPUTATION)}. An admin can also give an install standing. You lose standing when your reputation falls below that level or when an admin bans the install.`,
    `A good mark: you marked an account as slop before it was on the list, and then an admin confirmed it. Only an admin decision gives good marks, and one admin confirm gives them to the first ${GOOD_MARKS_PER_ACCOUNT} networks that marked the account, to the install of each network that marked it first.`,
    `A wrong vote takes your standing away: a mark on an account that an admin then cleared with a penalty, or a "not slop" vote on an account that an admin then confirmed. After a wrong vote, only the marks that you set after that admin decision can become good marks, so you need ${STANDING_MIN_GOOD_MARKS} new good marks.`,
    `At most ${STANDING_DAILY} votes from your network carry standing in 24 hours: a vote carries standing when fewer than ${STANDING_DAILY} votes from your network carried standing in the 24 hours before it. A vote past that never carries standing, also not later: it counts as a vote without standing. So if you mark many accounts, your first ${STANDING_DAILY} marks of each day carry standing.`,
    'Marks from new installs count toward the number of networks, but they wait for a person: an account that only installs without standing mark goes to the review queue, and it stays off the list while it waits.',
    '"Not slop" votes count only from installs with standing. Without standing, your "not slop" vote changes no status. The admin sees how many such votes an account has.',
    `In its first 24 hours, a new install counts ${percent(AGE_FACTOR_FIRST_DAY)} of an established one, and ${percent(AGE_FACTOR_FIRST_WEEK)} for the rest of its first week.`,
    `Every install starts with a reputation of ${percent(REPUTATION_PRIOR)}. Your reputation rises with each good mark, and when you said "not slop" about an account that an admin then cleared with a penalty. It falls when you marked an account that an admin then cleared with a penalty, and when you said "not slop" about an account that an admin then confirmed.`,
    'Agreeing with an answer that is already public earns nothing, so you cannot raise your reputation by repeating what everyone can see.',
  ],
  protections: [
    `Each network counts for at most ${NETWORK_DAILY_VOTES} votes in 24 hours, and the votes of installs with standing take their places first. Past that, your marks still hide accounts for you, and they join the shared count later as the limit frees up.`,
    'Review: a person checks every account that the crowd marks but that misses one of the checks above. While it waits, the account is not on the list and every public page shows it with a score of 0.',
    `Protected accounts: an account with ${thousands(PROTECTED_MIN_FOLLOWERS)} followers or more, or one that an admin protects, changes its state on the list only by an admin decision.`,
    `Daily brake: at most ${MAX_AUTO_CONFIRMS_PER_DAY} automatic confirms and ${MAX_AUTO_FLAGS_PER_DAY} automatic flags in 24 hours, so a wave of marks cannot fill the list in one day.`,
    `Strikes: if an admin clears an account with a penalty, each network that marked it as slop before the clear gets a strike. A network with standing gets none when more than ${STRIKE_MAX_CROWD} networks with standing marked the account. With ${STRIKE_LIMIT} strikes inside ${STRIKE_WINDOW_DAYS} days, the votes from your network count for nothing on the shared list until ${STRIKE_WINDOW_DAYS} days after the newest strike.`,
    'Strikes from installs without standing silence only the installs without standing on that network. A vote that you delete or change after the clear keeps its strike. The accounts that you hid or muted stay hidden and muted for you. A starter account gives no strike.',
    `A cleared account never returns on votes alone. When at least ${CLEARED_RETURN_MIN_NETWORKS} networks mark it again, it goes to the review queue.`,
    'Reply timing, such as replies within seconds of a post, never changes a status. A person sees it in the review queue.',
    'An account whose handle now belongs to another X account leaves the list, so the next owner of a handle is never hidden. An account that the server cannot find on X keeps its state, and votes list nothing new on it.',
  ],
  appeal: 'If your account is on the list, open the appeal form at https://x-slop.com/check and put the code it gives you in your X bio. A person reads every appeal. If your appeal is accepted, your account leaves the list and votes alone cannot bring it back.',
});
