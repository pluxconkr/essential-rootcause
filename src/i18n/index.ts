/**
 * Tiny string table: t(key, params) with {name} placeholders and .one/.other plurals.
 * English only in v1 (owner decision D6); the shape is kept so a second catalog can be added later.
 * No Expo imports here — this module is shared by the domain layer, tests and the server routes.
 */
import { en, type Key } from './en';

export type Locale = 'en';
export type { Key };

let current: Locale = 'en';

/** Accepts a BCP-47 tag; everything resolves to English in v1. Kept for sibling parity with app/_layout.tsx. */
export function setLocale(_tag: string | null | undefined): Locale {
  current = 'en';
  return current;
}

export function locale(): Locale {
  return current;
}

export function t(key: Key, params?: Record<string, string | number>): string {
  let s: string = en[key] ?? key;
  if (params) for (const [k, v] of Object.entries(params)) s = s.split(`{${k}}`).join(String(v));
  return s;
}

/** Keys that exist as a `.one` / `.other` pair (distributive over the key union). */
type PluralKeyOf<K> = K extends `${infer B}.one` ? (`${B}.other` extends Key ? B : never) : never;
export type PluralKey = PluralKeyOf<Key>;

/** English-style plural: exactly one vs. everything else. Fills {n} automatically. */
export function tn(n: number, key: PluralKey, params?: Record<string, string | number>): string {
  return t(`${key}.${n === 1 ? 'one' : 'other'}` as Key, { n, ...(params ?? {}) });
}

/** Comma-separated list keys → array. */
export function tlist(key: Key): string[] {
  return t(key).split(',');
}
