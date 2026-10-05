/**
 * moderation.ts — the comment filter the phone and POST /reports/:id/comments share (plan §8, §12): length, links,
 * word list with substitutions and stretched letters; ordinary civic comments pass untouched.
 */
import { BLOCKED_WORDS, COMMENT_RULES, MODERATION_MESSAGE, countUrls, hasBlockedWord, moderateComment, normaliseForWordList } from '@/domain/moderation';

describe('moderateComment', () => {
  test('plain comments about the spot pass', () => {
    for (const body of ['Still there this morning, the lip is at least 3 cm now.', 'Crew came by at 9:30 and put a cone out — thanks!', 'Our block has 12 kids walking past this every day to the school on George St.', 'Scunthorpe residents agree. Assess this classic problem.']) {
      expect(moderateComment(body)).toEqual({ ok: true, reason: null });
    }
  });

  test('empty and over-long comments are refused with the reason', () => {
    expect(moderateComment('   ')).toEqual({ ok: false, reason: 'empty', message: MODERATION_MESSAGE.empty });
    expect(COMMENT_RULES.maxLength).toBe(1000);
    expect(moderateComment('a'.repeat(1000)).ok).toBe(true);
    expect(moderateComment('a'.repeat(1001))).toEqual({ ok: false, reason: 'too_long', message: MODERATION_MESSAGE.too_long });
  });

  test('links are refused: http(s), www and bare domains', () => {
    expect(COMMENT_RULES.maxUrls).toBe(0);
    expect(moderateComment('See https://example.com/photo for the real story').reason).toBe('links');
    expect(moderateComment('check www.fixmystreet.org').reason).toBe('links');
    expect(moderateComment('more at bit.ly/abc').reason).toBe('links');
    expect(moderateComment('the city site cityofnewbrunswick.gov/dpw lists it').reason).toBe('links');
    expect(countUrls('http://a.com and https://b.org/x and plain text')).toBe(2);
    expect(countUrls('12 Somerset St. is near Hamilton St.')).toBe(0);
  });

  test('profanity is refused, including substitutions and stretched letters, but not inside other words', () => {
    expect(moderateComment('fix this shit already')).toEqual({ ok: false, reason: 'profanity', message: MODERATION_MESSAGE.profanity });
    expect(moderateComment('fix this $h1t already').reason).toBe('profanity');
    expect(moderateComment('SHIIIIT').reason).toBe('profanity');
    expect(moderateComment('What the f3ck').ok).toBe(true); // not on the list as spelt
    expect(moderateComment('the shipment of asphalt is late').ok).toBe(true);
    expect(moderateComment('a classic case of assessment delay').ok).toBe(true);
    expect(hasBlockedWord('F.U.C.K')).toBe(false);
    expect(BLOCKED_WORDS.length).toBeGreaterThan(10);
  });

  test('normalisation maps the usual substitutions', () => {
    expect(normaliseForWordList('$H1T @ss')).toBe('shit ass');
  });

  test('the first failing rule names the reason: length before links before words', () => {
    expect(moderateComment(`https://x.com ${'a'.repeat(1000)}`).reason).toBe('too_long');
    expect(moderateComment('shit https://x.com').reason).toBe('links');
  });
});
