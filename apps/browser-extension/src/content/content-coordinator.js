import {
  STORAGE_KEY,
  addGalleryToQueue,
  addGalleriesToQueue,
  clearQueuedGalleryIds,
  getQueuedGalleries,
  normalizeGalleryId,
  pruneQueuedGalleriesByIds,
  setQueuedGalleries,
  removeGalleryIdFromQueue
} from "../lib/queue";
import {
  OWNED_IDS_STORAGE_KEY,
  OWNED_SYNCED_AT_STORAGE_KEY,
  formatRelativeSyncTime,
  getOwnedGalleryIds,
  getOwnedSyncTimestamp
} from "../lib/owned";
import {
  isGalleryPath,
  isSupportedQueuePagePath
} from "../lib/page";
import { formatVersionMismatchMessage } from "../lib/version";
import { createCardStateController } from "./card-state";
import { CONTENT_STYLE_LINK_ID, ensureContentStyles } from "./content-style";

const CARD_SELECTOR = ".gallery";
const CARD_LINK_SELECTOR = "a.cover";
const BUTTON_CLASS = "ext-queue-btn";
const BUTTON_ATTR = "data-ext-queue-button";
const PAGE_BAR_ID = "ext-page-queue-bar";
const PAGE_BUTTON_ID = "ext-page-queue-button";
const PAGE_STATUS_ID = "ext-page-queue-status";
const FLOATING_PILL_ID = "ext-floating-queue-pill";
const FLOATING_PILL_TRIGGER_ID = "ext-floating-queue-pill-trigger";
const FLOATING_PILL_COUNT_ID = "ext-floating-queue-pill-count";
const FLOATING_PILL_ACTIONS_ID = "ext-floating-queue-pill-actions";
const FLOATING_PILL_CONNECTION_ID = "ext-floating-queue-pill-connection";
const FLOATING_PILL_SYNC_ID = "ext-floating-queue-pill-sync";
const FLOATING_PILL_LAST_SYNC_ID = "ext-floating-queue-pill-last-sync";
const FLOATING_PILL_LIST_ID = "ext-floating-queue-pill-list";
const FLOATING_PILL_SEND_ID = "ext-floating-queue-pill-send";
const FLOATING_PILL_CLEAR_ID = "ext-floating-queue-pill-clear";
const FLOATING_PILL_STATUS_ID = "ext-floating-queue-pill-status";
const FLOATING_PILL_SUMMARY_ID = "ext-floating-queue-pill-summary";
const FLOATING_PILL_COUNT_BUMP_ATTR = "data-bump";
const QUEUED_CARD_ATTR = "data-ext-queued";
const DOWNLOADED_CARD_ATTR = "data-ext-downloaded";
const PAGE_BAR_ATTR = "data-ext-page-queue-bar";
const INIT_ATTR = "data-ext-queue-initialized";

const RESULTS_WRAPPER_SELECTORS = [".container", ".index-container", "#content", "main", ".content"];
const RESULTS_GRID_SELECTORS = [".gallery-grid", ".galleries", ".gallery-list", "#favcontainer"];

const API_BASE_URL = 'http://localhost:8080/api';
const APP_STATUS_TIMEOUT_MS = 2500;

function reportNonFatalError(message, errorOrContext) {
  const detail = errorOrContext instanceof Error
    ? errorOrContext
    : errorOrContext && typeof errorOrContext === "object"
      ? errorOrContext
      : { detail: String(errorOrContext || "Unknown error") };

  console.warn("[Full Swing content]", message, detail);
}

function getPageHeadingText() {
  const selectors = ["h1", ".title", ".caption", ".name"];

  for (const selector of selectors) {
    const node = document.querySelector(selector);
    const text = node?.textContent?.replace(/\s+/g, " ").trim();
    if (text) return text;
  }

  return "";
}

function getPageContext() {
  const searchParams = new URLSearchParams(globalThis.location?.search || "");
  const pageParam = searchParams.get("page");
  const pageNumber = Number.parseInt(pageParam || "", 10);

  return {
    url: globalThis.location?.href || "",
    pathname: globalThis.location?.pathname || "/",
    search: globalThis.location?.search || "",
    page: Number.isFinite(pageNumber) && pageNumber > 0 ? pageNumber : null,
    title: document.title || "",
    heading: getPageHeadingText()
  };
}

function formatQueueCount(value) {
  return Number(value || 0).toLocaleString();
}

function formatAppActivity(snapshot) {
  if (!snapshot?.downloading || !snapshot?.current_job) {
    return "";
  }

  const title = String(snapshot.current_job.title || "Download in progress").trim();
  const currentPage = Number(snapshot.current_job.current_page || 0);
  const totalPages = Number(snapshot.current_job.total_pages || 0);

  return `Downloading: ${title} (${currentPage}/${totalPages})`;
}

async function fetchWithTimeout(url, options = {}, timeout = APP_STATUS_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeout);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    window.clearTimeout(timer);
  }
}

async function sendAppMessage(type, payload = {}) {
  if (!chrome?.runtime?.id) {
    return { success: false, message: "Extension context unavailable." };
  }

  try {
    return await chrome.runtime.sendMessage({ type, ...payload });
  } catch (error) {
    const message = error?.message || "Extension message failed.";
    if (!message.includes("Extension context invalidated")) {
      reportNonFatalError("Extension message failed", error);
    }
    return { success: false, message };
  }
}

function consumeQueueEvent(event) {
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation?.();
}

