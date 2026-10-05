/**
 * The string table is the only place copy lives: every key is non-empty, plural pairs are complete,
 * placeholders are filled, and unknown keys fall back to the key itself instead of crashing.
 */
import { en } from '@/i18n/en';
import { t, tn } from '@/i18n';

describe('i18n (English only in v1)', () => {
  test('every key has non-empty copy', () => {
    for (const [k, v] of Object.entries(en)) expect({ k, v: v.trim().length > 0 }).toEqual({ k, v: true });
  });

  test('plural pairs are complete', () => {
    const keys = Object.keys(en);
    for (const k of keys) {
      if (k.endsWith('.one')) expect(keys).toContain(k.replace(/\.one$/, '.other'));
      if (k.endsWith('.other')) expect(keys).toContain(k.replace(/\.other$/, '.one'));
    }
  });

  test('placeholders are filled and plurals pick the right form', () => {
    expect(t('status.checked', { ago: '3 min ago' })).toBe('Reports checked 3 min ago');
    expect(tn(1, 'feed.daysOpen')).toBe('1 day open');
    expect(tn(12, 'feed.daysOpen')).toBe('12 days open');
  });

  test('unknown keys fall back to the key', () => {
    expect(t('does.not.exist' as never)).toBe('does.not.exist');
  });

  test('alert copy rule: status wording names what happened, never "be careful"', () => {
    for (const [k, v] of Object.entries(en)) if (k.startsWith('status.')) expect(v.toLowerCase()).not.toContain('be careful');
  });
});
