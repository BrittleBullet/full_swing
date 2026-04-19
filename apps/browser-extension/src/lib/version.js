export const EXTENSION_VERSION = "1.0.0";

export function formatVersionMismatchMessage(appVersion) {
  const normalizedAppVersion = String(appVersion || "unknown").trim() || "unknown";
  return `Version mismatch — app is v${normalizedAppVersion}, extension is v${EXTENSION_VERSION}`;
}
