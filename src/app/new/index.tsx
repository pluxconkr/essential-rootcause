/**
 * S-04 Capture (spec R3; plan §9.1, §9.2, §23.A) — route /new, step 1 of 3. One tap from the tab bar to the camera.
 * The shutter or the library gives a picture; a Draft is written to disk BEFORE anything else, then the picture is
 * re-encoded (≤ 1280 px, quality 0.7, 320 px thumbnail, EXIF dropped) into the draft's folder. Library photos carry
 * no location, so the resident confirms the spot against a short list of known places (GPS fix, nearby saved
 * addresses, home area, pilot centre) — no map needed in M1. Then: offline → the form; online → sign-in is asked
 * here, before the first server write (plan §23.A); signed out keeps the draft and goes to the form offline-style;
 * signed in → upload (POST /api/v1/photos) → analysis (POST /api/v1/vision/analyze) → S-05. Without camera access the
 * screen states the three steps and offers the library — a control that does nothing is never shown.
 */
import { CameraView } from 'expo-camera';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { newId } from '@/domain/ids';
import { placeCandidates, type PlaceCandidate } from '@/domain/intake';
import { PILOT } from '@/domain/pilot';
import type { Draft } from '@/domain/types';
import { t } from '@/i18n';
import { requireSession } from '@/services/auth';
import { getCameraPermission, pickFromLibrary, requestCameraPermission, type PermissionState, type SourceImage } from '@/services/camera';
import { analyzePhoto, processImage, removeDraftPhotos, uploadPhoto } from '@/services/photos';
import { actions, getState, isOfflineNow, useAppState } from '@/store/appStore';
import { useReports } from '@/store/derived';
import { Screen, goBackOr } from '@/ui/Screen';
import { FlowStatus, PhotoPreview } from '@/ui/intake-widgets';
import { Button, Callout, Cell, Group, SectionFooter, SectionHeader } from '@/ui/primitives';
import { colors, radius } from '@/ui/theme';

type Phase = { kind: 'capture' } | { kind: 'review'; draft: Draft } | { kind: 'locate'; draft: Draft };

function latest(draft: Draft): Draft {
  return getState().drafts.find((d) => d.id === draft.id) ?? draft;
}

