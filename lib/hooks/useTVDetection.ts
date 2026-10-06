/**
 * useTVDetection
 * Detects if the user is on a TV/set-top-box browser.
 */

import { useSyncExternalStore } from 'react';

const TV_USER_AGENT_PATTERNS = [
  /smarttv/i,
  /tizen/i,
  /webos/i,
  /firetv/i,
  /android tv/i,
  /googletv/i,
  /crkey/i, // Chromecast
  /aftt/i, // Amazon Fire TV Stick
  /aftm/i, // Amazon Fire TV
  /bravia/i, // Sony Bravia
  /netcast/i, // LG NetCast
  /viera/i, // Panasonic Viera
  /hbbtv/i,
];

function detectTV(): boolean {
  // The Android TV shell app exposes this JS bridge — always TV there.
  if ((window as unknown as Record<string, unknown>).KVideoAndroid) {
    return true;
  }

  const ua = navigator.userAgent;

  // Check UA for TV indicators
  if (TV_USER_AGENT_PATTERNS.some(pattern => pattern.test(ua))) {
    return true;
  }

  // Fallback heuristic: large screen + no touch + low pixel density
  const isLargeScreen = window.innerWidth >= 1280;
  const hasNoTouch = !('ontouchstart' in window) && navigator.maxTouchPoints === 0;
  const lowDensity = window.devicePixelRatio <= 1.5;
  // Android set-top boxes (Chrome/WebView) report no touch and a big screen
  // but often a 2x density, so density must not gate them out.
  const isAndroidBox = /android/i.test(ua) && hasNoTouch && isLargeScreen;

  return isLargeScreen && hasNoTouch && (lowDensity || isAndroidBox);
}

// Detection depends only on the user agent / window, which never change
// without a full reload, so a no-op store subscription is enough.
const subscribe = () => () => {};

export function useTVDetection(): boolean {
  return useSyncExternalStore(
    subscribe,
    detectTV,
    () => false,
  );
}
