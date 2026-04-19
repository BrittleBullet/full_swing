import { pruneQueuedGalleriesByIds } from "../src/lib/queue";
import { setOwnedGalleryState } from "../src/lib/owned";

const API_BASE_CANDIDATES = ["http://127.0.0.1:8080/api", "http://localhost:8080/api"];
const APP_STATUS_TIMEOUT_MS = 500;
const OWNED_CHECK_TIMEOUT_MS = 3000;
const SYNC_TIMEOUT_MS = 5000;
const SEND_QUEUE_TIMEOUT_MS = 20000;

let preferredApiBase = API_BASE_CANDIDATES[0];

function reportNonFatalError(message, error) {
  return {
    message,
    detail: error?.message || String(error || "Unknown error")
  };
}

async function fetchJson(path, options = {}, timeout = SYNC_TIMEOUT_MS) {
  const candidates = [preferredApiBase, ...API_BASE_CANDIDATES.filter((value) => value !== preferredApiBase)];

  for (const baseUrl of candidates) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(`${baseUrl}${path}`, {
        ...options,
        signal: controller.signal
      });

      const text = await response.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = text;
      }

      preferredApiBase = baseUrl;
      return { ok: response.ok, status: response.status, data };
    } catch {
      // Try the next loopback candidate.
    } finally {
      clearTimeout(timer);
    }
  }

  return { ok: false, status: 0, data: null };
}

export default defineBackground(() => {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message?.type?.startsWith("nhq:")) {
      return undefined;
    }

    (async () => {
      if (message.type === "nhq:app-status") {
        const result = await fetchJson("/status", {}, APP_STATUS_TIMEOUT_MS);
        sendResponse({
          success: result.ok,
          online: result.ok && result.data?.running !== false,
          data: result.data
        });
        return;
      }

      if (message.type === "nhq:sync-library") {
        const result = await fetchJson("/owned/ids", {}, SYNC_TIMEOUT_MS);
        const ids = Array.isArray(result.data)
          ? result.data.map((id) => String(id).trim()).filter(Boolean)
          : [];
        const syncedAt = Date.now();

        let removedFromQueue = 0;

        if (result.ok) {
          const stored = await setOwnedGalleryState(ids, syncedAt);
          if (!stored) {
            sendResponse({
              success: false,
              online: true,
              count: 0,
              syncedAt,
              ids: [],
              removedFromQueue: 0,
              message: "Failed to update extension cache."
            });
            return;
          }

          const pruneResult = await pruneQueuedGalleriesByIds(ids);
          removedFromQueue = Number(pruneResult?.removed || 0);
        }

        sendResponse({
          success: result.ok,
          online: result.ok,
          count: ids.length,
          syncedAt,
          ids,
          removedFromQueue
        });
        return;
      }

      if (message.type === "nhq:send-to-app") {
        const ids = Array.isArray(message.ids) ? message.ids : [];

        const queueResult = await fetchJson(
          "/queue",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ids })
          },
          SEND_QUEUE_TIMEOUT_MS
        );

        if (!queueResult.ok) {
          sendResponse({
            success: false,
            message: typeof queueResult.data === "string" ? queueResult.data : "Send to App failed."
          });
          return;
        }

        const downloadResult = await fetchJson(
          "/download/start",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" }
          },
          10000
        );

        if (!downloadResult.ok) {
          sendResponse({
            success: false,
            message: "Queued in app, but failed to start download."
          });
          return;
        }

        const added = Number(queueResult.data?.added || 0);
        const skippedOwned = Number(queueResult.data?.skipped_owned || 0);
        const skippedDuplicate = Number(queueResult.data?.skipped_duplicate || 0);

        let statusMessage = `Queued ${ids.length} ID${ids.length === 1 ? "" : "s"} and started download.`;
        if (added === 0) {
          statusMessage = "No new items were added to the app queue.";
        } else if (skippedOwned > 0 || skippedDuplicate > 0) {
          statusMessage = `Added ${added} new item${added === 1 ? "" : "s"}; skipped ${skippedOwned + skippedDuplicate}.`;
        }

        sendResponse({
          success: true,
          message: statusMessage,
          queue: queueResult.data,
          download: downloadResult.data
        });
        return;
      }

      sendResponse({ success: false, message: "Unsupported action." });
    })().catch((error) => {
      const reported = reportNonFatalError("Background request failed", error);
      sendResponse({
        success: false,
        message: reported.detail || reported.message
      });
    });

    return true;
  });
});
