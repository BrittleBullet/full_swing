import { useEffect, useMemo, useState } from "react";

import {
  STORAGE_KEY,
  clearQueuedGalleryIds,
  getQueuedGalleries,
  pruneQueuedGalleriesByIds,
  removeGalleryIdFromQueue
} from "../../src/lib/queue";
import {
  OWNED_IDS_STORAGE_KEY,
  OWNED_SYNCED_AT_STORAGE_KEY,
  formatRelativeSyncTime,
  getOwnedGalleryIds,
  getOwnedSyncTimestamp
} from "../../src/lib/owned";
import { formatVersionMismatchMessage } from "../../src/lib/version";

const DEFAULT_STATUS = { tone: "neutral", message: "Queue ready." };
const CONNECTION_STATES = {
  OFFLINE: "offline",
  CONNECTED: "connected",
  VERSION_MISMATCH: "version_mismatch"
};

function reportNonFatalError(_message, _error) {}

function iconProps(className = "h-4 w-4") {
  return {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.8",
    strokeLinecap: "round",
    strokeLinejoin: "round",
    className,
    "aria-hidden": "true"
  };
}

function SendIcon({ className }) {
  return (
    <svg {...iconProps(className)}>
      <path d="M22 2 11 13" />
      <path d="M22 2 15 22l-4-9-9-4z" />
    </svg>
  );
}

function TrashIcon({ className }) {
  return (
    <svg {...iconProps(className)}>
      <path d="M3 6h18" />
      <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
      <path d="m19 6-1 13a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </svg>
  );
}

function SyncIcon({ className }) {
  return (
    <svg {...iconProps(className)}>
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v6h-6" />
    </svg>
  );
}

function LinkIcon({ className }) {
  return (
    <svg {...iconProps(className)}>
      <path d="M10 13a5 5 0 0 0 7.07 0l2.83-2.83a5 5 0 0 0-7.07-7.07L11 4" />
      <path d="M14 11a5 5 0 0 0-7.07 0L4.1 13.83a5 5 0 0 0 7.07 7.07L13 19" />
    </svg>
  );
}

