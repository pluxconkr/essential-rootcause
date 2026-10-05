/**
 * What the native and web HazardMap have in common (plan §3.3, §13, §23.F): the pin shape, the report GeoJSON
 * source with MapLibre clustering, the paint/layout expressions that colour pins by severity band and size them
 * by vote count, and the chrome drawn over the map in every state — the attribution and the "tiles unavailable"
 * line. Colour is never the only signal: the peek card and the list below the map carry the words.
 *
 * Style-spec types come from the native package's re-exports (the canonical @maplibre/maplibre-gl-style-spec);
 * maplibre-gl's own bundled copies are wider, so these constants satisfy both renderers. Type-only imports, so the
 * web bundle never loads the native module.
 */
import type { Feature, FeatureCollection, Point } from 'geojson';
import type { CircleLayerSpecification, FilterSpecification, SymbolLayerSpecification } from '@maplibre/maplibre-react-native';
import { StyleSheet, Text, View } from 'react-native';

import type { LatLng } from '@/domain/geo';
import type { Category, PublicReport, ReportStatus, SeverityBand } from '@/domain/types';
import { VOTE_THRESHOLDS } from '@/domain/votes';
import { t } from '@/i18n';

import { colors, radius, severityTone, toneColor, type } from './theme';

export interface HazardPin {
  id: string;
  lat: number;
  lng: number;
  severity: SeverityBand;
  voteCount: number;
  title: string;
  status: ReportStatus;
  category: Category;
}

export type HazardPinProperties = Omit<HazardPin, 'lat' | 'lng'>;

export interface HazardMapProps {
  pins: HazardPin[];
  /** Vantage point the camera starts on (GPS fix, else home area, else the pilot centre). */
  center: LatLng;
  zoom?: number;
  selectedId?: string | null;
  /** A pin press reports its id; a press on the map background reports null. */
  onSelect: (reportId: string | null) => void;
  /** Offline: tiles cannot load, so say so over the map (plan §9.6). Pins render either way. */
  offline: boolean;
  height: number;
  testID?: string;
}

export function toPins(reports: PublicReport[]): HazardPin[] {
  return reports.map((r) => ({ id: r.id, lat: r.lat, lng: r.lng, severity: r.severity, voteCount: r.voteCount, title: r.title, status: r.status, category: r.category }));
}

export function pinsToGeoJSON(pins: HazardPin[]): FeatureCollection<Point, HazardPinProperties> {
  const features: Feature<Point, HazardPinProperties>[] = pins.map(({ lat, lng, ...properties }) => ({ type: 'Feature', id: properties.id, geometry: { type: 'Point', coordinates: [lng, lat] }, properties }));
  return { type: 'FeatureCollection', features };
}

export const SOURCE_ID = 'reports';

export const LAYER_ID = {
  clusters: 'reports-clusters',
  clusterCount: 'reports-cluster-count',
  pins: 'reports-pins',
} as const;

export const CLUSTER = {
  radius: 40, // plan §3.3 / S-02: pins closer than 40 px merge into one count
  minPoints: 2,
  /** The worst severity in a cluster colours it, so a cluster never hides a critical report behind a grey dot. */
  properties: { maxSeverity: ['max', ['get', 'severity']] },
} as const;

export const MAP_VIEW = {
  zoom: 13, // ≈ 2.5 km across a phone: the 400 m home area and the blocks around it
  minZoom: 9, // the pilot city stays recognisable
  maxZoom: 18,
} as const;

/** Pin radius in points: at zero votes, at the 25-vote supervisor-review threshold and at the 100-vote council threshold (domain/votes). */
export const PIN_RADIUS = { none: 7, review: 11, council: 15 } as const;

type CirclePaint = NonNullable<CircleLayerSpecification['paint']>;
type SymbolLayout = NonNullable<SymbolLayerSpecification['layout']>;
type SymbolPaint = NonNullable<SymbolLayerSpecification['paint']>;

/** Severity band → the spec badge colours (Low grey · Moderate blue · High amber · Critical red). */
function severityColorExpression(property: string): NonNullable<CirclePaint['circle-color']> {
  return ['match', ['get', property], 1, toneColor[severityTone[1]], 2, toneColor[severityTone[2]], 3, toneColor[severityTone[3]], 4, toneColor[severityTone[4]], toneColor.grey];
}

export const PIN_FILTER: FilterSpecification = ['!', ['has', 'point_count']];
export const CLUSTER_FILTER: FilterSpecification = ['has', 'point_count'];

/** The selected pin gets a dark, thicker ring; every other pin a white one. */
export function pinPaint(selectedId: string | null): CirclePaint {
  const id = selectedId ?? '';
  return {
    'circle-color': severityColorExpression('severity'),
    'circle-radius': ['interpolate', ['linear'], ['get', 'voteCount'], 0, PIN_RADIUS.none, VOTE_THRESHOLDS.supervisorReview, PIN_RADIUS.review, VOTE_THRESHOLDS.councilItem, PIN_RADIUS.council],
    'circle-stroke-color': ['case', ['==', ['get', 'id'], id], colors.ink, colors.white],
    'circle-stroke-width': ['case', ['==', ['get', 'id'], id], 3, 2],
    'circle-opacity': 0.92,
  };
}

export const CLUSTER_PAINT: CirclePaint = {
  'circle-color': severityColorExpression('maxSeverity'),
  'circle-radius': ['step', ['get', 'point_count'], 14, 10, 18, 50, 22],
  'circle-stroke-color': colors.white,
  'circle-stroke-width': 2,
  'circle-opacity': 0.92,
};

export const CLUSTER_COUNT_LAYOUT: SymbolLayout = {
  'text-field': ['to-string', ['get', 'point_count_abbreviated']],
  'text-font': ['Noto Sans Bold'], // a font stack the bundled liberty style already ships glyphs for
  'text-size': 12,
  'text-allow-overlap': true,
  'text-ignore-placement': true,
};

export const CLUSTER_COUNT_PAINT: SymbolPaint = { 'text-color': colors.white };

/** Attribution over the map, visible in every state (plan §3.3), and the offline line when tiles cannot load. */
export function MapChrome({ offline, testID }: { offline: boolean; testID: string }) {
  return (
    <>
      {offline ? (
        <View style={styles.notice} pointerEvents="none" accessibilityLiveRegion="polite" testID={`${testID}-offline`}>
          <Text maxFontSizeMultiplier={1.4} style={type.footnote}>
            {t('map.offline')}
          </Text>
        </View>
      ) : null}
      <View style={styles.attribution} pointerEvents="none" testID={`${testID}-attribution`}>
        <Text style={type.mapAttribution} numberOfLines={1}>
          {t('map.attribution')}
        </Text>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  notice: { position: 'absolute', top: 8, left: 8, right: 8, paddingHorizontal: 10, paddingVertical: 6, borderRadius: radius.control, backgroundColor: 'rgba(255,255,255,0.92)' },
  attribution: { position: 'absolute', right: 0, bottom: 0, paddingHorizontal: 6, paddingVertical: 2, borderTopLeftRadius: radius.tag, backgroundColor: 'rgba(255,255,255,0.8)' },
});
