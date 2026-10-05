/**
 * S-06 Form (spec R5; plan §9.1, §9.2, §23.A) — route /new/form?draft=<id>, step 3 of 3. The two questions a camera
 * cannot answer (how dangerous right now, has anyone been hurt), the category and sub-type (prefilled from a
 * confident proposal, always correctable), the approximate location text, a note for the crew and the identity on
 * the report. Every edit is written to the draft on disk first. Submit: signed out → requireSession; still no session
 * → the draft is parked as needs_sign_in and the screen says so; offline → queued → S-07; online → syncQueue
 * submitDraft (upload if needed, then POST /api/v1/reports) → S-07. "Save draft" keeps everything on this phone.
 * Validation runs the shared CreateReportInputSchema (partial) plus the required-answer checklist; no silent failures.
 */
import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { Text, View } from 'react-native';

import { PROPOSAL_FLOOR } from '@/domain/intake';
import { CATEGORIES, CATEGORY_LABEL, defaultSubtype, subtypeDef, subtypesOf, type Category, type Subtype } from '@/domain/taxonomy';
import { CreateReportInputSchema, INJURY_FLAGS, REPORTER_DISPLAYS, type Draft, type InjuryFlag, type ReporterDisplay, type SeverityBand } from '@/domain/types';
import { t } from '@/i18n';
import { isSignedIn, requireSession } from '@/services/auth';
import { submitDraft } from '@/services/syncQueue';
import { actions, getState, isOfflineNow } from '@/store/appStore';
import { Screen, goBackOr } from '@/ui/Screen';
import { FlowStatus, exitFlow, useDraftParam } from '@/ui/intake-widgets';
import { Button, Callout, Cell, Field, Group, SectionFooter, SectionHeader, Segmented } from '@/ui/primitives';
import { colors, type } from '@/ui/theme';

type Form = Draft['form'];

const BANDS: SeverityBand[] = [1, 2, 3, 4];

/** The form as the resident last left it, with a confident proposal filled in where nothing was chosen yet. */
function initialForm(draft: Draft): Form {
  const p = draft.analysis?.proposals ?? null;
  const proposed: Form = p && p.confidence >= PROPOSAL_FLOOR ? { category: p.category, subtype: p.subtype } : {};
  const gps = draft.gps;
  return {
    injuryFlag: 'no',
    reporterDisplay: 'named',
    ...proposed,
    ...(gps ? { lat: gps.lat, lng: gps.lng, accuracyM: gps.accuracyM } : {}),
    locationConfirmed: draft.locationConfirmed,
    ...draft.form,
  };
}

/** What still blocks a submit, in the order the screen shows the questions. */
export function missingAnswers(form: Form): string[] {
  const out: string[] = [];
  if (!form.category || !form.subtype) out.push('Pick a category and sub-type.');
  if (form.severityResident === undefined) out.push('Answer how dangerous it is right now.');
  if (!form.injuryFlag) out.push('Say whether anyone has been hurt.');
  if (!form.reporterDisplay) out.push('Choose how you appear on this report.');
  if (form.lat === undefined || form.lng === undefined) out.push('The report has no location yet — go back and confirm where this is.');
  const typed = CreateReportInputSchema.partial().safeParse(form);
  if (!typed.success) out.push(...typed.error.issues.slice(0, 3).map((i) => `${i.path.map(String).join('.') || 'details'}: ${i.message}`));
  return out;
}

