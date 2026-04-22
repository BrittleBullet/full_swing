export const EXTENSION_VERSION = __FULL_SWING_VERSION__;

export function formatVersionMismatchMessage(appVersion) {
  const normalizedAppVersion = String(appVersion || "unknown").trim() || "unknown";
  return `Version mismatch — app is v${normalizedAppVersion}, extension is v${EXTENSION_VERSION}`;
}
