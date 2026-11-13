// What the flood says. One lane of the flood is one slop account repeating one template line under every post.
// Every handle is longer than the 15 characters X allows, so none of them can belong to a real person.

export interface FloodLine {
  name: string;
  handle: string;
  text: string;
}

export const SLOP: readonly FloodLine[] = [
  { name: 'Growth Mindset Daily', handle: 'growth_mindset_daily', text: 'Great insight! Game-changer.' },
  { name: 'Insightful Takes', handle: 'insightful_takes_ai', text: 'Absolutely love this perspective!' },
  { name: 'Future of Work Hub', handle: 'future_of_work_hub_ai', text: "Couldn't agree more!" },
  { name: 'Thought Leader', handle: 'ai_thought_leader_x', text: 'Such valuable content. Thanks!' },
  { name: 'Daily Hustle Notes', handle: 'daily_hustle_notes_x', text: 'This. So much this.' },
  { name: 'Mindset Mentor', handle: 'mindset_mentor_daily', text: 'What a journey! Proud of you.' },
  { name: 'Scale With Sam', handle: 'scale_with_sam_daily', text: 'Persistence always pays off.' },
  { name: 'Founder Fuel', handle: 'founder_fuel_every_day', text: 'Consistency is the key to success.' },
  { name: 'Hustle Harmony', handle: 'hustle_harmony_official', text: 'This is a game-changer.' },
  { name: 'Vision Ventures', handle: 'vision_ventures_daily', text: 'Thanks for sharing this gem!' },
  { name: 'Pure Momentum', handle: 'pure_momentum_quotes', text: 'Love this! So true.' },
  { name: 'Next Level You', handle: 'next_level_you_always', text: 'Spot on. Well said.' },
  { name: 'Wealth Whisperer', handle: 'wealth_whisperer_daily', text: "Couldn't have said it better." },
  { name: 'Grind Mode', handle: 'grind_mode_every_day', text: 'Keep pushing! You inspire me.' },
  { name: 'Limitless Lana', handle: 'limitless_lana_official', text: 'Such an inspiring thread.' },
  { name: 'Mentor Mike', handle: 'mentor_mike_motivates', text: 'Wow. Mind blown.' },
  { name: 'Pure Value Posts', handle: 'pure_value_posts_daily', text: 'Pure value. Bookmarked.' },
  { name: 'Reply Royalty', handle: 'reply_royalty_official', text: 'What a great point!' },
  { name: 'Success Stack', handle: 'success_stack_daily_x', text: 'Absolutely. Well put.' },
  { name: 'Peak Performance', handle: 'peak_performance_hub_x', text: 'Needed to read this today.' },
  { name: 'Morning Routine', handle: 'morning_routine_daily', text: 'This is so powerful.' },
  { name: 'The Daily Grind', handle: 'the_daily_grind_notes', text: 'Incredible insight as always.' },
  { name: 'Mindset Matters', handle: 'mindset_matters_daily', text: 'Love the energy here.' },
  { name: 'Build In Public', handle: 'build_in_public_tips_x', text: 'So inspiring. Keep going!' },
];

export const PEOPLE: readonly FloodLine[] = [
  { name: 'Devon Hale', handle: 'devon_debugs_offline_sync', text: 'Does it handle clock skew between devices?' },
  { name: 'Priya N.', handle: 'priya_on_conflict_bugs', text: 'Which test finally caught the bug?' },
  { name: 'Marco Bianchi', handle: 'marco_ships_mobile_apps', text: 'Is the license MIT for the server too?' },
  { name: 'Aiko T.', handle: 'aiko_reads_the_source', text: 'How large is it on older Android phones?' },
  { name: 'Lena Weiss', handle: 'lena_writes_long_threads', text: 'I hit the same race in 2023. Fixed it with a queue.' },
  { name: 'Ravi K.', handle: 'ravi_maps_the_outage', text: 'Your graph is wrong after 14:00. Here is why.' },
  { name: 'Tom Ochieng', handle: 'tom_tests_every_edge', text: 'Can you share the failing input?' },
  { name: 'Sofia Lund', handle: 'sofia_reads_the_docs', text: 'The docs say the opposite. Which one is right?' },
];
