/**
 * Camera and photo-library access for S-04 (spec R3; plan §9.1). Thin wrappers that never throw: every call resolves
 * to a PermissionState the screen can render ("Camera access is off. You can still choose a photo from your
 * library."). The library picker is the system picker (no permission prompt on iOS 14+ / Android 13+), so a denied
 * or missing camera always leaves that path open. EXIF is never requested from either source.
 */
import { Camera } from 'expo-camera';
import * as ImagePicker from 'expo-image-picker';

export type PermissionState = 'granted' | 'denied' | 'undetermined' | 'unavailable';

/** A picture from the camera or the library before processing: the local URI and its pixel size. */
export interface SourceImage {
  uri: string;
  width: number;
  height: number;
}

function toState(r: { granted?: boolean; status?: string } | null | undefined): PermissionState {
  if (!r) return 'unavailable';
  if (r.granted) return 'granted';
  return r.status === 'undetermined' ? 'undetermined' : 'denied';
}

export async function getCameraPermission(): Promise<PermissionState> {
  try {
    return toState(await Camera.getCameraPermissionsAsync?.());
  } catch {
    return 'unavailable';
  }
}

export async function requestCameraPermission(): Promise<PermissionState> {
  try {
    return toState(await Camera.requestCameraPermissionsAsync?.());
  } catch {
    return 'unavailable';
  }
}

/** One still image from the library; null when the resident cancels or the picker is unavailable. */
export async function pickFromLibrary(): Promise<SourceImage | null> {
  try {
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: false, quality: 1, exif: false, selectionLimit: 1 });
    if (!res || res.canceled) return null;
    const asset = res.assets?.[0];
    return asset?.uri ? { uri: asset.uri, width: asset.width, height: asset.height } : null;
  } catch {
    return null;
  }
}
