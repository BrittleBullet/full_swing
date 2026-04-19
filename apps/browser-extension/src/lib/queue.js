export const STORAGE_KEY = "queuedGalleryIds";

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

export function normalizeGalleryId(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const normalized = String(value).trim();
  
  // Validate: numeric only, up to 10 digits
  if (!/^\d{1,10}$/.test(normalized)) {
    return null;
  }

  // Validate: reasonable range for gallery IDs
  // nhentai galleries typically don't exceed 999,999,999
  const num = parseInt(normalized, 10);
  if (num < 1 || num > 999999999) {
    return null;
  }

  return normalized;
}

export function normalizeGalleryTitle(value) {
  if (value === null || value === undefined) {
    return "";
  }

  return String(value).replace(/\s+/g, " ").trim();
}

export function normalizeQueuedGallery(value) {
  if (typeof value === "string" || typeof value === "number") {
    const id = normalizeGalleryId(value);
    return id ? { id, title: "" } : null;
  }

  if (!value || typeof value !== "object") {
    return null;
  }

  const id = normalizeGalleryId(value.id);
  if (!id) {
    return null;
  }

  return {
    id,
    title: normalizeGalleryTitle(value.title)
  };
}

export function dedupeQueuedGalleries(items) {
  const byId = new Map();

  for (const item of Array.isArray(items) ? items : []) {
    const normalized = normalizeQueuedGallery(item);
    if (!normalized) continue;

    const existing = byId.get(normalized.id);
    if (!existing) {
      byId.set(normalized.id, normalized);
      continue;
    }

    if (!existing.title && normalized.title) {
      byId.set(normalized.id, normalized);
    }
  }

  return Array.from(byId.values());
}

export async function getQueuedGalleries() {
  const result = await safeStorageGet([STORAGE_KEY]);
  const storedItems = Array.isArray(result[STORAGE_KEY]) ? result[STORAGE_KEY] : [];
  return dedupeQueuedGalleries(storedItems);
}

export function getQueuedGalleryIds() {
  return getQueuedGalleries().then((items) => items.map((item) => item.id));
}

export function setQueuedGalleries(items) {
  const normalizedItems = dedupeQueuedGalleries(items);
  return safeStorageSet({ [STORAGE_KEY]: normalizedItems });
}

export function setQueuedGalleryIds(ids) {
  const normalizedItems = Array.isArray(ids)
    ? ids.map((id) => {
        const normalizedId = normalizeGalleryId(id);
        return normalizedId ? { id: normalizedId, title: "" } : null;
      })
    : [];

  return setQueuedGalleries(normalizedItems);
}

export async function pruneQueuedGalleriesByIds(idsToRemove) {
  const removalSet = new Set(
    (Array.isArray(idsToRemove) ? idsToRemove : [])
      .map((id) => normalizeGalleryId(id))
      .filter(Boolean)
  );

  const existingItems = await getQueuedGalleries();
  if (!removalSet.size || !existingItems.length) {
    return {
      removed: 0,
      ids: existingItems.map((item) => item.id),
      items: existingItems
    };
  }

  const nextItems = existingItems.filter((item) => !removalSet.has(item.id));
  const removed = existingItems.length - nextItems.length;

  if (removed > 0) {
    const stored = await setQueuedGalleries(nextItems);
    if (!stored) {
      return {
        removed: 0,
        ids: existingItems.map((item) => item.id),
        items: existingItems,
        reason: "storage-failed"
      };
    }
  }

  return {
    removed,
    ids: nextItems.map((item) => item.id),
    items: nextItems
  };
}

export async function addGalleryToQueue(item) {
  const normalizedItem = normalizeQueuedGallery(item);
  if (!normalizedItem) {
    return { added: false, ids: await getQueuedGalleryIds(), reason: "invalid" };
  }

  const existingItems = await getQueuedGalleries();
  const existingIndex = existingItems.findIndex((existingItem) => existingItem.id === normalizedItem.id);

  if (existingIndex >= 0) {
    const nextItems = [...existingItems];
    const existingItem = nextItems[existingIndex];

    if (!existingItem.title && normalizedItem.title) {
      nextItems[existingIndex] = { ...existingItem, title: normalizedItem.title };
      const stored = await setQueuedGalleries(nextItems);
      if (!stored) {
        return {
          added: false,
          ids: existingItems.map((queuedItem) => queuedItem.id),
          items: existingItems,
          reason: "storage-failed"
        };
      }
      return {
        added: false,
        ids: nextItems.map((queuedItem) => queuedItem.id),
        items: nextItems,
        reason: "duplicate"
      };
    }

    return { added: false, ids: existingItems.map((queuedItem) => queuedItem.id), items: existingItems, reason: "duplicate" };
  }

  const nextItems = [...existingItems, normalizedItem];
  const stored = await setQueuedGalleries(nextItems);
  if (!stored) {
    return { added: false, ids: existingItems.map((queuedItem) => queuedItem.id), items: existingItems, reason: "storage-failed" };
  }
  return { added: true, ids: nextItems.map((queuedItem) => queuedItem.id), items: nextItems, reason: "added" };
}

