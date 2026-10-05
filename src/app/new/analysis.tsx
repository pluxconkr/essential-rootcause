/**
 * S-05 Analysis (spec R4; plan §9.1, §3.6, §23.I) — route /new/analysis?draft=<id>, step 2 of 3. Shows exactly the
 * photo that was uploaded, what the server could tell (a proposal with its confidence, or the honest line for
 * unclear / off / offline — in M1 the model is off and the line says so), and the open reports already filed within
 * the duplicate radius. "Add to that report" attaches the uploaded photo to that report (POST /api/v1/reports/:id/
 * photos, counts as an urgency vote) and opens it; "File separately" continues to the form. Nothing here waits on a
 * network: the analysis result was stored on the draft by the capture step.
 */
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Text, View } from 'react-native';

import { PROPOSAL_FLOOR } from '@/domain/intake';
import { RESIDENT_WORDING } from '@/domain/status';
import { dupRadiusM, subtypeDef } from '@/domain/taxonomy';
import type { Draft, DuplicateCandidate } from '@/domain/types';
import { t, tn } from '@/i18n';
import { requireSession } from '@/services/auth';
import { attachPhoto } from '@/services/photos';
import { actions, isOfflineNow, useAppState } from '@/store/appStore';
import { Screen, goBackOr } from '@/ui/Screen';
import { FlowStatus, PhotoPreview, useDraftParam } from '@/ui/intake-widgets';
import { Button, Callout, Cell, Group, SectionFooter, SectionHeader } from '@/ui/primitives';
import { SeverityBars } from '@/ui/severity-widgets';
import { colors, type } from '@/ui/theme';

function analysisLine(draft: Draft, offline: boolean): string {
  const a = draft.analysis;
  if (!a) return offline ? t('analysis.offline') : 'Analysis did not run for this photo. Pick a category on the next step.';
  if (a.proposals) return a.proposals.confidence >= PROPOSAL_FLOOR ? t('form.prefilled') : t('analysis.unclear');
  return a.reason === 'disabled' ? t('analysis.disabled') : t('analysis.unclear');
}

export default function AnalysisScreen() {
  const router = useRouter();
  const draft = useDraftParam();
  const offline = useAppState((s) => isOfflineNow(s));
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  if (!draft) {
    return (
      <Screen title={t('analysis.title')} testID="analysis">
        <Callout icon="info" title="Draft not found">This draft is no longer on this phone.</Callout>
        <Button title={t('common.back')} variant="secondary" onPress={() => goBackOr(router, '/')} />
      </Screen>
    );
  }

  const proposal = draft.analysis?.proposals ?? null;
  const confident = proposal !== null && proposal.confidence >= PROPOSAL_FLOOR;
  const duplicates = draft.analysis?.duplicates ?? [];
  const radiusM = duplicates.length ? Math.max(...duplicates.map((d) => dupRadiusM(d.subtype))) : 0;
  const toForm = () => router.push({ pathname: '/new/form', params: { draft: draft.id } });

  async function addTo(dup: DuplicateCandidate) {
    setProblem(null);
    const photoId = draft!.photoIds?.[0];
    if (!photoId) {
      setProblem('Your photo has not been uploaded yet, so it cannot be added to another report. File separately instead.');
      return;
    }
    setBusy(`Adding your photo to ${dup.title}…`);
    const session = await requireSession('report');
    if (!session) {
      setBusy(null);
      setProblem('Sign in to add your photo to that report.');
      return;
    }
    const res = await attachPhoto(dup.id, photoId);
    setBusy(null);
    if (!res.ok) {
      setProblem(res.status === 429 ? 'You have added many photos this hour. File separately or try again later.' : `Could not add the photo (${res.message}). You can still file separately.`);
      return;
    }
    actions.upsertReport(res.data.report);
    if (res.data.voted) actions.setVoted(dup.id, true);
    actions.setDraftStatus(draft!.id, 'sent', { reportId: dup.id });
    router.replace({ pathname: '/report/[id]', params: { id: dup.id, added: '1' } });
  }

  return (
    <Screen title={t('analysis.title')} largeTitle={t('analysis.title')} subtitle={t('capture.step2')} testID="analysis">
      <PhotoPreview uri={draft.photoUris[0]} caption={t('analysis.exactUpload')} />

      <SectionHeader>{t('analysis.proposal')}</SectionHeader>
      <Group padded>
        {confident && proposal ? (
          <View>
            <Text style={type.headline}>{subtypeDef(proposal.subtype).label}</Text>
            <Text style={[type.footnote, { marginTop: 2 }]}>
              {t(`category.${proposal.category}` as const)} · {t('analysis.confidence', { pct: Math.round(proposal.confidence * 100) })}
              {draft.analysis?.model ? ` · ${draft.analysis.model}` : ''}
            </Text>
            {proposal.severityBand && proposal.severityConfidence !== null && proposal.severityConfidence >= PROPOSAL_FLOOR ? (
              <View style={{ marginTop: 8 }}>
                <SeverityBars band={proposal.severityBand} size="sm" />
                <Text style={[type.footnote, { marginTop: 2 }]}>Proposed severity · {t('analysis.confidence', { pct: Math.round(proposal.severityConfidence * 100) })} · you answer "how dangerous" yourself on the next step</Text>
              </View>
            ) : null}
          </View>
        ) : null}
        <Text style={[type.subheadline, confident ? { marginTop: 8 } : null]} accessibilityLiveRegion="polite">
          {analysisLine(draft, offline)}
        </Text>
      </Group>

      {duplicates.length > 0 ? (
        <>
          <SectionHeader>{t('analysis.duplicates', { m: radiusM })}</SectionHeader>
          <Group>
            {duplicates.map((d, i) => (
              <Cell
                key={d.id}
                icon={subtypeDef(d.subtype).category}
                iconColor={colors.ink2}
                title={d.title}
                subtitle={`${Math.round(d.distanceM)} m away · ${tn(d.daysOpen, 'feed.daysOpen')} · ${d.voteCount} ${d.voteCount === 1 ? 'vote' : 'votes'} · ${RESIDENT_WORDING[d.status]}`}
                trailing={<Button title={t('analysis.addTo')} size="sm" variant="tonal" onPress={() => void addTo(d)} disabled={busy !== null} testID={`add-to-${d.id}`} />}
                last={i === duplicates.length - 1}
              />
            ))}
          </Group>
          <SectionFooter>Adding your photo to an existing report counts as your urgency vote on it and skips a duplicate work order.</SectionFooter>
        </>
      ) : null}

      <FlowStatus text={busy ?? problem} tone={problem && !busy ? 'amber' : 'default'} />
      <Button title={duplicates.length > 0 ? t('analysis.fileSeparately') : t('common.continue')} icon="document" onPress={toForm} disabled={busy !== null} testID="analysis-continue" />
    </Screen>
  );
}