export default function FormScreen() {
  const router = useRouter();
  const draft = useDraftParam();
  const [form, setFormState] = useState<Form>(() => (draft ? initialForm(draft) : {}));
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const missing = useMemo(() => missingAnswers(form), [form]);

  if (!draft) {
    return (
      <Screen title={t('form.title')} testID="form">
        <Callout icon="info" title="Draft not found">This draft is no longer on this phone.</Callout>
        <Button title={t('common.back')} variant="secondary" onPress={() => goBackOr(router, '/')} />
      </Screen>
    );
  }

  const current = (): Draft => getState().drafts.find((d) => d.id === draft.id) ?? draft;

  /** Disk first, then state (plan §9.2). */
  function setForm(patch: Form) {
    const next = { ...form, ...patch };
    actions.upsertDraft({ ...current(), form: next, updatedAt: new Date().toISOString() });
    setFormState(next);
  }

  function pickCategory(category: Category) {
    setForm({ category, subtype: form.category === category && form.subtype ? form.subtype : defaultSubtype(category) });
  }

  async function submit() {
    setAttempted(true);
    setNotice(null);
    if (missing.length > 0) return;
    const withForm: Draft = { ...current(), form, updatedAt: new Date().toISOString() };
    actions.upsertDraft(withForm);
    const toSubmitted = () => router.replace({ pathname: '/new/submitted', params: { draft: draft!.id } });
    if (!isSignedIn()) {
      setBusy('Checking your sign-in…');
      const session = await requireSession('report');
      setBusy(null);
      if (!session) {
        actions.setDraftStatus(draft!.id, 'needs_sign_in');
        setNotice('Saved on this phone. Sign in from the Me tab and this report sends by itself.');
        return;
      }
    }
    if (isOfflineNow()) {
      actions.setDraftStatus(draft!.id, 'queued');
      toSubmitted();
      return;
    }
    setBusy(withForm.photoUris.length > 0 && !(withForm.photoIds?.length ?? 0) ? t('analysis.uploading') : 'Sending your report…');
    const result = await submitDraft(current());
    setBusy(null);
    if (result.outcome === 'sent' || result.outcome === 'queued') {
      toSubmitted();
      return;
    }
    if (result.outcome === 'needs_sign_in') {
      setNotice('Your sign-in has expired. Saved on this phone — sign in again from the Me tab and it sends by itself.');
      return;
    }
    setNotice(`Not sent: ${result.reason} Fix the details and submit again; nothing was lost.`);
  }

  function saveDraft() {
    actions.upsertDraft({ ...current(), form, status: 'draft', updatedAt: new Date().toISOString() });
    exitFlow(router);
  }

  const proposalApplied = !!draft.analysis?.proposals && draft.analysis.proposals.confidence >= PROPOSAL_FLOOR;
  const accuracy = form.accuracyM ?? draft.gps?.accuracyM ?? null;
  const subtypes = form.category ? subtypesOf(form.category) : [];

  return (
    <Screen title={t('form.title')} largeTitle={t('form.title')} subtitle={t('capture.step3')} testID="form">
      {proposalApplied ? (
        <Callout icon="sparkle" tone="tint" title={t('form.prefilled')}>
          Proposed: {subtypeDef(draft.analysis!.proposals!.subtype).label}
        </Callout>
      ) : null}

      <SectionHeader>{t('form.category')}</SectionHeader>
      <Group padded>
        <Segmented<Category> options={CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABEL[c] }))} value={form.category ?? ('' as Category)} onChange={pickCategory} label={t('form.category')} />
      </Group>

      {form.category ? (
        <>
          <SectionHeader>{t('form.subtype')}</SectionHeader>
          <Group>
            {subtypes.map((s: Subtype, i) => (
              <Cell key={s} title={subtypeDef(s).label} accessory={form.subtype === s ? 'check' : 'none'} onPress={() => setForm({ subtype: s })} accessibilityRole="checkbox" accessibilityState={{ checked: form.subtype === s }} last={i === subtypes.length - 1} testID={`subtype-${s}`} />
            ))}
          </Group>
        </>
      ) : (
        <SectionFooter>Pick a category to see its sub-types.</SectionFooter>
      )}

      <SectionHeader>{t('form.danger')}</SectionHeader>
      <Group padded>
        <Segmented<SeverityBand> options={BANDS.map((b) => ({ value: b, label: t(`form.danger.${b}` as const) }))} value={form.severityResident ?? (0 as SeverityBand)} onChange={(severityResident) => setForm({ severityResident })} label={t('form.danger')} />
      </Group>
      <SectionFooter>{t('form.dangerHint')}</SectionFooter>
      {form.severityResident === 4 ? (
        <Callout icon="emergency" tone="red" title={t('form.call911')}>
          Submitting with "Emergency" pages the on-call supervisor. It does not call emergency services.
        </Callout>
      ) : null}

      <SectionHeader>{t('form.hurt')}</SectionHeader>
      <Group padded>
        <Segmented<InjuryFlag> options={INJURY_FLAGS.map((f) => ({ value: f, label: t(`form.hurt.${f}` as const) }))} value={form.injuryFlag ?? 'no'} onChange={(injuryFlag) => setForm({ injuryFlag })} label={t('form.hurt')} />
      </Group>
      <SectionFooter>{t('form.hurtHint')}</SectionFooter>

      <SectionHeader>{t('form.location')}</SectionHeader>
      <Group>
        <Field label={t('form.location')} value={form.addressText ?? ''} onChangeText={(addressText) => setForm({ addressText })} placeholder="Nearest address or landmark" maxLength={200} testID="form-address" />
        <Field label={t('form.note')} value={form.note ?? ''} onChangeText={(note) => setForm({ note })} placeholder="Optional · what the crew should know" maxLength={1000} last testID="form-note" />
      </Group>
      <SectionFooter>
        {form.lat !== undefined && form.lng !== undefined ? `Approximate · ${form.locationConfirmed ? 'you confirmed the spot' : 'from your GPS fix'}${accuracy !== null ? ` (±${Math.round(accuracy)} m)` : ''} · ${form.lat.toFixed(5)}, ${form.lng.toFixed(5)}. The city snaps it to the nearest address.` : 'No location on this draft yet.'}
      </SectionFooter>

      <SectionHeader>{t('form.identity')}</SectionHeader>
      <Group padded>
        <Segmented<ReporterDisplay> options={REPORTER_DISPLAYS.map((r) => ({ value: r, label: t(`form.identity.${r}` as const) }))} value={form.reporterDisplay ?? 'named'} onChange={(reporterDisplay) => setForm({ reporterDisplay })} label={t('form.identity')} />
      </Group>
      <SectionFooter>{t('form.identityHint')}</SectionFooter>

      {attempted && missing.length > 0 ? (
        <View accessibilityLiveRegion="polite" style={{ marginBottom: 10 }}>
          {missing.map((m) => (
            <Text key={m} style={[type.subheadline, { color: colors.red }]}>
              {m}
            </Text>
          ))}
        </View>
      ) : null}
      <FlowStatus text={busy ?? notice} tone={notice && !busy ? 'amber' : 'default'} testID="form-status" />
      <Button title={busy ?? t('form.submit')} icon="check" onPress={() => void submit()} disabled={busy !== null} testID="form-submit" />
      <Button title={t('form.saveDraft')} variant="secondary" onPress={saveDraft} disabled={busy !== null} style={{ marginTop: 8 }} testID="form-save" />
    </Screen>
  );
}
