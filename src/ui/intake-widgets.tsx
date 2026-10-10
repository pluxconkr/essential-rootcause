/**
 * Shared pieces of the intake flow S-04…S-07 (spec 4.1): the draft behind the `draft` route param, the preview
 * that shows exactly the image being uploaded (spec R4), a live-region status line instead of a spinner, and the
 * way out of the full-screen /new stack back to the tabs.
 */
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Image, StyleSheet, Text, View } from 'react-native';

import type { Draft } from '@/domain/types';
import { useAppState } from '@/store/appStore';

import { Icon } from './icons';
import { CELL_PAD, colors, radius, type } from './theme';

/** The draft named by `?draft=<id>`, read from the store so every step re-renders on change. */
export function useDraftParam(): Draft | null {
  const { draft } = useLocalSearchParams<{ draft?: string }>();
  const drafts = useAppState((s) => s.drafts);
  return drafts.find((d) => d.id === draft) ?? null;
}

type Router = ReturnType<typeof useRouter>;

/** Leave the /new modal stack. Deep links and tests have nothing to dismiss, so they land on the feed. */
/** Leave the /new flow for the Home tab. A plain replace (the siblings' goBackOr pattern) closes the full-screen modal stack deterministically; dismissAll() leaves router state behind that survives between tests. */
export function exitFlow(router: Router): void {
  router.replace('/');
}

export function PhotoPreview({ uri, caption, testID }: { uri: string | undefined; caption?: string; testID?: string }) {
  return (
    <View style={styles.wrap} testID={testID}>
      {uri ? (
        <Image source={{ uri }} style={styles.image} resizeMode="cover" accessibilityIgnoresInvertColors accessibilityLabel="Your photo" />
      ) : (
        <View style={[styles.image, styles.empty]}>
          <Icon name="photo" size={36} color={colors.ink2} />
          <Text style={[type.footnote, { marginTop: 6 }]}>No photo on this draft</Text>
        </View>
      )}
      {caption ? <Text style={[type.footnote, styles.caption]}>{caption}</Text> : null}
    </View>
  );
}

/** One line of progress or outcome, announced when it changes. Never a spinner. */
export function FlowStatus({ text, tone = 'default', testID }: { text: string | null; tone?: 'default' | 'red' | 'amber'; testID?: string }) {
  if (!text) return null;
  const color = tone === 'red' ? colors.red : tone === 'amber' ? colors.amber : colors.ink2;
  return (
    <Text accessibilityLiveRegion="polite" style={[type.subheadline, { color, marginBottom: 10 }]} testID={testID}>
      {text}
    </Text>
  );
}

const styles = StyleSheet.create({
  wrap: { borderRadius: radius.group, overflow: 'hidden', backgroundColor: colors.surface, marginBottom: 10 },
  image: { width: '100%', aspectRatio: 4 / 3 },
  empty: { alignItems: 'center', justifyContent: 'center', backgroundColor: colors.fill },
  caption: { paddingHorizontal: CELL_PAD, paddingVertical: 10 },
});
