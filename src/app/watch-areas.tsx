/**
 * S-11 Watch areas (spec R14; plan §9.1 home area, §7 /me/watch-areas): the places a resident wants alerts for —
 * kind, label, centre ("use my location" or the home area), radius in 100 m steps, categories. Saved on the account
 * through /api/v1/me/watch-areas; a `home` area is mirrored into prefs.home so the feed follows it on this phone.
 * Signed out: the home area from setup stays on the phone and the screen says what signing in adds. Offline: the
 * list is what was loaded, and the form says saving needs a signal. No spinners; titles carry progress.
 */
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { z } from 'zod';

import { PILOT } from '@/domain/pilot';
import { CATEGORIES, CATEGORY_LABEL } from '@/domain/taxonomy';
import { WatchAreaInputSchema, WatchAreaSchema, type Category, type WatchArea, type WatchAreaInput } from '@/domain/types';
import { t } from '@/i18n';
import { api } from '@/services/apiClient';
import { acquireLocation } from '@/services/location';
import { actions, isOfflineNow, useAppState } from '@/store/appStore';
import { Screen } from '@/ui/Screen';
import { categoryIcon, type IconName } from '@/ui/icons';
import { Body, Button, Callout, Cell, Checkbox, Field, Group, SectionFooter, SectionHeader, Segmented, Stepper } from '@/ui/primitives';
import { colors } from '@/ui/theme';

export const RADIUS = { min: 100, max: 3000, step: 100 } as const; // spec: WatchAreaSchema radiusM 100–3000 (src/domain/types.ts), 100 m steps
export const WALK_M_PER_MIN = 80; // ≈ 4.8 km/h: the radius explained as minutes on foot

type Kind = WatchArea['kind'];

const KIND_LABEL: Record<Kind, string> = { home: 'Home', work: 'Work', route: 'Route', custom: 'Custom' };
const KIND_ICON: Record<Kind, IconName> = { home: 'home', work: 'pin', route: 'map', custom: 'pin' };
const KINDS = (Object.keys(KIND_LABEL) as Kind[]).map((value) => ({ value, label: KIND_LABEL[value] }));

const WatchAreasResponse = z.object({ watchAreas: z.array(WatchAreaSchema) });
const WatchAreaResponse = z.object({ watchArea: WatchAreaSchema });

const watchAreasApi = {
  list: () => api('/api/v1/me/watch-areas', WatchAreasResponse),
  create: (input: WatchAreaInput) => api('/api/v1/me/watch-areas', WatchAreaResponse, { method: 'POST', body: input }),
  update: (id: string, input: WatchAreaInput) => api(`/api/v1/me/watch-areas/${encodeURIComponent(id)}`, WatchAreaResponse, { method: 'PATCH', body: input }),
  remove: (id: string) => api(`/api/v1/me/watch-areas/${encodeURIComponent(id)}`, z.null(), { method: 'DELETE' }),
};

type Form = WatchAreaInput & { id: string | null };

const clampRadius = (m: number) => Math.min(RADIUS.max, Math.max(RADIUS.min, Math.round(m / RADIUS.step) * RADIUS.step));
const walkMinutes = (m: number) => Math.max(1, Math.round(m / WALK_M_PER_MIN));

