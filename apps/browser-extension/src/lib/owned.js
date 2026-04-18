import { normalizeGalleryId } from "./queue";

export const OWNED_IDS_STORAGE_KEY = "ownedGalleryIdsCache";
export const OWNED_SYNCED_AT_STORAGE_KEY = "ownedGalleryIdsSyncedAt";

let cachedOwnedIds = null;
let cachedSyncTimestamp = 0;

function isExtensionContextAvailable() {
  try {
    return typeof chrome !== "undefined" && Boolean(chrome?.runtime?.id) && Boolean(chrome?.storage?.local);
  } catch {
    return false;
  }
}

function safeStorageGet(keys) {
  return new Promise((resolve) => {
    if (!isExtensionContextAvailable()) {
      resolve({});
      return;
    }

    try {
      chrome.storage.local.get(keys, (result) => {
        try {
          if (chrome.runtime?.lastError) {
            resolve({});
            return;
          }
          resolve(result || {});
        } catch {
          resolve({});
        }
      });
    } catch {
      resolve({});
    }
  });
}

function safeStorageSet(value) {
  return new Promise((resolve) => {
    if (!isExtensionContextAvailable()) {
      resolve(false);
      return;
    }

    try {
      chrome.storage.local.set(value, () => {
        try {
          if (chrome.runtime?.lastError) {
            resolve(false);
            return;
          }
        } catch {
          resolve(false);
          return;
        }
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}

async function loadOwnedCacheFromStorage() {
  const result = await safeStorageGet([OWNED_IDS_STORAGE_KEY, OWNED_SYNCED_AT_STORAGE_KEY]);
  const storedIds = Array.isArray(result[OWNED_IDS_STORAGE_KEY]) ? result[OWNED_IDS_STORAGE_KEY] : [];
  const normalized = storedIds
    .map((item) => normalizeGalleryId(item))
    .filter(Boolean);

  cachedOwnedIds = new Set(normalized);
  cachedSyncTimestamp = Number(result[OWNED_SYNCED_AT_STORAGE_KEY] || 0);
  if (!Number.isFinite(cachedSyncTimestamp)) {
    cachedSyncTimestamp = 0;
  }
}

export async function getOwnedGalleryIds() {
  if (!cachedOwnedIds) {
    await loadOwnedCacheFromStorage();
  }
  return Array.from(cachedOwnedIds || []);
}

export async function getOwnedSyncTimestamp() {
  if (cachedOwnedIds === null) {
    await loadOwnedCacheFromStorage();
  }
  return cachedSyncTimestamp;
}

export async function setOwnedGalleryState(ids, syncedAt = Date.now()) {
  const normalized = [...new Set((Array.isArray(ids) ? ids : []).map((item) => normalizeGalleryId(item)).filter(Boolean))];
  const ok = await safeStorageSet({
    [OWNED_IDS_STORAGE_KEY]: normalized,
    [OWNED_SYNCED_AT_STORAGE_KEY]: syncedAt
  });

  if (ok) {
    cachedOwnedIds = new Set(normalized);
    cachedSyncTimestamp = syncedAt;
  }

  return ok;
}

export function formatRelativeSyncTime(timestamp) {
  const value = Number(timestamp || 0);
  if (!value) return "Never";

  const diffMs = Date.now() - value;
  const diffMinutes = Math.floor(diffMs / 60000);
  if (diffMinutes <= 0) return "just now";
  if (diffMinutes === 1) return "1 minute ago";
  if (diffMinutes < 60) return `${diffMinutes} minutes ago`;

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours === 1) return "1 hour ago";
  if (diffHours < 24) return `${diffHours} hours ago`;

  const diffDays = Math.floor(diffHours / 24);
  if (diffDays === 1) return "1 day ago";
  return `${diffDays} days ago`;
}
