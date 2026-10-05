/**
 * Jest manual mock for @maplibre/maplibre-react-native v11 (plan §14, §23.F). Picked up automatically because it sits
 * next to node_modules. Map, Camera, GeoJSONSource and Layer are plain Views: a GeoJSONSource renders one pressable
 * View per feature (testID `mlrn-feature-<id>`, label = the feature's title), so screen tests can count pins and press
 * them; a press calls the source's onPress with a PressEventWithFeatures-shaped event, and the Map's background is
 * `<testID>-background`. OfflineManager is an in-memory pack store with `__emitProgress`, `__emitError` and `__reset`
 * helpers for the service tests. Only names the real v11 module exports are exported here.
 */
import type { CameraProps, GeoJSONSourceProps, GeoJSONSourceRef, LayerProps, MapProps, OfflinePackCreateOptions, OfflinePackError, OfflinePackErrorListener, OfflinePackProgressListener, OfflinePackStatus } from '@maplibre/maplibre-react-native';
import type { Feature, GeoJSON as GeoJSONObject } from 'geojson';
import { useImperativeHandle } from 'react';
import { Pressable, View } from 'react-native';

type AnyEvent = { nativeEvent: Record<string, unknown>; stopPropagation: () => void };

const event = (nativeEvent: Record<string, unknown>): AnyEvent => ({ nativeEvent, stopPropagation() {} });

function MapMock({ children, testID = 'mlrn-map', onPress, style }: MapProps) {
  return (
    <View testID={testID} style={style}>
      <Pressable testID={`${testID}-background`} accessibilityRole="button" onPress={() => onPress?.(event({ lngLat: [0, 0], point: [0, 0] }) as never)} />
      {children}
    </View>
  );
}

export { MapMock as Map };

export function Camera({ ref, initialViewState, testID = 'mlrn-camera' }: CameraProps) {
  useImperativeHandle(ref, () => ({ setStop: async () => {}, jumpTo() {}, easeTo() {}, flyTo() {}, fitBounds() {}, zoomTo() {} }));
  return <View testID={testID} accessibilityLabel={JSON.stringify(initialViewState ?? null)} />;
}

function featuresOf(data: GeoJSONSourceProps['data']): Feature[] {
  if (typeof data === 'string') return [];
  const g = data as GeoJSONObject;
  if (g.type === 'FeatureCollection') return g.features;
  if (g.type === 'Feature') return [g];
  return [];
}

export function GeoJSONSource({ id = 'source', data, cluster, children, onPress, ref }: GeoJSONSourceProps) {
  const features = featuresOf(data);
  useImperativeHandle(
    ref,
    (): GeoJSONSourceRef => ({
      getData: async () => ({ type: 'FeatureCollection', features }),
      getClusterExpansionZoom: async () => 14,
      getClusterLeaves: async () => [],
      getClusterChildren: async () => [],
      setFeatureState: async () => {},
      getFeatureState: async () => null,
      removeFeatureState: async () => {},
      getAnimatableRef: () => null,
    }),
  );
  return (
    <View testID={`mlrn-source-${id}`} accessibilityLabel={cluster ? 'clustered' : 'unclustered'}>
      {features.map((f, i) => {
        const pid = f.properties?.id ?? f.id ?? i;
        const coordinates = f.geometry.type === 'Point' ? f.geometry.coordinates : [0, 0];
        return (
          <Pressable key={String(pid)} testID={`mlrn-feature-${String(pid)}`} accessibilityRole="button" accessibilityLabel={typeof f.properties?.title === 'string' ? f.properties.title : String(pid)} onPress={() => onPress?.(event({ features: [f], lngLat: coordinates, point: [0, 0] }) as never)} />
        );
      })}
      {children}
    </View>
  );
}

export function Layer({ id, type }: LayerProps) {
  return <View testID={`mlrn-${type}-layer`} accessibilityLabel={id} />;
}

// ---------- OfflineManager: in-memory packs ----------

class MockOfflinePack {
  id: string;
  metadata: Record<string, unknown>;
  bounds: OfflinePackCreateOptions['bounds'];
  current: OfflinePackStatus;
  constructor(id: string, options: OfflinePackCreateOptions) {
    this.id = id;
    this.metadata = options.metadata ?? {};
    this.bounds = options.bounds;
    this.current = { id, state: 'active', percentage: 0, completedResourceCount: 0, completedResourceSize: 0, completedTileCount: 0, completedTileSize: 0, requiredResourceCount: 0 };
  }
  async status(): Promise<OfflinePackStatus> {
    return this.current;
  }
  async resume(): Promise<void> {}
  async pause(): Promise<void> {}
}

export { MockOfflinePack as OfflinePack };

const packs = new Map<string, MockOfflinePack>();
const listeners = new Map<string, { progress: OfflinePackProgressListener; error: OfflinePackErrorListener }>();
let seq = 0;

export const OfflineManager = {
  createOptions: [] as OfflinePackCreateOptions[],
  async createPack(options: OfflinePackCreateOptions, progress: OfflinePackProgressListener, error: OfflinePackErrorListener): Promise<MockOfflinePack> {
    const pack = new MockOfflinePack(`mock-pack-${++seq}`, options);
    packs.set(pack.id, pack);
    listeners.set(pack.id, { progress, error });
    this.createOptions.push(options);
    return pack;
  },
  async getPacks(): Promise<MockOfflinePack[]> {
    return [...packs.values()];
  },
  async getPack(id: string): Promise<MockOfflinePack> {
    const pack = packs.get(id);
    if (!pack) throw new Error(`OfflinePack ${id} not found`);
    return pack;
  },
  async deletePack(id: string): Promise<void> {
    packs.delete(id);
    listeners.delete(id);
  },
  async invalidatePack(): Promise<void> {},
  async invalidateAmbientCache(): Promise<void> {},
  async clearAmbientCache(): Promise<void> {},
  async setMaximumAmbientCacheSize(): Promise<void> {},
  async resetDatabase(): Promise<void> {
    packs.clear();
    listeners.clear();
  },
  async mergeOfflineRegions(): Promise<void> {},
  setTileCountLimit() {},
  setProgressEventThrottle() {},
  async subscribe() {},
  unsubscribe() {},

  /** Test helper: deliver a progress event for a pack (also updates what `pack.status()` returns). */
  __emitProgress(id: string, patch: Partial<OfflinePackStatus>) {
    const pack = packs.get(id);
    if (!pack) throw new Error(`no mock pack ${id}`);
    pack.current = { ...pack.current, ...patch, id };
    listeners.get(id)?.progress(pack as never, pack.current);
  },
  /** Test helper: deliver an error event for a pack. */
  __emitError(id: string, error: OfflinePackError) {
    const pack = packs.get(id);
    if (!pack) throw new Error(`no mock pack ${id}`);
    listeners.get(id)?.error(pack as never, error);
  },
  /** Test helper: forget every pack and listener. */
  __reset() {
    packs.clear();
    listeners.clear();
    this.createOptions = [];
  },
};

export type MockOfflineManager = typeof OfflineManager;