export default function WatchAreasScreen() {
  const router = useRouter();
  const session = useAppState((s) => s.session);
  const offline = useAppState((s) => isOfflineNow(s));
  const prefs = useAppState((s) => s.prefs);
  const userId = session?.userId ?? null;
  const [areas, setAreas] = useState<WatchArea[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [busy, setBusy] = useState<'save' | 'remove' | 'locate' | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Server copy, signed in and online only (zero fetches offline or signed out).
  useEffect(() => {
    if (!userId) {
      setAreas(null);
      return;
    }
    if (offline) return;
    let alive = true;
    void watchAreasApi.list().then((res) => {
      if (!alive) return;
      if (res.ok) {
        setAreas(res.data.watchAreas);
        setLoadError(null);
      } else setLoadError(res.message);
    });
    return () => {
      alive = false;
    };
  }, [userId, offline]);

  function startNew(kind: Kind = 'custom') {
    const home = prefs.home;
    setForm({ id: null, kind, label: '', lat: home?.lat ?? PILOT.center.lat, lng: home?.lng ?? PILOT.center.lng, radiusM: clampRadius(home?.radiusM ?? PILOT.homeRadiusM), categories: [], schedule: null });
    setError(null);
  }

  function startEdit(area: WatchArea) {
    setForm({ ...area, categories: [...area.categories] });
    setError(null);
  }

  async function save() {
    if (!form) return;
    const parsed = WatchAreaInputSchema.safeParse({ kind: form.kind, label: form.label.trim() || KIND_LABEL[form.kind], lat: form.lat, lng: form.lng, radiusM: form.radiusM, categories: form.categories, schedule: form.schedule });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Check the watch area details.');
      return;
    }
    setError(null);
    setBusy('save');
    const res = form.id ? await watchAreasApi.update(form.id, parsed.data) : await watchAreasApi.create(parsed.data);
    setBusy(null);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    const saved = res.data.watchArea;
    setAreas((prev) => [...(prev ?? []).filter((a) => a.id !== saved.id), saved]);
    // The home area lives on this phone too (plan §9.1): keep both copies the same.
    if (saved.kind === 'home') actions.savePrefs({ ...prefs, home: { lat: saved.lat, lng: saved.lng, radiusM: saved.radiusM } });
    setForm(null);
  }

  async function remove() {
    if (!form?.id) return;
    const id = form.id;
    setBusy('remove');
    const res = await watchAreasApi.remove(id);
    setBusy(null);
    if (!res.ok && res.status !== 404) {
      setError(res.message);
      return;
    }
    setAreas((prev) => (prev ?? []).filter((a) => a.id !== id));
    setForm(null);
  }

  async function locate() {
    setBusy('locate');
    const fix = await acquireLocation();
    setBusy(null);
    if (fix) setForm((f) => (f ? { ...f, lat: fix.lat, lng: fix.lng } : f));
    else setError('Location is not available right now. Allow location access, or keep the centre as it is.');
  }

  const list = areas ?? [];
  const serverHome = list.some((a) => a.kind === 'home');
  const showLocalHome = prefs.home !== null && !serverHome;
  const saveTitle = offline ? 'Needs a signal to save' : busy === 'save' ? 'Saving…' : form?.id ? t('common.save') : t('settings.addWatch');

  return (
    <Screen title={t('settings.watchAreas')} largeTitle={t('settings.watchAreas')} fallback="/me" testID="watch-areas">
      <SectionFooter style={{ paddingTop: 0 }}>{t('settings.watchHint')}</SectionFooter>
      {!session ? (
        <>
          <Callout icon="signIn" tone="tint" title="Sign in to save watch areas">
            Your home area from setup stays on this phone. Signing in keeps watch areas on your account, so alerts follow you to a new phone.
          </Callout>
          <Button title={t('signIn.title')} variant="tonal" icon="signIn" onPress={() => router.push({ pathname: '/sign-in', params: { reason: 'watch' } })} testID="watch-sign-in" />
        </>
      ) : null}
      {session && offline && areas === null ? (
        <Callout icon="offline" tone="amber" title="No signal">
          Your saved watch areas load when you are back online. The home area below is the copy on this phone.
        </Callout>
      ) : null}
      {loadError ? (
        <Callout icon="alert" tone="red" title="Could not load your watch areas">
          {loadError}
        </Callout>
      ) : null}

      <SectionHeader>Your areas</SectionHeader>
      <Group>
        {showLocalHome ? <Cell icon="home" iconColor={colors.tint} title="Home area on this phone" subtitle={`${prefs.home?.radiusM ?? 0} m · from setup · not saved to an account`} accessory={session ? 'chevron' : 'none'} onPress={session ? () => startNew('home') : undefined} testID="watch-local-home" last={list.length === 0} /> : null}
        {list.map((a, i) => (
          <Cell key={a.id} icon={KIND_ICON[a.kind]} iconColor={colors.tint} title={a.label || KIND_LABEL[a.kind]} subtitle={`${KIND_LABEL[a.kind]} · ${a.radiusM} m · ${a.categories.length ? a.categories.map((c) => CATEGORY_LABEL[c]).join(', ') : 'all categories'}`} accessory="chevron" onPress={() => startEdit(a)} last={i === list.length - 1} testID={`watch-${a.id}`} />
        ))}
        {!showLocalHome && list.length === 0 ? <Cell icon="pin" iconColor={colors.ink2} title="No watch areas yet" subtitle="Add one below — your home, your work, the school run." last /> : null}
      </Group>
      {session && !form ? <Button title={t('settings.addWatch')} variant="tonal" icon="plus" onPress={() => startNew()} testID="watch-add" /> : null}

      {form ? (
        <>
          <SectionHeader>{form.id ? 'Edit watch area' : 'New watch area'}</SectionHeader>
          {error ? (
            <Callout icon="alert" tone="red" title="Not saved">
              {error}
            </Callout>
          ) : null}
          <Group padded>
            <Segmented<Kind> options={KINDS} value={form.kind} onChange={(kind) => setForm({ ...form, kind })} label="Kind" />
          </Group>
          <Group>
            <Field label="Label" value={form.label} onChangeText={(label) => setForm({ ...form, label })} placeholder={KIND_LABEL[form.kind]} maxLength={60} testID="watch-label" />
            <Stepper label="Radius" value={form.radiusM / RADIUS.step} min={RADIUS.min / RADIUS.step} max={RADIUS.max / RADIUS.step} onChange={(v) => setForm({ ...form, radiusM: v * RADIUS.step })} hint={`${form.radiusM} m — about a ${walkMinutes(form.radiusM)}-minute walk (steps of ${RADIUS.step} m)`} last />
          </Group>
          <Group padded>
            <Body>{`Centre ${form.lat.toFixed(4)}, ${form.lng.toFixed(4)}`}</Body>
            <Button title={busy === 'locate' ? 'Finding you…' : 'Use my location'} variant="tonal" icon="location" onPress={() => void locate()} disabled={busy !== null} style={{ marginTop: 10 }} testID="watch-locate" />
          </Group>
          <SectionHeader>Categories</SectionHeader>
          <Group>
            {CATEGORIES.map((c: Category, i) => (
              <Cell key={c} icon={categoryIcon(c)} iconColor={colors.tint} title={CATEGORY_LABEL[c]} last={i === CATEGORIES.length - 1} trailing={<Checkbox label={CATEGORY_LABEL[c]} checked={form.categories.includes(c)} onChange={(on) => setForm({ ...form, categories: on ? [...form.categories, c] : form.categories.filter((x) => x !== c) })} />} />
            ))}
          </Group>
          <SectionFooter>Leave every box empty to get alerts for all categories.</SectionFooter>
          <Button title={saveTitle} icon="check" onPress={() => void save()} disabled={offline || busy !== null} testID="watch-save" />
          <Button title={t('common.cancel')} variant="ghost" onPress={() => setForm(null)} disabled={busy !== null} style={{ marginTop: 6 }} />
          {form.id ? <Button title={busy === 'remove' ? 'Removing…' : 'Remove this area'} variant="red" icon="trash" onPress={() => void remove()} disabled={offline || busy !== null} style={{ marginTop: 6 }} testID="watch-remove" /> : null}
        </>
      ) : null}
    </Screen>
  );
}
