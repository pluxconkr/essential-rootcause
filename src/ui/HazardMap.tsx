/**
 * HazardMap (native) — spec R2, plan §3.3, §9.6, §23.F, owner decision D2. @maplibre/maplibre-react-native v11:
 * `Map` renders the bundled snapshot of the OpenFreeMap liberty style (assets/map/style.json, refreshed by
 * scripts/fetch-map-style.ts) so the style always loads and the report layers draw even when every tile request
 * fails; a clustered `GeoJSONSource` of the reports with circle layers coloured by severity and sized by votes, a
 * symbol layer with the cluster counts, and the camera on the vantage point. Pressing a pin selects it for the peek
 * card; pressing a cluster zooms into it; pressing the background clears the selection. The map canvas is hidden
 * from assistive tech — the screen renders the same reports as a list — while the attribution and the offline
 * line stay readable. Provider details live here and in services/mapOffline.ts only (AGENTS.md).
 */
import { Camera, GeoJSONSource, Layer, Map as MapLibreMap, type CameraRef, type GeoJSONSourceRef, type PressEvent, type PressEventWithFeatures, type StyleSpecification } from '@maplibre/maplibre-react-native';
import { useEffect, useMemo, useRef } from 'react';
import { StyleSheet, View, type NativeSyntheticEvent } from 'react-native';

import bundledStyle from '../../assets/map/style.json';

import { CLUSTER, CLUSTER_COUNT_LAYOUT, CLUSTER_COUNT_PAINT, CLUSTER_FILTER, CLUSTER_PAINT, LAYER_ID, MAP_VIEW, MapChrome, PIN_FILTER, SOURCE_ID, pinPaint, pinsToGeoJSON, type HazardMapProps } from './HazardMap.shared';
import { colors } from './theme';

export type { HazardMapProps, HazardPin } from './HazardMap.shared';

/** The snapshot is a complete style object; TypeScript sees a JSON literal, MapLibre sees a style. */
const BUNDLED_STYLE = bundledStyle as unknown as StyleSpecification;

export function HazardMap({ pins, center, zoom = MAP_VIEW.zoom, selectedId = null, onSelect, offline, height, testID = 'hazard-map' }: HazardMapProps) {
  const cameraRef = useRef<CameraRef>(null);
  const sourceRef = useRef<GeoJSONSourceRef>(null);
  const data = useMemo(() => pinsToGeoJSON(pins), [pins]);
  const paint = useMemo(() => pinPaint(selectedId), [selectedId]);

  // The camera starts on the vantage point; when a GPS fix lands later it eases over (the native ref may not exist yet, so never throw).
  useEffect(() => {
    try {
      cameraRef.current?.easeTo({ center: [center.lng, center.lat], duration: 500 });
    } catch {
      /* map not initialised yet: initialViewState already holds the same point */
    }
  }, [center.lat, center.lng]);

  async function expandCluster(clusterId: number, coordinates: [number, number]) {
    try {
      const target = await sourceRef.current?.getClusterExpansionZoom(clusterId);
      if (target != null) cameraRef.current?.easeTo({ center: coordinates, zoom: Math.min(target, MAP_VIEW.maxZoom), duration: 400 });
    } catch {
      /* the list below the map still has every report */
    }
  }

  function onSourcePress(e: NativeSyntheticEvent<PressEventWithFeatures>) {
    e.stopPropagation(); // keep the Map's background handler from clearing the selection we are about to make
    const feature = e.nativeEvent.features[0];
    if (!feature || feature.geometry.type !== 'Point') return;
    const props = feature.properties ?? {};
    if (props.cluster === true && typeof props.cluster_id === 'number') {
      void expandCluster(props.cluster_id, feature.geometry.coordinates as [number, number]);
      return;
    }
    if (typeof props.id === 'string') onSelect(props.id);
  }

  function onMapPress(e: NativeSyntheticEvent<PressEvent> | NativeSyntheticEvent<PressEventWithFeatures>) {
    if ('features' in e.nativeEvent && e.nativeEvent.features.length > 0) return;
    onSelect(null);
  }

  return (
    <View style={[styles.frame, { height }]} testID={testID}>
      <View style={StyleSheet.absoluteFill} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" testID={`${testID}-canvas`}>
        <MapLibreMap mapStyle={BUNDLED_STYLE} style={styles.map} attribution={false} logo={false} compass={false} touchRotate={false} touchPitch={false} onPress={onMapPress} testID={`${testID}-map`}>
          <Camera ref={cameraRef} initialViewState={{ center: [center.lng, center.lat], zoom }} minZoom={MAP_VIEW.minZoom} maxZoom={MAP_VIEW.maxZoom} />
          <GeoJSONSource ref={sourceRef} id={SOURCE_ID} data={data} cluster clusterRadius={CLUSTER.radius} clusterMinPoints={CLUSTER.minPoints} clusterProperties={CLUSTER.properties} onPress={onSourcePress}>
            <Layer id={LAYER_ID.clusters} type="circle" filter={CLUSTER_FILTER} paint={CLUSTER_PAINT} />
            <Layer id={LAYER_ID.clusterCount} type="symbol" filter={CLUSTER_FILTER} layout={CLUSTER_COUNT_LAYOUT} paint={CLUSTER_COUNT_PAINT} />
            <Layer id={LAYER_ID.pins} type="circle" filter={PIN_FILTER} paint={paint} />
          </GeoJSONSource>
        </MapLibreMap>
      </View>
      <MapChrome offline={offline} testID={testID} />
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { overflow: 'hidden', backgroundColor: colors.fill },
  map: { flex: 1 },
});
