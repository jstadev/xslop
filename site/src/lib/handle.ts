// Handle rules from SPEC 5: trim, drop one leading @, lower-case, then ^[a-z0-9_]{1,15}$.

const HANDLE = /^[a-z0-9_]{1,15}$/;

export function normalizeHandle(input: string): string | null {
  let value = input.trim();
  if (value.startsWith('@')) value = value.slice(1);
  value = value.toLowerCase();
  return HANDLE.test(value) ? value : null;
}

export function isHandle(value: unknown): value is string {
  return typeof value === 'string' && HANDLE.test(value);
}

/** Profile link on x.com for a validated handle. */
export function profileUrl(handle: string): string {
  return `https://x.com/${encodeURIComponent(handle)}`;
}

const TWEET_ID = /^[0-9]{1,20}$/;

/** Post link on x.com, or null when the id does not match SPEC 5. The link names no author: X shows who wrote the post. */
export function postUrl(tweetId: string): string | null {
  return TWEET_ID.test(tweetId) ? `https://x.com/i/status/${tweetId}` : null;
}