function XIcon({ className }) {
  return (
    <svg {...iconProps(className)}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

function Spinner({ className = "h-4 w-4" }) {
  return (
    <svg className={`${className} animate-spin`} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" fill="none" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" fill="none" />
    </svg>
  );
}

function toneClasses(tone) {
  if (tone === "success") return "border-emerald-500/30 bg-emerald-500/10 text-[var(--ext-text)]";
  if (tone === "warning") return "border-amber-400/30 bg-amber-400/10 text-[var(--ext-text)]";
  if (tone === "error") return "border-[var(--ext-accent)]/35 bg-[var(--ext-accent-soft)] text-[var(--ext-text)]";
  if (tone === "loading") return "border-white/8 bg-white/4 text-[var(--ext-muted)]";
  return "border-white/8 bg-white/4 text-[var(--ext-muted)]";
}

async function sendMessage(type, payload = {}) {
  return chrome.runtime.sendMessage({ type, ...payload });
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

export default function App() {
  const [queuedItems, setQueuedItems] = useState([]);
  const [status, setStatus] = useState(DEFAULT_STATUS);
  const [busyAction, setBusyAction] = useState("");
  const [removingId, setRemovingId] = useState("");
  const [connectionState, setConnectionState] = useState(CONNECTION_STATES.OFFLINE);
  const [appVersion, setAppVersion] = useState("");
  const [lastSyncedAt, setLastSyncedAt] = useState(0);
  const [appActivity, setAppActivity] = useState("");

  useEffect(() => {
    let mounted = true;

    async function loadQueue() {
      const ownedIds = await getOwnedGalleryIds();
      await pruneQueuedGalleriesByIds(ownedIds);
      const items = await getQueuedGalleries();
      if (mounted) {
        setQueuedItems(items);
      }
    }

    async function loadSyncState() {
      const syncedAt = await getOwnedSyncTimestamp();
      if (mounted) {
        setLastSyncedAt(syncedAt);
      }
    }

    async function refreshConnection(includeSnapshot = false) {
      try {
        const response = await sendMessage("nhq:app-status");
        if (mounted) {
          const online = Boolean(response?.success && response?.online);
          const nextAppVersion = String(response?.appVersion || response?.data?.version || "").trim();
          const mismatchMessage = formatVersionMismatchMessage(nextAppVersion);

          setAppVersion(nextAppVersion);

          if (response?.versionMismatch) {
            setConnectionState(CONNECTION_STATES.VERSION_MISMATCH);
            setAppActivity(mismatchMessage);
            setStatus((current) => current.tone === "loading" && !includeSnapshot ? current : { tone: "warning", message: mismatchMessage });
            return;
          }

          setConnectionState(online ? CONNECTION_STATES.CONNECTED : CONNECTION_STATES.OFFLINE);
          setAppActivity(online ? formatAppActivity(response?.data) : "");
          setStatus((current) => current.tone === "warning" ? DEFAULT_STATUS : current);
        }
      } catch {
        if (mounted) {
          setConnectionState(CONNECTION_STATES.OFFLINE);
          setAppVersion("");
          setAppActivity("");
          setStatus((current) => current.tone === "warning" ? DEFAULT_STATUS : current);
        }
      }
    }

    loadQueue();
    loadSyncState();
    refreshConnection(true);

    const interval = window.setInterval(() => refreshConnection(false), 5000);
    const syncTicker = window.setInterval(() => {
      if (mounted) {
        setLastSyncedAt((value) => value || 0);
      }
    }, 60000);

    const handleStorage = (changes, areaName) => {
      if (areaName !== "local") return;
      if (changes[STORAGE_KEY]) {
        loadQueue();
      }
      if (changes[OWNED_IDS_STORAGE_KEY] || changes[OWNED_SYNCED_AT_STORAGE_KEY]) {
        loadSyncState();
        loadQueue();
      }
    };

    chrome.storage.onChanged.addListener(handleStorage);
    return () => {
      mounted = false;
      window.clearInterval(interval);
      window.clearInterval(syncTicker);
      chrome.storage.onChanged.removeListener(handleStorage);
    };
  }, []);

  const queuedIds = useMemo(() => queuedItems.map((item) => item.id), [queuedItems]);
  const hasItems = queuedItems.length > 0;
  const canUseAppActions = connectionState === CONNECTION_STATES.CONNECTED;
  const mismatchMessage = formatVersionMismatchMessage(appVersion);

  async function handleSyncLibrary() {
    if (connectionState === CONNECTION_STATES.VERSION_MISMATCH) {
      setStatus({ tone: "warning", message: mismatchMessage });
      return;
    }
    if (!canUseAppActions) return;

    setBusyAction("sync");
    setStatus({ tone: "loading", message: "Syncing library..." });

    try {
      const result = await sendMessage("nhq:sync-library");
      if (!result?.success) {
        throw new Error(result?.message || "Library sync failed.");
      }

      setLastSyncedAt(result.syncedAt || Date.now());
      const pruneResult = await pruneQueuedGalleriesByIds(result.ids || []);
      const refreshedQueue = await getQueuedGalleries();
      setQueuedItems(refreshedQueue);
      const removedFromQueue = Number(result.removedFromQueue || pruneResult.removed || 0);
      setStatus({
        tone: "success",
        message: removedFromQueue > 0
          ? `Synced ${result.count || 0} owned IDs. Removed ${removedFromQueue} from queue.`
          : `Synced ${result.count || 0} owned IDs.`
      });
    } catch (error) {
      reportNonFatalError("Failed to sync library", error);
      setStatus({ tone: "error", message: error?.message || "Library sync failed." });
    } finally {
      setBusyAction("");
    }
  }

  async function handleSendToApp() {
    if (connectionState === CONNECTION_STATES.VERSION_MISMATCH) {
      setStatus({ tone: "warning", message: mismatchMessage });
      return;
    }
    if (!canUseAppActions || !queuedIds.length) return;

    setBusyAction("send");
    setStatus({ tone: "loading", message: "Sending queue to app..." });

    try {
      const result = await sendMessage("nhq:send-to-app", { ids: queuedIds });
      if (!result?.success) {
        throw new Error(result?.message || "Send failed");
      }

      setStatus({ tone: "success", message: result.message || `Sent ${queuedIds.length} IDs.` });
    } catch (error) {
      reportNonFatalError("Failed to send queue to app", error);
      setStatus({ tone: "error", message: "Failed to send queue to app." });
    } finally {
      setBusyAction("");
    }
  }

  async function handleClear() {
    if (!hasItems) return;

    setBusyAction("clear");
    setStatus({ tone: "loading", message: "Clearing queue..." });

    try {
      await clearQueuedGalleryIds();
      setStatus({ tone: "success", message: "Queue cleared." });
    } catch (error) {
      reportNonFatalError("Failed to clear queue", error);
      setStatus({ tone: "error", message: "Queue clear failed." });
    } finally {
      setBusyAction("");
    }
  }

  async function handleRemove(id) {
    setRemovingId(id);
    try {
      await removeGalleryIdFromQueue(id);
      setStatus(DEFAULT_STATUS);
    } catch (error) {
      reportNonFatalError("Failed to remove queued ID", error);
      setStatus({ tone: "error", message: "Remove failed." });
    } finally {
      setRemovingId("");
    }
  }

  return (
    <main className="flex min-h-[360px] flex-col bg-[var(--ext-bg)] p-2 text-[var(--ext-text)]">
      <section className="flex min-h-full flex-col overflow-hidden rounded-[12px] border border-[var(--ext-border)] bg-[var(--ext-surface)]">
        <div className="border-b border-[var(--ext-border)] px-3 py-3">
          <div className="flex items-center justify-between gap-2">
            <div className="inline-flex items-center gap-2 text-[11px] font-medium">
              <span className={`h-2 w-2 rounded-full ${connectionState === CONNECTION_STATES.CONNECTED ? "bg-emerald-400" : connectionState === CONNECTION_STATES.VERSION_MISMATCH ? "bg-amber-400" : "bg-zinc-500"}`} />
              <span>{connectionState === CONNECTION_STATES.CONNECTED ? "Connected" : connectionState === CONNECTION_STATES.VERSION_MISMATCH ? "Version mismatch" : "Offline"}</span>
            </div>
            <button
              type="button"
              onClick={handleSyncLibrary}
              disabled={!canUseAppActions || busyAction !== ""}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-[var(--ext-border)] bg-[var(--ext-surface-soft)] text-[var(--ext-text)] disabled:cursor-not-allowed disabled:opacity-50"
              aria-label="Sync library"
              title="Sync library"
            >
              {busyAction === "sync" ? <Spinner className="h-3.5 w-3.5" /> : <SyncIcon className="h-3.5 w-3.5" />}
            </button>
          </div>
          {lastSyncedAt ? (
            <div className="mt-2 text-[10px] text-[var(--ext-muted)]">Last synced: {formatRelativeSyncTime(lastSyncedAt)}</div>
          ) : null}
          {appActivity ? (
            <div className="mt-1 truncate text-[10px] text-[var(--ext-muted)]" title={appActivity}>{appActivity}</div>
          ) : null}
        </div>

        <div className="flex flex-1 flex-col gap-3 px-3 py-3">
          <div className="rounded-[10px] border border-[var(--ext-border)] bg-black/10 px-3 py-2.5">
            <div className="text-[10px] uppercase tracking-[0.18em] text-[var(--ext-muted)]">Queue</div>
            <div className="mt-1 text-lg font-semibold text-[var(--ext-text)]">{queuedItems.length}</div>
          </div>

          <section className="flex flex-1 flex-col overflow-hidden rounded-[10px] border border-[var(--ext-border)] bg-black/10">
            <div className="px-3 py-2 text-[11px] font-medium text-[var(--ext-muted)]">Queued items</div>

            {queuedItems.length ? (
              <ul className="max-h-[280px] overflow-y-auto px-2 pb-2">
                {queuedItems.map((item) => {
                  const title = item.title || item.id;
                  return (
                    <li key={item.id} className="flex items-center gap-2 rounded-md px-2 py-2 hover:bg-white/4">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[11px] font-medium leading-4 text-[var(--ext-text)]" title={title}>
                          {title}
                        </div>
                        {item.title ? <div className="mt-0.5 text-[10px] text-[var(--ext-muted)]">{item.id}</div> : null}
                      </div>
                      <a
                        href={`https://nhentai.net/g/${item.id}/`}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex h-7 w-7 items-center justify-center rounded-sm border border-[var(--ext-border)] bg-[var(--ext-surface-soft)] text-[var(--ext-muted)] transition hover:bg-white/6 hover:text-[var(--ext-text)]"
                        aria-label={`Open gallery ${item.id}`}
                        title="Open gallery"
                      >
                        <LinkIcon className="h-3.5 w-3.5" />
                      </a>
                      <button
                        type="button"
                        onClick={() => handleRemove(item.id)}
                        disabled={busyAction !== "" || removingId === item.id}
                        className="inline-flex h-7 w-7 items-center justify-center rounded-sm border border-[var(--ext-border)] bg-[var(--ext-surface-soft)] text-[var(--ext-muted)] transition hover:bg-[var(--ext-accent-soft)] hover:text-[var(--ext-text)] disabled:cursor-not-allowed disabled:opacity-60"
                        aria-label={`Remove ${item.id} from queue`}
                        title="Remove from queue"
                      >
                        {removingId === item.id ? <Spinner className="h-3.5 w-3.5" /> : <XIcon className="h-3.5 w-3.5" />}
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <div className="flex min-h-[160px] items-center justify-center px-6 py-6 text-center text-[11px] text-[var(--ext-muted)]">
                No galleries queued
              </div>
            )}
          </section>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleSendToApp}
              disabled={!canUseAppActions || !hasItems || busyAction !== ""}
              className="inline-flex h-9 flex-1 items-center justify-center rounded-md border border-[var(--ext-border)] bg-[var(--ext-accent)] text-white disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-300 disabled:opacity-70"
              aria-label="Send queue to app"
              title="Send queue to app"
            >
              {busyAction === "send" ? <Spinner className="h-3.5 w-3.5" /> : <SendIcon className="h-3.5 w-3.5" />}
            </button>
            <button
              type="button"
              onClick={handleClear}
              disabled={!hasItems || busyAction !== ""}
              className="inline-flex h-9 flex-1 items-center justify-center rounded-md border border-[var(--ext-border)] bg-[var(--ext-surface-soft)] text-[var(--ext-text)] disabled:cursor-not-allowed disabled:opacity-50"
              aria-label="Clear queue"
              title="Clear queue"
            >
              {busyAction === "clear" ? <Spinner className="h-3.5 w-3.5" /> : <TrashIcon className="h-3.5 w-3.5" />}
            </button>
          </div>
        </div>

        <footer className="px-3 pb-3 pt-1">
          <div className={`flex items-center gap-2 rounded-md border px-3 py-2 text-[11px] ${toneClasses(status.tone)}`}>
            {status.tone === "loading" ? <Spinner className="h-3.5 w-3.5" /> : <div className="h-2 w-2 rounded-full bg-current" />}
            <div className="flex-1">{status.message}</div>
          </div>
        </footer>
      </section>
    </main>
  );
}