export async function addGalleryIdToQueue(id) {
  return addGalleryToQueue({ id, title: "" });
}

export async function addGalleriesToQueue(items) {
  const existingItems = await getQueuedGalleries();
  const byId = new Map(existingItems.map((item) => [item.id, item]));
  const pageSeen = new Set();
  const newItems = [];
  let valid = 0;
  let invalid = 0;
  let duplicateCount = 0;

  const inputItems = Array.isArray(items) ? items : [];

  for (const value of inputItems) {
    const normalizedItem = normalizeQueuedGallery(value);
    if (!normalizedItem) {
      invalid += 1;
      continue;
    }

    valid += 1;

    if (pageSeen.has(normalizedItem.id)) {
      duplicateCount += 1;
      continue;
    }

    pageSeen.add(normalizedItem.id);

    if (byId.has(normalizedItem.id)) {
      duplicateCount += 1;

      const existingItem = byId.get(normalizedItem.id);
      if (!existingItem.title && normalizedItem.title) {
        byId.set(normalizedItem.id, { ...existingItem, title: normalizedItem.title });
      }

      continue;
    }

    byId.set(normalizedItem.id, normalizedItem);
    newItems.push(normalizedItem);
  }

  const nextItems = Array.from(byId.values());
  const shouldPersist =
    newItems.length > 0 ||
    nextItems.some((item, index) => {
      const existing = existingItems[index];
      return !existing || existing.id !== item.id || existing.title !== item.title;
    });

  if (shouldPersist) {
    const stored = await setQueuedGalleries(nextItems);
    if (!stored) {
      return {
        success: false,
        found: inputItems.length,
        valid,
        added: 0,
        skippedDuplicates: duplicateCount,
        invalid,
        ids: existingItems.map((item) => item.id),
        items: existingItems,
        message: "Failed to save queue locally.",
        reason: "storage-failed"
      };
    }
  }

  let message = "No valid gallery IDs found.";
  if (valid > 0 && newItems.length === 0) {
    message = `No new items queued, skipped ${duplicateCount} duplicate${duplicateCount === 1 ? "" : "s"}.`;
  } else if (newItems.length > 0) {
    message = `Queued ${newItems.length} new item${newItems.length === 1 ? "" : "s"}.`;
    if (duplicateCount > 0) {
      message += ` Skipped ${duplicateCount} duplicate${duplicateCount === 1 ? "" : "s"}.`;
    }
  }

  return {
    success: true,
    found: inputItems.length,
    valid,
    added: newItems.length,
    skippedDuplicates: duplicateCount,
    invalid,
    ids: nextItems.map((item) => item.id),
    items: nextItems,
    message
  };
}

export async function addGalleryIdsToQueue(ids) {
  return addGalleriesToQueue(Array.isArray(ids) ? ids.map((id) => ({ id, title: "" })) : []);
}

export async function removeGalleryIdFromQueue(id) {
  const normalizedId = normalizeGalleryId(id);
  const existingItems = await getQueuedGalleries();
  const existingIds = existingItems.map((item) => item.id);

  if (!normalizedId) {
    return { removed: false, ids: existingIds, reason: "invalid" };
  }

  const nextItems = existingItems.filter((queuedItem) => queuedItem.id !== normalizedId);
  if (nextItems.length === existingItems.length) {
    return { removed: false, ids: existingIds, reason: "missing" };
  }

  const stored = await setQueuedGalleries(nextItems);
  if (!stored) {
    return { removed: false, ids: existingIds, items: existingItems, reason: "storage-failed" };
  }
  return { removed: true, ids: nextItems.map((queuedItem) => queuedItem.id), items: nextItems, reason: "removed" };
}

export async function clearQueuedGalleryIds() {
  await setQueuedGalleryIds([]);
}
