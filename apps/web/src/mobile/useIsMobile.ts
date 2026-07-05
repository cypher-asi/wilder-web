// Mobile detection for the agent-management shell: a coarse pointer (touch)
// on a narrow viewport, OR any phone-width window (comma = OR in media query
// lists) so a narrow desktop browser previews the mobile experience too.

import { useSyncExternalStore } from "react";

const QUERY = "(pointer: coarse) and (max-width: 900px), (max-width: 520px)";

/** One-shot check (for non-React call sites). */
export function isMobile(): boolean {
  return typeof window !== "undefined" && window.matchMedia(QUERY).matches;
}

function subscribe(onChange: () => void): () => void {
  const mql = window.matchMedia(QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

/** Reactive mobile check; re-renders when the media query flips. */
export function useIsMobile(): boolean {
  return useSyncExternalStore(subscribe, isMobile, () => false);
}
