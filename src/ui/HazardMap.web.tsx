/**
 * HazardMap (web: console and the exported site) — plan §3.3, §23.F "Web bundle". maplibre-gl 4.x with the same
 * bundled style object, the same clustered report source and the same colours as the native map. The map is
 * created inside useEffect only, and maplibre-gl is loaded there with a dynamic import, because pages are evaluated
 * in Node during `expo export`: nothing touches window at module scope. maplibre-gl 4.7.1 embeds its worker in the
 * main bundle (dist/maplibre-gl.js builds it from an inline Blob), so no setWorkerUrl / public worker file is needed.
 */
import 'maplibre-gl/dist/maplibre-gl.css';
import type { GeoJSONSource, Map as MapLibreMap, MapLayerMouseEvent, StyleSpecification } from 'maplibre-gl';
import { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import bundledStyle from '../../assets/map/style.json';

import { CLUSTER, CLUSTER_COUNT_LAYOUT, CLUSTER_COUNT_PAINT, CLUSTER_FILTER, CLUSTER_PAINT, LAYER_ID, MAP_VIEW, MapChrome, PIN_FILTER, SOURCE_ID, pinPaint, pinsToGeoJSON, type HazardMapProps } from './HazardMap.shared';
import { colors } from './theme';

export type { HazardMapProps, HazardPin } from './HazardMap.shared';

const BUNDLED_STYLE = bundledStyle as unknown as StyleSpecification;

export function HazardMap({ pins, center, zoom = MAP_VIEW.zoom, selectedId = null, onSelect, offline, height, testID = 'hazard-map' }: HazardMapProps) {
  const hostRef = useRef<View>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const onSelectRef = useRef(onSelect);
  const initial = useRef({ center, zoom, data: pinsToGeoJSON(pins) });
  const [ready, setReady] = useState(false);
  const data = useMemo(() => pinsToGeoJSON(pins), [pins]);

  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  // Create once; later prop changes are applied by the effects below.
  useEffect(() => {
    const el = hostRef.current as unknown as HTMLElement | null;
    if (!el) return;
    let disposed = false;
    let map: MapLibreMap | null = null;
    import('maplibre-gl')
      .then((mod) => {
        if (disposed) return;
        const lib = (mod as unknown as { default?: typeof mod }).default ?? mod;
        const { center: c0, zoom: z0, data: d0 } = initial.current;
        map = new lib.Map({ container: el, style: BUNDLED_STYLE, center: [c0.lng, c0.lat], zoom: z0, minZoom: MAP_VIEW.minZoom, maxZoom: MAP_VIEW.maxZoom, attributionControl: false, dragRotate: false, pitchWithRotate: false, touchPitch: false });
        const m = map;
        m.on('load', () => {
          m.addSource(SOURCE_ID, { type: 'geojson', data: d0, cluster: true, clusterRadius: CLUSTER.radius, clusterMinPoints: CLUSTER.minPoints, clusterProperties: CLUSTER.properties });
          m.addLayer({ id: LAYER_ID.clusters, type: 'circle', source: SOURCE_ID, filter: CLUSTER_FILTER, paint: CLUSTER_PAINT });
          m.addLayer({ id: LAYER_ID.clusterCount, type: 'symbol', source: SOURCE_ID, filter: CLUSTER_FILTER, layout: CLUSTER_COUNT_LAYOUT, paint: CLUSTER_COUNT_PAINT });
          m.addLayer({ id: LAYER_ID.pins, type: 'circle', source: SOURCE_ID, filter: PIN_FILTER, paint: pinPaint(null) });
          m.on('click', LAYER_ID.pins, (e: MapLayerMouseEvent) => {
            const id = e.features?.[0]?.properties?.id;
            if (typeof id === 'string') onSelectRef.current(id);
          });
          m.on('click', LAYER_ID.clusters, (e: MapLayerMouseEvent) => {
            const feature = e.features?.[0];
            const clusterId = feature?.properties?.cluster_id;
            if (!feature || typeof clusterId !== 'number' || feature.geometry.type !== 'Point') return;
            const coordinates = feature.geometry.coordinates as [number, number];
            (m.getSource(SOURCE_ID) as GeoJSONSource | undefined)
              ?.getClusterExpansionZoom(clusterId)
              .then((target) => m.easeTo({ center: coordinates, zoom: Math.min(target, MAP_VIEW.maxZoom) }))
              .catch(() => {});
          });
          m.on('click', (e) => {
            if (m.queryRenderedFeatures(e.point, { layers: [LAYER_ID.pins, LAYER_ID.clusters] }).length === 0) onSelectRef.current(null);
          });
          for (const layer of [LAYER_ID.pins, LAYER_ID.clusters]) {
            m.on('mouseenter', layer, () => {
              m.getCanvas().style.cursor = 'pointer';
            });
            m.on('mouseleave', layer, () => {
              m.getCanvas().style.cursor = '';
            });
          }
          mapRef.current = m;
          setReady(true);
        });
      })
      .catch(() => {
        /* no WebGL or the bundle failed to load: the list below the map carries every report */
      });
    return () => {
      disposed = true;
      mapRef.current = null;
      map?.remove();
    };
  }, []);

  useEffect(() => {
    if (!ready) return;
    (mapRef.current?.getSource(SOURCE_ID) as GeoJSONSource | undefined)?.setData(data);
  }, [data, ready]);

  useEffect(() => {
    if (!ready) return;
    const paint = pinPaint(selectedId);
    mapRef.current?.setPaintProperty(LAYER_ID.pins, 'circle-stroke-color', paint['circle-stroke-color']);
    mapRef.current?.setPaintProperty(LAYER_ID.pins, 'circle-stroke-width', paint['circle-stroke-width']);
  }, [selectedId, ready]);

  useEffect(() => {
    if (!ready) return;
    mapRef.current?.easeTo({ center: [center.lng, center.lat], duration: 500 });
  }, [center.lat, center.lng, ready]);

  return (
    <View style={[styles.frame, { height }]} testID={testID}>
      <View ref={hostRef} style={StyleSheet.absoluteFill} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" testID={`${testID}-canvas`} />
      <MapChrome offline={offline} testID={testID} />
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { overflow: 'hidden', backgroundColor: colors.fill },
});