export default function CaptureScreen() {
  const router = useRouter();
  const [perm, setPerm] = useState<PermissionState | 'checking'>('checking');
  const [cameraReady, setCameraReady] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: 'capture' });
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const camera = useRef<CameraView>(null);
  const offline = useAppState((s) => isOfflineNow(s));
  const fix = useAppState((s) => s.location);
  const home = useAppState((s) => s.prefs.home);
  const reports = useReports();

  useEffect(() => {
    let alive = true;
    void getCameraPermission().then((p) => {
      if (alive) setPerm(p);
    });
    return () => {
      alive = false;
    };
  }, []);

  /** The draft exists on disk before the picture is processed (plan §9.2 "disk before state"). */
  const startDraft = useCallback(async (source: 'camera' | 'library', image: SourceImage) => {
    setProblem(null);
    const now = new Date().toISOString();
    const gps = getState().location;
    const draft: Draft = {
      id: newId('d'),
      photoUris: [],
      thumbUris: [],
      gps: gps ? { lat: gps.lat, lng: gps.lng, accuracyM: gps.accuracyM } : null,
      locationConfirmed: source === 'camera' && gps !== null,
      capturedAt: now,
      form: {},
      status: 'draft',
      failReason: null,
      reportId: null,
      updatedAt: now,
    };
    actions.upsertDraft(draft);
    setBusy('Saving the photo on this phone…');
    const processed = await processImage(draft.id, image);
    setBusy(null);
    if (!processed) {
      actions.removeDraft(draft.id);
      setProblem('The photo could not be saved. Try again or choose another one.');
      return;
    }
    const withPhoto: Draft = { ...draft, photoUris: [processed.fullUri], thumbUris: [processed.thumbUri], updatedAt: new Date().toISOString() };
    actions.upsertDraft(withPhoto);
    setPhase({ kind: 'review', draft: withPhoto });
  }, []);

  async function shutter() {
    const cam = camera.current;
    if (!cam) return;
    try {
      setBusy('Taking the photo…');
      const shot = await cam.takePictureAsync({ quality: 0.9, exif: false });
      if (!shot?.uri) throw new Error('no picture');
      await startDraft('camera', { uri: shot.uri, width: shot.width, height: shot.height });
    } catch {
      setBusy(null);
      setProblem('The camera did not return a photo. Try again or choose one from your library.');
    }
  }

  async function library() {
    const picked = await pickFromLibrary();
    if (picked) await startDraft('library', picked);
  }

  function discard(draft: Draft) {
    actions.removeDraft(draft.id);
    removeDraftPhotos(draft.id);
    setPhase({ kind: 'capture' });
  }

  /** After the picture is accepted: confirm the spot when there is none, then hand over to the network step. */
  function proceed(draft: Draft) {
    const current = latest(draft);
    if (!current.gps || !current.locationConfirmed) {
      setPhase({ kind: 'locate', draft: current });
      return;
    }
    void send(current);
  }

  function confirmPlace(draft: Draft, place: PlaceCandidate) {
    const current = latest(draft);
    const next: Draft = {
      ...current,
      gps: { lat: place.lat, lng: place.lng, accuracyM: place.accuracyM },
      locationConfirmed: true,
      form: { ...current.form, lat: place.lat, lng: place.lng, accuracyM: place.accuracyM, locationConfirmed: true, ...(place.addressText ? { addressText: place.addressText } : {}) },
      updatedAt: new Date().toISOString(),
    };
    actions.upsertDraft(next);
    void send(next);
  }

  /** Offline → form. Online → sign in first (plan §23.A), then upload + analysis → S-05; any miss keeps the draft and goes to the form. */
  async function send(draft: Draft) {
    const toForm = () => router.push({ pathname: '/new/form', params: { draft: draft.id } });
    if (isOfflineNow()) {
      toForm();
      return;
    }
    setBusy('Checking your sign-in…');
    const session = await requireSession('report');
    if (!session) {
      setBusy(null);
      toForm();
      return;
    }
    setBusy(t('analysis.uploading'));
    const uploaded = await uploadPhoto(latest(draft));
    if (!uploaded.ok) {
      setBusy(null);
      setProblem(`The upload did not complete (${uploaded.message}). You can still file now; the photo is sent with the report.`);
      toForm();
      return;
    }
    const withId: Draft = { ...latest(draft), photoIds: [uploaded.data.photoId], updatedAt: new Date().toISOString() };
    actions.upsertDraft(withId);
    setBusy('Checking for reports already filed nearby…');
    const analysed = await analyzePhoto(withId, uploaded.data.photoId);
    actions.upsertDraft({ ...latest(withId), analysis: analysed.ok ? analysed.data : null, updatedAt: new Date().toISOString() });
    setBusy(null);
    router.push({ pathname: '/new/analysis', params: { draft: draft.id } });
  }

  if (phase.kind === 'review') {
    const draft = phase.draft;
    return (
      <Screen title={t('capture.title')} largeTitle={t('capture.title')} subtitle={t('capture.step1')} testID="capture">
        <PhotoPreview uri={draft.photoUris[0]} caption={t('analysis.exactUpload')} testID="capture-preview" />
        <FlowStatus text={busy ?? problem} tone={problem && !busy ? 'amber' : 'default'} />
        <Button title={t('capture.usePhoto')} icon="check" onPress={() => proceed(draft)} disabled={busy !== null} testID="capture-use" />
        <Button title={t('capture.retake')} variant="secondary" icon="refresh" onPress={() => discard(draft)} disabled={busy !== null} style={{ marginTop: 8 }} />
      </Screen>
    );
  }

  if (phase.kind === 'locate') {
    const draft = phase.draft;
    const places = placeCandidates({ fix, home, reports, center: PILOT.center, centerName: PILOT.name });
    return (
      <Screen title={t('capture.title')} largeTitle={t('capture.confirmLocation')} subtitle={t('capture.step1')} testID="capture-locate">
        <Callout icon="pin" tone="tint" title={t('capture.confirmLocation')}>
          {`${t('capture.locationHint')} Pick the closest known place; you can edit the address on the next step.`}
        </Callout>
        <SectionHeader>Known places near you</SectionHeader>
        <Group>
          {places.map((p, i) => (
            <Cell key={p.id} icon={p.id === 'gps' ? 'location' : 'pin'} title={p.label} subtitle={p.detail} accessory="chevron" onPress={() => confirmPlace(draft, p)} last={i === places.length - 1} testID={`place-${p.id}`} />
          ))}
        </Group>
        <SectionFooter>The report is marked approximate until an inspector confirms the spot. Library photos carry no GPS.</SectionFooter>
        <FlowStatus text={busy} />
        <Button title={t('common.back')} variant="secondary" onPress={() => setPhase({ kind: 'review', draft })} disabled={busy !== null} />
      </Screen>
    );
  }

  const granted = perm === 'granted';
  return (
    <Screen title={t('capture.title')} largeTitle={t('capture.title')} subtitle={t('capture.step1')} testID="capture">
      {granted ? (
        <>
          <View style={styles.viewfinder}>
            <CameraView ref={camera} style={StyleSheet.absoluteFill} facing="back" onCameraReady={() => setCameraReady(true)} onMountError={() => setPerm('unavailable')} />
          </View>
          <Text style={styles.hint}>{t('capture.hint')}</Text>
          <FlowStatus text={busy ?? problem} tone={problem && !busy ? 'amber' : 'default'} />
          <Button title={busy ?? (cameraReady ? t('capture.shutter') : 'Starting the camera…')} icon="camera" onPress={() => void shutter()} disabled={!cameraReady || busy !== null} testID="capture-shutter" />
        </>
      ) : (
        <>
          <SectionHeader>What happens</SectionHeader>
          <Group>
            <Cell icon="camera" iconColor={colors.tint} title="1 · Photograph the hazard" subtitle="Include the ground and something for scale. Keep people and licence plates out of frame." />
            <Cell icon="sparkle" iconColor={colors.tint} title="2 · Check what we could tell" subtitle="Category and sub-type proposals, and any existing report within 25 m you can add to instead." />
            <Cell icon="document" iconColor={colors.tint} title="3 · Answer two questions" subtitle="How dangerous is it right now, and has anyone been hurt. Then you see the score and the queue position." last />
          </Group>
          {perm === 'denied' || perm === 'unavailable' ? (
            <Callout icon="cameraOutline" tone="amber" title={perm === 'denied' ? 'Camera access is off' : 'No camera available'}>
              {t('capture.noPermission')}
            </Callout>
          ) : null}
          <FlowStatus text={busy ?? problem} tone={problem && !busy ? 'amber' : 'default'} />
          {perm === 'undetermined' || perm === 'checking' ? <Button title="Allow camera" icon="camera" onPress={() => void requestCameraPermission().then(setPerm)} disabled={perm === 'checking' || busy !== null} testID="capture-allow" /> : null}
        </>
      )}
      <Button title={t('capture.library')} variant={granted ? 'secondary' : 'primary'} icon="photo" onPress={() => void library()} disabled={busy !== null} style={{ marginTop: 8 }} testID="capture-library" />
      <SectionFooter>{offline ? 'No signal: the report is saved on this phone and sent when you are back online.' : 'Reports are saved on this phone first, then sent. Sign-in is asked before the photo uploads.'}</SectionFooter>
      <Button title={t('common.cancel')} variant="ghost" onPress={() => goBackOr(router, '/')} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  viewfinder: { width: '100%', aspectRatio: 3 / 4, borderRadius: radius.group, overflow: 'hidden', backgroundColor: colors.ink, marginBottom: 10 },
  hint: { fontSize: 13, lineHeight: 18, color: colors.ink2, marginBottom: 10 },
});
