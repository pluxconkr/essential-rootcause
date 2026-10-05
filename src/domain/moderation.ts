/**
 * Comment moderation filter (plan §8 moderation.ts, §12 "comment filter"; App Store guideline 1.2 on user content).
 * Pure module: no React Native or Expo imports. The same check runs on the phone before a comment is queued (instant
 * feedback, nothing sent) and on POST /api/v1/reports/:id/comments (400 carrying the same reason). It is deliberately
 * simple and explainable — length, links, a word list — because the moderation queue (content_flag → staff hide)
 * handles everything a word list cannot, and comments are a public record about one place.
 */

export const COMMENT_RULES = {
  maxLength: 1000, // spec: types.ts CommentInputSchema body max(1000)
  maxUrls: 0, // plan §8 "links": comments describe a spot, never point elsewhere — links are the usual spam vector, so none are allowed
} as const;

export const MODERATION_REASONS = ['empty', 'too_long', 'links', 'profanity'] as const;
export type ModerationReason = (typeof MODERATION_REASONS)[number];

export type ModerationVerdict = { ok: true; reason: null } | { ok: false; reason: ModerationReason; message: string };

/** Resident-facing copy for each refusal: the phone shows it inline, the route returns it in the 400. */
export const MODERATION_MESSAGE: Record<ModerationReason, string> = {
  empty: 'Write a comment first.',
  too_long: `Keep comments under ${COMMENT_RULES.maxLength.toLocaleString('en-US')} characters.`,
  links: 'Links are not allowed in comments. Describe the spot instead.',
  profanity: 'That wording is not allowed. Comments are a public record — keep them civil.',
};

/**
 * Words that refuse a comment outright. Matched as whole words after normalisation, with repeated letters allowed
 * ("shiiit"). Kept short on purpose: anything subtler goes through the flag → moderation queue path.
 */
export const BLOCKED_WORDS: readonly string[] = ['fuck', 'fucker', 'fucking', 'motherfucker', 'shit', 'bullshit', 'bitch', 'asshole', 'bastard', 'cunt', 'pussy', 'whore', 'slut', 'nigger', 'nigga', 'faggot', 'fag', 'retard', 'retarded', 'spic', 'chink', 'kike', 'wetback', 'tranny'];

/** http(s)://…, www.…, or a bare domain with a common TLD and an optional path. */
const URL_RE = /(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|gov|edu|us|co|info|biz|ly|me|app|dev|xyz)\b(?:\/\S*)?/gi;

const WORD_PATTERNS: readonly RegExp[] = BLOCKED_WORDS.map(
  (word) =>
    new RegExp(
      `\\b${word
        .split('')
        .map((c) => `${c}+`)
        .join('')}\\b`,
    ),
);

export function countUrls(text: string): number {
  return (text.match(URL_RE) ?? []).length;
}

/** Lower-case plus the usual substitutions (@→a, $→s, 1/!→i, 0→o, 3→e) so "sh1t" and "$hit" meet the list. */
export function normaliseForWordList(text: string): string {
  return text.toLowerCase().replace(/@/g, 'a').replace(/\$/g, 's').replace(/[1!]/g, 'i').replace(/0/g, 'o').replace(/3/g, 'e');
}

export function hasBlockedWord(text: string): boolean {
  const normalised = normaliseForWordList(text);
  return WORD_PATTERNS.some((re) => re.test(normalised));
}

function refuse(reason: ModerationReason): ModerationVerdict {
  return { ok: false, reason, message: MODERATION_MESSAGE[reason] };
}

/** Length, then links, then the word list — the first failing rule names the reason. */
export function moderateComment(body: string): ModerationVerdict {
  const text = body.trim();
  if (text.length === 0) return refuse('empty');
  if (text.length > COMMENT_RULES.maxLength) return refuse('too_long');
  if (countUrls(text) > COMMENT_RULES.maxUrls) return refuse('links');
  if (hasBlockedWord(text)) return refuse('profanity');
  return { ok: true, reason: null };
}