export function initializeContentScript() {
    if (document.documentElement?.hasAttribute(INIT_ATTR)) {
      return;
    }
    document.documentElement?.setAttribute(INIT_ATTR, "true");

    let queuedIds = new Set();
    let ownedIds = new Set();
    let appOnline = false;
    let appConnectionState = "offline";
    let clearStatusTimer = 0;
    let pillStatusTimer = 0;
    let clearConfirmTimer = 0;
    let ownedSyncTimer = 0;
    let scrollSyncTimer = 0;
    let appStatusTimer = 0;
    let lastSyncedAt = 0;
    let appActivityText = "";
    let lastOwnedSyncKey = "";
    let lastKnownUrl = globalThis.location?.href || "";
    let refreshTimer = 0;
    const pendingRefreshRoots = new Set();
    let domObserver = null;
    let isCleaningUp = false;
    const cleanupFunctions = [];

    const cardState = createCardStateController({
      getQueuedIds: () => queuedIds,
      setQueuedIds: (nextQueuedIds) => {
        queuedIds = nextQueuedIds;
      },
      getOwnedIds: () => ownedIds,
      setOwnedIds: (nextOwnedIds) => {
        ownedIds = nextOwnedIds;
      },
      getLastSyncedAt: () => lastSyncedAt,
      setLastSyncedAt: (nextLastSyncedAt) => {
        lastSyncedAt = nextLastSyncedAt;
      },
      handleQueueClick,
      consumeQueueEvent,
      reportNonFatalError
    });
    const {
      extractGalleryIdFromHref,
      getCardGalleryId,
      getCardQueueItem,
      setButtonState,
      setCardState,
      refreshAllCardStates,
      rebuildCardStates,
      scanAndInject
    } = cardState;

    function getVisibleCards() {
      return Array.from(document.querySelectorAll(CARD_SELECTOR)).filter(
        (card) => card instanceof HTMLElement && card.getClientRects().length > 0 && card.offsetParent !== null
      );
    }

    function getVisibleCardQueueItems() {
      return getVisibleCards().map(getCardQueueItem).filter(Boolean);
    }

    function getVisiblePageQueueItems() {
      const byId = new Map();

      for (const item of getVisibleCardQueueItems()) {
        const normalizedId = normalizeGalleryId(item?.id);
        if (!normalizedId || ownedIds.has(normalizedId)) continue;

        const normalizedTitle = typeof item?.title === "string" ? item.title.trim() : "";
        const existing = byId.get(normalizedId);
        if (!existing || (!existing.title && normalizedTitle)) {
          byId.set(normalizedId, { id: normalizedId, title: normalizedTitle });
        }
      }

      return Array.from(byId.values());
    }

    function getVisiblePageQueueSnapshot() {
      const items = getVisiblePageQueueItems();
      return {
        key: items.map((item) => item.id).join(","),
        items
      };
    }

    function wait(ms) {
      return new Promise((resolve) => {
        window.setTimeout(resolve, ms);
      });
    }

    async function waitForStableVisiblePageQueueItems() {
      let previousKey = "";
      let stableCount = 0;
      let latestItems = [];

      for (let attempt = 0; attempt < 6; attempt += 1) {
        await new Promise((resolve) => window.requestAnimationFrame(() => resolve()));

        const { key, items } = getVisiblePageQueueSnapshot();
        latestItems = items;

        if (key && key === previousKey) {
          stableCount += 1;
          if (stableCount >= 1) {
            return items;
          }
        } else {
          stableCount = 0;
          previousKey = key;
        }

        await wait(70);
      }

      return latestItems;
    }

    function getPathname() {
      return globalThis.location?.pathname || "/";
    }

    function isSupportedQueueSurfacePage() {
      return isSupportedResultsPage() || isGalleryPath(getPathname());
    }

    function isSupportedResultsPage() {
      const pathname = getPathname();

      const isHomeListing = pathname === "/";
      const isFavoritesRoute = pathname === "/user/favorites" || pathname === "/user/favorites/";
      const isSupportedRoute = isSupportedQueuePagePath(pathname) && !isGalleryPath(pathname);
      if (!isHomeListing && !isFavoritesRoute && !isSupportedRoute) return false;

      const visibleCards = getVisibleCards();
      if (visibleCards.length < 2) return false;

      if (isFavoritesRoute) {
        return visibleCards.some((card) => card.closest("#favcontainer"));
      }

      return visibleCards.some((card) => card.closest(".index-container, .container, .gallery-grid, .galleries, .gallery-list")) &&
        visibleCards.every((card) => !card.closest("#info, .gallerymedia, .cover-column"));
    }

    function findQueuePageAnchor() {
      if (!isSupportedResultsPage()) return null;

      const visibleCards = getVisibleCards();
      const firstCard = visibleCards[0];
      if (!(firstCard instanceof HTMLElement)) return null;

      const resultsGrid = firstCard.closest(RESULTS_GRID_SELECTORS.join(", "));
      if (resultsGrid instanceof HTMLElement && resultsGrid.parentElement instanceof HTMLElement) {
        const parentContainer = resultsGrid.parentElement;
        const outerContent =
          parentContainer.id === "content"
            ? parentContainer
            : parentContainer.parentElement instanceof HTMLElement && parentContainer.parentElement.id === "content"
              ? parentContainer.parentElement
              : null;

        if (outerContent instanceof HTMLElement) {
          const referenceNode = parentContainer.id === "content" ? resultsGrid : parentContainer;
          return {
            container: outerContent,
            referenceNode
          };
        }

        return {
          container: parentContainer,
          referenceNode: resultsGrid
        };
      }

      let resultsContainer = null;
      for (const selector of RESULTS_WRAPPER_SELECTORS) {
        const candidate = firstCard.closest(selector);
        if (
          candidate instanceof HTMLElement &&
          visibleCards.filter((card) => candidate.contains(card)).length >= Math.min(visibleCards.length, 2)
        ) {
          resultsContainer = candidate;
          break;
        }
      }

      if (!(resultsContainer instanceof HTMLElement)) return null;

      return {
        container: resultsContainer,
        referenceNode: firstCard
      };
    }

    function formatQueuePageMessage(result) {
      if (!result?.success) {
        return { tone: "error", message: result?.message || "Queue Page failed." };
      }

      if (result.removed > 0) {
        return {
          tone: "success",
          message: `Removed ${result.removed} item${result.removed === 1 ? "" : "s"} from this page.`
        };
      }

      if (result.added > 0) {
        let message = `Queued ${result.added} new item${result.added === 1 ? "" : "s"}`;
        if (result.skippedDuplicates > 0) {
          message += `, skipped ${result.skippedDuplicates} duplicate${result.skippedDuplicates === 1 ? "" : "s"}`;
        }
        return { tone: "success", message };
      }

      if (result.valid > 0 && result.skippedDuplicates > 0) {
        return {
          tone: "warning",
          message: "Everything on this page is already queued."
        };
      }

      return {
        tone: "warning",
        message: "No visible items found."
      };
    }

    function getPageQueueMode() {
      const visibleItems = getVisiblePageQueueItems();
      if (!visibleItems.length) return "queue";

      return visibleItems.every((item) => queuedIds.has(item.id)) ? "unqueue" : "queue";
    }

    function refreshPageQueueButton() {
      const button = document.getElementById(PAGE_BUTTON_ID);
      if (!(button instanceof HTMLButtonElement) || button.disabled) return;

      const mode = getPageQueueMode();
      button.dataset.mode = mode;
      button.textContent = mode === "unqueue" ? "Unqueue Page" : "Queue Page";
      button.setAttribute(
        "aria-label",
        mode === "unqueue" ? "Remove visible cards on this page from the queue" : "Queue visible cards on this page"
      );
    }

    function showPageStatus(message, tone = "neutral", persist = false) {
      const statusNode = document.getElementById(PAGE_STATUS_ID);
      if (!statusNode) return;

      statusNode.textContent = message;
      statusNode.dataset.tone = tone;
      statusNode.dataset.visible = "true";

      if (clearStatusTimer) {
        window.clearTimeout(clearStatusTimer);
        clearStatusTimer = 0;
      }

      if (!persist) {
        clearStatusTimer = window.setTimeout(() => {
          statusNode.textContent = "";
          statusNode.dataset.tone = "neutral";
          statusNode.dataset.visible = "false";
        }, 3200);
      }
    }

    function hidePageStatus() {
      const statusNode = document.getElementById(PAGE_STATUS_ID);
      if (!statusNode) return;

      if (clearStatusTimer) {
        window.clearTimeout(clearStatusTimer);
        clearStatusTimer = 0;
      }

      statusNode.textContent = "";
      statusNode.dataset.tone = "neutral";
      statusNode.dataset.visible = "false";
    }

    function openFloatingPill() {
      const pill = document.getElementById(FLOATING_PILL_ID);
      if (!(pill instanceof HTMLElement)) return;
      pill.dataset.open = "true";
    }

    function resetClearConfirmation() {
      const clearButton = document.getElementById(FLOATING_PILL_CLEAR_ID);
      if (!(clearButton instanceof HTMLButtonElement)) return;

      if (clearConfirmTimer) {
        window.clearTimeout(clearConfirmTimer);
        clearConfirmTimer = 0;
      }

      clearButton.dataset.confirming = "false";
      clearButton.title = "Clear queue";
      const clearLabel = clearButton.querySelector(".ext-floating-clear-label");
      if (clearLabel) {
        clearLabel.textContent = "Clear All";
      }
    }

    function closeFloatingPill() {
      const pill = document.getElementById(FLOATING_PILL_ID);
      if (!(pill instanceof HTMLElement)) return;

      pill.dataset.open = "false";
      resetClearConfirmation();
    }

    async function loadOwnedCache() {
      const [ids, syncedAt] = await Promise.all([getOwnedGalleryIds(), getOwnedSyncTimestamp()]);
      const pruneResult = await pruneQueuedGalleriesByIds(ids);
      ownedIds = new Set(ids);
      queuedIds = new Set(pruneResult.ids || []);
      lastSyncedAt = syncedAt || 0;
      return { ownedIds, removedFromQueue: Number(pruneResult.removed || 0) };
    }

    function showFloatingPillStatus(message, tone = "neutral", persist = false) {
      const statusNode = document.getElementById(FLOATING_PILL_STATUS_ID);
      if (!(statusNode instanceof HTMLElement)) return;

      openFloatingPill();
      statusNode.textContent = message;
      statusNode.dataset.tone = tone;
      statusNode.dataset.visible = "true";

      if (pillStatusTimer) {
        window.clearTimeout(pillStatusTimer);
        pillStatusTimer = 0;
      }

      if (!persist) {
        pillStatusTimer = window.setTimeout(() => {
          statusNode.textContent = "";
          statusNode.dataset.tone = "neutral";
          statusNode.dataset.visible = "false";
        }, 2600);
      }
    }

    function hideFloatingPillStatus() {
      const statusNode = document.getElementById(FLOATING_PILL_STATUS_ID);
      if (!(statusNode instanceof HTMLElement)) return;

      if (pillStatusTimer) {
        window.clearTimeout(pillStatusTimer);
        pillStatusTimer = 0;
      }

      statusNode.textContent = "";
      statusNode.dataset.tone = "neutral";
      statusNode.dataset.visible = "false";
    }

    function setFloatingPillBusy(action, busy) {
      const button = document.getElementById(action);
      if (!(button instanceof HTMLButtonElement)) return;
      button.disabled = busy;
    }

    function collectVisibleOwnedCheckIds() {
      const ids = new Set();

      const currentPath = globalThis.location?.pathname || "";
      const directMatch = currentPath.match(/\/g\/(\d+)\/?$/);
      const currentGalleryId = normalizeGalleryId(directMatch?.[1] || "");
      if (currentGalleryId) {
        ids.add(currentGalleryId);
      }

      document.querySelectorAll(CARD_SELECTOR).forEach((card) => {
        const link = card.querySelector(CARD_LINK_SELECTOR);
        const id = link ? extractGalleryIdFromHref(link.href) : null;
        if (id) {
          ids.add(id);
        }
      });

      return Array.from(ids);
    }

    async function syncOwnedState(force = false) {
      const currentUrl = globalThis.location?.href || "";
      const galleryIds = collectVisibleOwnedCheckIds();
      const syncKey = `${currentUrl}|${galleryIds.join(",")}|${lastSyncedAt}`;

      if (!force && syncKey === lastOwnedSyncKey) {
        return;
      }

      lastOwnedSyncKey = syncKey;
      await loadOwnedCache();
      refreshAllCardStates();
      refreshPageQueueButton();
      updateFloatingPillCount();
    }

    function scheduleOwnedStateSync(force = false) {
      if (ownedSyncTimer) {
        window.clearTimeout(ownedSyncTimer);
      }

      ownedSyncTimer = window.setTimeout(() => {
        ownedSyncTimer = 0;
        syncOwnedState(force).catch((error) => {
          reportNonFatalError("Failed to sync owned state", error);
        });
      }, force ? 0 : 300);
    }

    function updateFloatingPillMeta() {
      const connectionNode = document.getElementById(FLOATING_PILL_CONNECTION_ID);
      if (connectionNode instanceof HTMLElement) {
        connectionNode.textContent = "";
        const dot = document.createElement("span");
        dot.className = "ext-floating-queue-dot";
        dot.dataset.online = appConnectionState === "connected" ? "true" : appConnectionState === "version_mismatch" ? "warning" : "false";
        const text = document.createElement("span");
        text.textContent = appConnectionState === "connected" ? "Connected" : appConnectionState === "version_mismatch" ? "Version mismatch" : "Offline";
        connectionNode.append(dot, text);
      }

      const syncMeta = document.getElementById(FLOATING_PILL_LAST_SYNC_ID);
      if (syncMeta instanceof HTMLElement) {
        syncMeta.textContent = lastSyncedAt ? `Last synced: ${formatRelativeSyncTime(lastSyncedAt)}` : "Last synced: Never";
      }

      const summaryNode = document.getElementById(FLOATING_PILL_SUMMARY_ID);
      if (summaryNode instanceof HTMLElement) {
        summaryNode.textContent = appActivityText;
        summaryNode.title = appActivityText;
        summaryNode.dataset.visible = appActivityText ? "true" : "false";
      }

      const sendButton = document.getElementById(FLOATING_PILL_SEND_ID);
      if (sendButton instanceof HTMLButtonElement) {
        sendButton.disabled = appConnectionState !== "connected" || queuedIds.size === 0;
      }

      const syncButton = document.getElementById(FLOATING_PILL_SYNC_ID);
      if (syncButton instanceof HTMLButtonElement) {
        syncButton.disabled = appConnectionState !== "connected";
      }
    }

    async function refreshAppConnectionState() {
      try {
        const result = await sendAppMessage("nhq:app-status");
        if (result?.versionMismatch) {
          appOnline = false;
          appConnectionState = "version_mismatch";
          appActivityText = formatVersionMismatchMessage(result?.appVersion || result?.data?.version);
        } else {
          appOnline = Boolean(result?.success && result?.online);
          appConnectionState = appOnline ? "connected" : "offline";
          appActivityText = appOnline ? formatAppActivity(result?.data) : "";
        }
      } catch {
        appOnline = false;
        appConnectionState = "offline";
        appActivityText = "";
      }

      updateFloatingPillMeta();
      return appOnline;
    }

    async function renderFloatingPillQueueList() {
      const listNode = document.getElementById(FLOATING_PILL_LIST_ID);
      if (!(listNode instanceof HTMLElement)) return;

      const items = await getQueuedGalleries();
      listNode.textContent = "";

      if (!items.length) {
        const empty = document.createElement("div");
        empty.className = "ext-floating-queue-empty";
        empty.textContent = "No galleries queued";
        listNode.appendChild(empty);
        return;
      }

      items.forEach((item) => {
        const row = document.createElement("div");
        row.className = "ext-floating-queue-row";

        const text = document.createElement("div");
        text.className = "ext-floating-queue-row-text";

        const title = document.createElement("div");
        title.className = "ext-floating-queue-row-title";
        title.textContent = item.title || item.id;

        const meta = document.createElement("div");
        meta.className = "ext-floating-queue-row-id";
        meta.textContent = item.title ? item.id : "Queued";

        const removeButton = document.createElement("button");
        removeButton.type = "button";
        removeButton.className = "ext-floating-queue-remove";
        removeButton.setAttribute("aria-label", `Remove ${item.id} from queue`);
        removeButton.title = "Remove from queue";
        removeButton.appendChild(createTrashIcon());
        removeButton.addEventListener("click", async (event) => {
          consumeQueueEvent(event);
          await removeGalleryIdFromQueue(item.id);
          queuedIds.delete(item.id);
          refreshAllCardStates();
          refreshPageQueueButton();
          updateFloatingPillCount();
        });

        text.append(title, meta);
        row.append(text, removeButton);
        listNode.appendChild(row);
      });
    }

    function updateFloatingPillCount() {
      const countNode = document.getElementById(FLOATING_PILL_COUNT_ID);
      const trigger = document.getElementById(FLOATING_PILL_TRIGGER_ID);
      if (!(countNode instanceof HTMLElement) || !(trigger instanceof HTMLButtonElement)) return;

      const count = queuedIds.size;
      countNode.textContent = formatQueueCount(count);
      trigger.dataset.hasItems = count > 0 ? "true" : "false";
      countNode.setAttribute(FLOATING_PILL_COUNT_BUMP_ATTR, "false");
      window.requestAnimationFrame(() => {
        if (countNode.isConnected) {
          countNode.setAttribute(FLOATING_PILL_COUNT_BUMP_ATTR, "true");
          window.setTimeout(() => {
            if (countNode.isConnected) {
              countNode.setAttribute(FLOATING_PILL_COUNT_BUMP_ATTR, "false");
            }
          }, 220);
        }
      });
      trigger.setAttribute("aria-label", `Queued IDs: ${formatQueueCount(count)}`);
      updateFloatingPillMeta();
      renderFloatingPillQueueList().catch((error) => {
        const message = error?.message || "";
        if (!message.includes("Extension context invalidated")) {
          reportNonFatalError("Failed to render queue list", error);
        }
      });
    }

    async function handleSendToAppAction() {
      if (!queuedIds.size) {
        showFloatingPillStatus("Queue is empty", "warning");
        return { success: false, empty: true };
      }

      await refreshAppConnectionState();
      if (appConnectionState === "version_mismatch") {
        showFloatingPillStatus(appActivityText || "Version mismatch detected", "warning");
        return { success: false, versionMismatch: true };
      }
      if (!appOnline) {
        showFloatingPillStatus("App is offline", "warning");
        return { success: false, offline: true };
      }

      setFloatingPillBusy(FLOATING_PILL_SEND_ID, true);
      showFloatingPillStatus("Sending queue to app...", "neutral", true);

      try {
        const result = await sendAppMessage("nhq:send-to-app", {
          ids: Array.from(queuedIds)
        });

        if (!result?.success) {
          showFloatingPillStatus(result?.message || "Send to App failed.", "error");
          return { success: false };
        }

        showFloatingPillStatus(result?.message || `Sent ${formatQueueCount(queuedIds.size)} IDs`, "success");
        return { success: true };
      } catch (error) {
        reportNonFatalError("Failed to send queue to app", error);
        showFloatingPillStatus("Send to App failed.", "error");
        return { success: false };
      } finally {
        setFloatingPillBusy(FLOATING_PILL_SEND_ID, false);
      }
    }

    async function handleSyncLibraryAction() {
      await refreshAppConnectionState();
      if (appConnectionState === "version_mismatch") {
        showFloatingPillStatus(appActivityText || "Version mismatch detected", "warning");
        return { success: false, versionMismatch: true };
      }
      if (!appOnline) {
        showFloatingPillStatus("App is offline", "warning");
        return { success: false, offline: true };
      }

      setFloatingPillBusy(FLOATING_PILL_SYNC_ID, true);
      showFloatingPillStatus("Syncing library...", "neutral", true);

      try {
        const result = await sendAppMessage("nhq:sync-library");
        if (!result?.success) {
          showFloatingPillStatus(result?.message || "Library sync failed.", "error");
          return { success: false };
        }

        // The background script owns sync writes. UI updates flow through storage.onChanged.
        const removedFromQueue = Number(result.removedFromQueue || 0);
        showFloatingPillStatus(
          removedFromQueue > 0
            ? `Synced ${formatQueueCount(result.count || 0)} owned IDs • removed ${formatQueueCount(removedFromQueue)} from queue`
            : `Synced ${formatQueueCount(result.count || 0)} owned IDs`,
          "success"
        );
        return { success: true };
      } catch (error) {
        reportNonFatalError("Failed to sync library", error);
        showFloatingPillStatus(error?.message || "Library sync failed.", "error");
        return { success: false };
      } finally {
        setFloatingPillBusy(FLOATING_PILL_SYNC_ID, false);
      }
    }

    async function handleClearQueueAction() {
      if (!queuedIds.size) {
        return { success: false, empty: true };
      }

      const clearButton = document.getElementById(FLOATING_PILL_CLEAR_ID);
      if (!(clearButton instanceof HTMLButtonElement)) return { success: false };

      if (clearButton.dataset.confirming !== "true") {
        clearButton.dataset.confirming = "true";
        clearButton.title = "Click again to confirm";
        const clearLabel = clearButton.querySelector(".ext-floating-clear-label");
        if (clearLabel) {
          clearLabel.textContent = "Confirm";
        }

        if (clearConfirmTimer) {
          window.clearTimeout(clearConfirmTimer);
        }

        clearConfirmTimer = window.setTimeout(() => {
          resetClearConfirmation();
        }, 3000);

        return { success: false, pending: true };
      }

      clearButton.disabled = true;
      hideFloatingPillStatus();

      try {
        await clearQueuedGalleryIds();
        queuedIds = new Set();
        refreshAllCardStates();
        refreshPageQueueButton();
        updateFloatingPillCount();
        showFloatingPillStatus("Queue cleared", "success");
        return { success: true };
      } catch (error) {
        reportNonFatalError("Failed to clear queue", error);
        showFloatingPillStatus("Queue clear failed.", "error");
        return { success: false };
      } finally {
        clearButton.disabled = false;
        resetClearConfirmation();
      }
    }

    function createSVGElement(tag, attributes = {}) {
      const element = document.createElementNS("http://www.w3.org/2000/svg", tag);
      Object.entries(attributes).forEach(([key, value]) => {
        element.setAttribute(key, value);
      });
      return element;
    }

    function createSVGIcon(viewBoxPaths) {
      const svg = createSVGElement("svg", {
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        "stroke-width": "1.8",
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
        "aria-hidden": "true"
      });

      viewBoxPaths.forEach(pathData => {
        const path = createSVGElement("path", { d: pathData });
        svg.appendChild(path);
      });

      return svg;
    }

    function createQueueIcon() {
      return createSVGIcon(["M12 5v14M5 12h14"]);
    }

    function createSendIcon() {
      return createSVGIcon([
        "M22 2 11 13",
        "M22 2 15 22l-4-9-9-4z"
      ]);
    }

    function createSyncIcon() {
      return createSVGIcon([
        "M21 12a9 9 0 1 1-2.64-6.36",
        "M21 3v6h-6"
      ]);
    }

    function createTrashIcon() {
      return createSVGIcon([
        "M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 13a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6"
      ]);
    }

    function removeFloatingPill() {
      document.getElementById(FLOATING_PILL_ID)?.remove();
      hideFloatingPillStatus();
      resetClearConfirmation();
    }

    function injectFloatingPill() {
      if (!isSupportedQueueSurfacePage()) {
        removeFloatingPill();
        return;
      }

      let pill = document.getElementById(FLOATING_PILL_ID);
      if (!(pill instanceof HTMLElement)) {
        pill = document.createElement("section");
        pill.id = FLOATING_PILL_ID;
        pill.dataset.open = "false";

        const trigger = document.createElement("button");
        trigger.id = FLOATING_PILL_TRIGGER_ID;
        trigger.type = "button";
        trigger.setAttribute("aria-label", "Queue");
        trigger.setAttribute("aria-expanded", "false");
        trigger.appendChild(createQueueIcon());

        const countSpan = document.createElement("span");
        countSpan.id = FLOATING_PILL_COUNT_ID;
        countSpan.textContent = "0";
        trigger.appendChild(countSpan);
        trigger.addEventListener("click", (event) => {
          consumeQueueEvent(event);
          const isOpen = pill.dataset.open === "true";
          pill.dataset.open = isOpen ? "false" : "true";
          trigger.setAttribute("aria-expanded", isOpen ? "false" : "true");
          if (!isOpen) {
            resetClearConfirmation();
            refreshAppConnectionState();
            updateFloatingPillCount();
          }
        });

        const actions = document.createElement("div");
        actions.id = FLOATING_PILL_ACTIONS_ID;

        const connectionRow = document.createElement("div");
        connectionRow.className = "ext-floating-queue-connection";

        const connectionNode = document.createElement("div");
        connectionNode.id = FLOATING_PILL_CONNECTION_ID;

        const syncButton = document.createElement("button");
        syncButton.id = FLOATING_PILL_SYNC_ID;
        syncButton.type = "button";
        syncButton.setAttribute("aria-label", "Sync library");
        syncButton.title = "Sync library";
        syncButton.appendChild(createSyncIcon());
        syncButton.addEventListener("click", (event) => {
          consumeQueueEvent(event);
          handleSyncLibraryAction();
        });

        connectionRow.append(connectionNode, syncButton);

        const syncMeta = document.createElement("div");
        syncMeta.id = FLOATING_PILL_LAST_SYNC_ID;

        const summary = document.createElement("div");
        summary.id = FLOATING_PILL_SUMMARY_ID;
        summary.dataset.visible = "false";
        summary.setAttribute("aria-live", "polite");

        const list = document.createElement("div");
        list.id = FLOATING_PILL_LIST_ID;

        const actionRow = document.createElement("div");
        actionRow.className = "ext-floating-queue-actions-row";

        const sendButton = document.createElement("button");
        sendButton.id = FLOATING_PILL_SEND_ID;
        sendButton.type = "button";
        sendButton.setAttribute("aria-label", "Send queue to app");
        sendButton.title = "Send queue to app";
        sendButton.appendChild(createSendIcon());
        const sendLabel = document.createElement("span");
        sendLabel.textContent = "Send to App";
        sendButton.appendChild(sendLabel);
        sendButton.addEventListener("click", (event) => {
          consumeQueueEvent(event);
          handleSendToAppAction();
        });

        const clearButton = document.createElement("button");
        clearButton.id = FLOATING_PILL_CLEAR_ID;
        clearButton.type = "button";
        clearButton.setAttribute("aria-label", "Clear queue");
        clearButton.title = "Clear queue";
        clearButton.dataset.confirming = "false";
        clearButton.appendChild(createTrashIcon());
        const clearLabel = document.createElement("span");
        clearLabel.className = "ext-floating-clear-label";
        clearLabel.textContent = "Clear All";
        clearButton.appendChild(clearLabel);
        clearButton.addEventListener("click", (event) => {
          consumeQueueEvent(event);
          handleClearQueueAction();
        });

        actionRow.append(sendButton, clearButton);

        const status = document.createElement("div");
        status.id = FLOATING_PILL_STATUS_ID;
        status.dataset.tone = "neutral";
        status.dataset.visible = "false";
        status.setAttribute("aria-live", "polite");

        actions.append(connectionRow, syncMeta, summary, list, actionRow, status);
        pill.append(trigger, actions);
        document.body.appendChild(pill);
      }

      updateFloatingPillCount();
    }

    function installFloatingPillDismissHandler() {
      const handlePointerDown = (event) => {
        const pill = document.getElementById(FLOATING_PILL_ID);
        if (!(pill instanceof HTMLElement) || pill.dataset.open !== "true") return;

        if (event.target instanceof Node && pill.contains(event.target)) {
          return;
        }

        closeFloatingPill();
      };

      const handleMouseLeave = () => {
        const pill = document.getElementById(FLOATING_PILL_ID);
        if (!(pill instanceof HTMLElement) || pill.dataset.open !== "true") return;
        closeFloatingPill();
      };

      document.addEventListener("pointerdown", handlePointerDown);
      document.addEventListener("mouseleave", handleMouseLeave);

      // Add cleanup function
      cleanupFunctions.push(() => {
        document.removeEventListener("pointerdown", handlePointerDown);
        document.removeEventListener("mouseleave", handleMouseLeave);
      });
    }

    async function queueVisiblePage() {
      const visibleItems = await waitForStableVisiblePageQueueItems();
      if (!visibleItems.length) {
        return {
          success: true,
          found: 0,
          valid: 0,
          added: 0,
          removed: 0,
          skippedDownloaded: 0,
          skippedDuplicates: 0,
          invalid: 0,
          ids: Array.from(queuedIds),
          message: "No visible items found."
        };
      }

      const visibleIds = visibleItems.map((item) => item.id);
      const allVisibleAlreadyQueued = visibleIds.every((id) => queuedIds.has(id));
      let result;

      if (allVisibleAlreadyQueued) {
        const existingItems = await getQueuedGalleries();
        const nextItems = existingItems.filter((item) => !visibleIds.includes(item.id));
        await setQueuedGalleries(nextItems);
        result = {
          success: true,
          found: visibleItems.length,
          valid: visibleItems.length,
          added: 0,
          removed: visibleIds.length,
          skippedDownloaded: 0,
          skippedDuplicates: 0,
          invalid: 0,
          ids: nextItems.map((item) => item.id),
          items: nextItems,
          message: `Removed ${visibleIds.length} item${visibleIds.length === 1 ? "" : "s"} from this page.`
        };
      } else {
        result = await addGalleriesToQueue(visibleItems);
        result.found = visibleItems.length;
        result.removed = 0;
      }

      queuedIds = new Set(result.ids);
      scanAndInject(document);
      refreshAllCardStates();
      refreshPageQueueButton();
      updateFloatingPillCount();
      return result;
    }

    async function handleQueueClick(event) {
      consumeQueueEvent(event);

      const button = event.currentTarget;
      const card = button.closest(CARD_SELECTOR);
      if (!card) return;

      const galleryId = getCardGalleryId(card);
      if (!galleryId) {
        reportNonFatalError("Unable to extract gallery ID for card", card);
        setButtonState(button, "Error", "error", false);
        return;
      }

      button.dataset.state = "working";
      button.textContent = queuedIds.has(galleryId) ? "Removing" : "Saving";

      if (ownedIds.has(galleryId)) {
        setCardState(card, "downloaded");
        return;
      }

      if (queuedIds.has(galleryId)) {
        const result = await removeGalleryIdFromQueue(galleryId);
        queuedIds = new Set(result.ids);
        updateFloatingPillCount();
        if (result.removed) {
          setCardState(card, "idle");
          return;
        }

        setButtonState(button, "Error", "error", false);
        return;
      }

      const result = await addGalleryToQueue(getCardQueueItem(card) || { id: galleryId, title: "" });
      queuedIds = new Set(result.ids);
      updateFloatingPillCount();

      if (result.added || result.reason === "duplicate") {
        setCardState(card, "queued");
        return;
      }

      setButtonState(button, "Error", "error", false);
    }

    async function handlePageQueueClick() {
      const button = document.getElementById(PAGE_BUTTON_ID);
      if (!(button instanceof HTMLButtonElement)) return;

      button.disabled = true;
      button.textContent = getPageQueueMode() === "unqueue" ? "Unqueueing..." : "Queueing...";
      hidePageStatus();

      try {
        const result = await queueVisiblePage();
        const summary = formatQueuePageMessage(result);
        if (summary.tone === "error") {
          showPageStatus(summary.message, summary.tone, false);
        } else {
          hidePageStatus();
        }
      } catch (error) {
        reportNonFatalError("Failed to queue current page", error);
        showPageStatus("Queue Page failed.", "error", false);
      } finally {
        button.disabled = false;
        refreshPageQueueButton();
      }
    }

    function removeQueuePageBar() {
      document.getElementById(PAGE_BAR_ID)?.remove();
    }

    function injectQueuePageButton() {
      const anchor = findQueuePageAnchor();
      if (!anchor) {
        removeQueuePageBar();
        return;
      }

      let panel = document.getElementById(PAGE_BAR_ID);
      if (!(panel instanceof HTMLElement)) {
        panel = document.createElement("section");
        panel.id = PAGE_BAR_ID;
        panel.setAttribute(PAGE_BAR_ATTR, "true");

        const button = document.createElement("button");
        button.id = PAGE_BUTTON_ID;
        button.type = "button";
        button.textContent = "Queue Page";
        button.setAttribute("aria-label", "Queue visible cards on this page");
        button.addEventListener("click", handlePageQueueClick);

        const status = document.createElement("div");
        status.id = PAGE_STATUS_ID;
        status.dataset.tone = "neutral";
        status.dataset.visible = "false";
        status.setAttribute("aria-live", "polite");

        panel.append(button, status);
      }

      // Insert before the index-container (outside of it, in the parent)
      if (panel.parentElement !== anchor.container || panel.nextSibling !== anchor.referenceNode) {
        anchor.container.insertBefore(panel, anchor.referenceNode);
      }

      refreshPageQueueButton();
    }

    function scheduleRefresh(root = null, forceFullScan = false) {
      if (isCleaningUp) return;
      if (root instanceof Element || root instanceof Document) {
        pendingRefreshRoots.add(root);
      }
      if (forceFullScan) {
        pendingRefreshRoots.add(document);
      }
      if (refreshTimer) {
        window.clearTimeout(refreshTimer);
      }

      refreshTimer = window.setTimeout(() => {
        refreshTimer = 0;
        if (isCleaningUp) return;

        const currentUrl = globalThis.location?.href || "";
        const urlChanged = currentUrl !== lastKnownUrl;
        if (urlChanged) {
          lastKnownUrl = currentUrl;
          lastOwnedSyncKey = "";
          pendingRefreshRoots.add(document);
        }

        pendingRefreshRoots.forEach((rootNode) => scanAndInject(rootNode));
        pendingRefreshRoots.clear();
        refreshAllCardStates();
        injectQueuePageButton();
        injectFloatingPill();
        scheduleOwnedStateSync(urlChanged);
      }, 300);
    }

    function observeDomChanges() {
      if (domObserver || !(document.body instanceof HTMLBodyElement)) return;

      domObserver = new MutationObserver((mutations) => {
        let shouldRefresh = false;

        for (const mutation of mutations) {
          for (const node of mutation.addedNodes) {
            if (!(node instanceof Element)) continue;
            if (node.id === FLOATING_PILL_ID || node.id === PAGE_BAR_ID || node.id === CONTENT_STYLE_LINK_ID) continue;
            if (node.matches?.(`.${BUTTON_CLASS}`) || node.hasAttribute?.(PAGE_BAR_ATTR) || node.id === FLOATING_PILL_ID) continue;
            if (node.closest?.(`#${FLOATING_PILL_ID}`) || node.closest?.(`#${PAGE_BAR_ID}`) || node.closest?.(`.${BUTTON_CLASS}`)) continue;
            pendingRefreshRoots.add(node);
            shouldRefresh = true;
          }

          for (const node of mutation.removedNodes) {
            if (!(node instanceof Element)) continue;
            if (node.id === FLOATING_PILL_ID || node.id === PAGE_BAR_ID || node.id === CONTENT_STYLE_LINK_ID) continue;
            if (node.matches?.(`.${BUTTON_CLASS}`) || node.hasAttribute?.(PAGE_BAR_ATTR)) continue;
            if (node.closest?.(`#${FLOATING_PILL_ID}`) || node.closest?.(`#${PAGE_BAR_ID}`)) continue;
            shouldRefresh = true;
          }
        }

        if (shouldRefresh) {
          scheduleRefresh(null, false);
        }
      });

      domObserver.observe(document.body, {
        childList: true,
        subtree: true
      });
    }

    function cleanup() {
      isCleaningUp = true;

      if (domObserver) {
        domObserver.disconnect();
        domObserver = null;
      }

      // Clear all timers
      clearTimeout(clearStatusTimer);
      clearTimeout(pillStatusTimer);
      clearTimeout(clearConfirmTimer);
      clearTimeout(ownedSyncTimer);
      clearTimeout(scrollSyncTimer);
      clearTimeout(refreshTimer);

      // Remove all event listeners
      cleanupFunctions.forEach(fn => {
        try {
          fn();
        } catch (error) {
          reportNonFatalError("Error in cleanup function", error);
        }
      });
      cleanupFunctions.length = 0;
      document.documentElement?.removeAttribute(INIT_ATTR);
    }

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      try {
        if (message?.type === "nhq:get-page-context") {
          sendResponse({
            success: true,
            context: getPageContext()
          });
          return;
        }

        if (message?.type === "nhq:clear-queue") {
          handleClearQueueAction().then(sendResponse).catch(error => {
            reportNonFatalError("Failed to clear queue", error);
            sendResponse({ success: false, error: error.message });
          });
          return true;
        }

        if (message?.type === "nhq:queue-page") {
          queueVisiblePage()
            .then((result) => {
              const summary = formatQueuePageMessage(result);
              if (result.added > 0 || result.removed > 0) {
                hidePageStatus();
              } else {
                showPageStatus(summary.message, summary.tone, false);
              }
              sendResponse(result);
            })
            .catch((error) => {
              reportNonFatalError("Failed to queue current page", error);
              showPageStatus("Queue Page failed.", "error", false);
              sendResponse({
                success: false,
                found: 0,
                valid: 0,
                added: 0,
                skippedDuplicates: 0,
                invalid: 0,
                message: "Queue Page failed."
              });
            });
          return true;
        }

        if (message?.type === "nhq:owned-sync-complete") {
          // Background owns storage writes; this message only confirms delivery.
          sendResponse({
            success: true,
            removedFromQueue: Number(message?.removedFromQueue || 0)
          });
          return;
        }
      } catch (error) {
        reportNonFatalError("Error handling message", error);
        sendResponse({ success: false, error: error.message });
      }
    });

    async function checkAppOwnedGalleries(galleryIds = collectVisibleOwnedCheckIds()) {
      await loadOwnedCache();
      if (!lastSyncedAt || galleryIds.length === 0) {
        return new Set();
      }

      return new Set(galleryIds.filter((id) => ownedIds.has(id)));
    }

    async function init() {
      ensureContentStyles();

      queuedIds = new Set((await getQueuedGalleries()).map((item) => item.id));
      await loadOwnedCache();
      lastKnownUrl = globalThis.location?.href || "";
      await refreshAppConnectionState();

      appStatusTimer = window.setInterval(() => {
        const pill = document.getElementById(FLOATING_PILL_ID);
        const shouldRefresh = document.visibilityState === "visible" || (pill instanceof HTMLElement && pill.dataset.open === "true");
        if (!shouldRefresh) {
          return;
        }

        refreshAppConnectionState().catch((error) => {
          reportNonFatalError("Failed to refresh app status", error);
        });
      }, 5000);

      cleanupFunctions.push(() => window.clearInterval(appStatusTimer));

      scanAndInject(document);
      injectQueuePageButton();
      injectFloatingPill();
      installFloatingPillDismissHandler();
      observeDomChanges();
      refreshAllCardStates();
      scheduleOwnedStateSync(true);

      const handleBeforeUnload = () => cleanup();
      const handleScroll = () => {
        if (scrollSyncTimer) {
          window.clearTimeout(scrollSyncTimer);
        }

        scrollSyncTimer = window.setTimeout(() => {
          scrollSyncTimer = 0;
          scheduleRefresh(null);
        }, 500);
      };

      const handleStorageChange = (changes, areaName) => {
        try {
          if (areaName !== "local") return;
          if (!changes[STORAGE_KEY] && !changes[OWNED_IDS_STORAGE_KEY] && !changes[OWNED_SYNCED_AT_STORAGE_KEY]) return;

          // rebuildCardStates reads both owned and queued atomically from storage
          // so it always sees a consistent state regardless of write ordering.
          lastOwnedSyncKey = "";
          rebuildCardStates()
            .then(() => {
              refreshPageQueueButton();
              injectQueuePageButton();
              injectFloatingPill();
              void renderFloatingPillQueueList();
            })
            .catch((error) => {
              reportNonFatalError("Failed to rebuild card states", error);
            });
        } catch (error) {
          reportNonFatalError("Failed to handle storage change", error);
        }
      };

      window.addEventListener("beforeunload", handleBeforeUnload);
      window.addEventListener("scroll", handleScroll, { passive: true });
      chrome.storage.onChanged.addListener(handleStorageChange);

      cleanupFunctions.push(() => window.removeEventListener("beforeunload", handleBeforeUnload));
      cleanupFunctions.push(() => window.removeEventListener("scroll", handleScroll));
      cleanupFunctions.push(() => chrome.storage.onChanged.removeListener(handleStorageChange));
    }

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", init, { once: true });
    } else {
      init();
    }
}
