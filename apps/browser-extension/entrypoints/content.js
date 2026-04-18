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
} from "../src/lib/queue";
import {
  OWNED_IDS_STORAGE_KEY,
  OWNED_SYNCED_AT_STORAGE_KEY,
  formatRelativeSyncTime,
  getOwnedGalleryIds,
  getOwnedSyncTimestamp
} from "../src/lib/owned";
import {
  isGalleryPath,
  isSupportedQueuePagePath
} from "../src/lib/page";

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
const STYLE_ID = "ext-queue-style";
const PAGE_BAR_ATTR = "data-ext-page-queue-bar";
const CARD_GALLERY_ID_ATTR = "data-ext-queue-gallery-id";
const INIT_ATTR = "data-ext-queue-initialized";

const RESULTS_WRAPPER_SELECTORS = [".container", ".index-container", "#content", "main", ".content"];
const RESULTS_GRID_SELECTORS = [".gallery-grid", ".galleries", ".gallery-list", "#favcontainer"];

const API_BASE_URL = 'http://localhost:8080/api';
const APP_STATUS_TIMEOUT_MS = 2500;

function reportNonFatalError(_message, _errorOrContext) {}

function extractGalleryIdFromHref(href) {
  if (!href) return null;

  try {
    const parsedUrl = new URL(href, globalThis.location?.origin || "https://nhentai.net");
    const match = parsedUrl.pathname.match(/\/g\/(\d+)\/?$/);
    return match ? normalizeGalleryId(match[1]) : null;
  } catch (error) {
    reportNonFatalError("Failed to parse gallery URL", error);
    return null;
  }
}

function getCardGalleryId(card) {
  const link = card.querySelector(CARD_LINK_SELECTOR);
  return link ? extractGalleryIdFromHref(link.href) : null;
}

function getCardTitle(card) {
  if (!(card instanceof HTMLElement)) return "";

  const selectors = [".caption", ".caption .name", "[title]", "img[alt]"];
  for (const selector of selectors) {
    const node = card.querySelector(selector);
    const rawTitle =
      node?.getAttribute?.("title") ||
      node?.getAttribute?.("alt") ||
      node?.textContent ||
      "";
    const normalizedTitle = rawTitle.replace(/\s+/g, " ").trim();
    if (normalizedTitle) return normalizedTitle;
  }

  return "";
}

function getCardQueueItem(card) {
  const id = getCardGalleryId(card);
  if (!id) return null;

  return {
    id,
    title: getCardTitle(card)
  };
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

export default defineContentScript({
  matches: ["https://nhentai.net/*"],
  runAt: "document_idle",
  main() {
    if (document.documentElement?.hasAttribute(INIT_ATTR)) {
      return;
    }
    document.documentElement?.setAttribute(INIT_ATTR, "true");

    let queuedIds = new Set();
    let ownedIds = new Set();
    let appOnline = false;
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

    function ensureStyles() {
      if (document.getElementById(STYLE_ID)) return;

      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = `
        :root {
          --ext-bg: #111111;
          --ext-surface: #1a1a1a;
          --ext-surface-soft: #202020;
          --ext-border: #2a2a2a;
          --ext-text: #ffffff;
          --ext-muted: #888888;
          --ext-accent: #ff2e55;
          --ext-accent-soft: rgba(255, 46, 85, 0.16);
        }

        .gallery {
          position: relative;
        }

        .gallery.dm-owned {
          opacity: 1;
        }

        .${BUTTON_CLASS} {
          appearance: none;
          -webkit-appearance: none;
          position: absolute;
          top: 6px;
          right: 6px;
          z-index: 30;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          min-height: 0;
          padding: 4px 7px;
          border: 1px solid rgba(255, 255, 255, 0.18);
          border-radius: 999px;
          background: rgba(15, 17, 21, 0.98);
          color: var(--ext-text) !important;
          font-family: "Segoe UI", "Trebuchet MS", sans-serif !important;
          font-size: 11px !important;
          font-style: normal !important;
          font-weight: 900 !important;
          line-height: 1.1 !important;
          letter-spacing: 0.02em !important;
          text-transform: none !important;
          text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8) !important;
          -webkit-text-fill-color: currentColor;
          text-rendering: geometricPrecision;
          cursor: pointer;
          opacity: 1;
          pointer-events: auto;
          box-shadow: 0 2px 6px rgba(0, 0, 0, 0.45);
          transition: opacity 150ms ease, background 140ms ease, border-color 140ms ease, color 140ms ease;
        }

        .gallery:hover .${BUTTON_CLASS},
        .gallery:focus-within .${BUTTON_CLASS},
        .${BUTTON_CLASS}:focus-visible {
          opacity: 1;
        }

        .${BUTTON_CLASS}:focus-visible {
          outline: 2px solid rgba(255, 59, 92, 0.45);
          outline-offset: 2px;
        }

        .${BUTTON_CLASS}[data-state="queued"] {
          border-color: rgba(255, 59, 92, 0.55);
          background: rgba(255, 59, 92, 0.3);
          color: var(--ext-text) !important;
          font-weight: 900 !important;
        }

        .${BUTTON_CLASS}[data-state="downloaded"] {
          border-color: #ff2e55;
          background: #ff2e55;
          color: #ffffff !important;
          font-size: 11px !important;
          font-weight: 900 !important;
          box-shadow: 0 4px 12px rgba(255, 46, 85, 0.38);
          cursor: default;
        }

        .${BUTTON_CLASS}[data-state="working"] {
          background: rgba(15, 17, 21, 0.94);
        }

        .${BUTTON_CLASS}[data-state="error"] {
          background: rgba(120, 28, 44, 0.9);
        }

        #${PAGE_BAR_ID} {
          position: fixed;
          top: 120px;
          right: 20px;
          z-index: 130;
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          justify-content: flex-end;
          gap: 6px;
          width: fit-content;
          max-width: calc(100vw - 40px);
          margin: 0;
          padding: 0;
          border: none;
          border-radius: 0;
          background: transparent;
          backdrop-filter: none;
          box-shadow: none;
          color: var(--ext-text);
          pointer-events: auto;
        }

        #${PAGE_BUTTON_ID} {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          min-height: 36px;
          width: auto;
          padding: 0 16px;
          border: 1px solid rgba(255, 255, 255, 0.12);
          border-radius: 999px;
          background: rgba(15, 17, 21, 0.85);
          color: var(--ext-text);
          font-size: 12px;
          font-weight: 600;
          letter-spacing: 0.02em;
          cursor: pointer;
          transition: background 150ms ease, border-color 150ms ease, box-shadow 150ms ease;
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
        }

        #${PAGE_BUTTON_ID}:hover {
          color: var(--ext-text);
          background: rgba(255, 59, 92, 0.18);
          border-color: rgba(255, 59, 92, 0.4);
          box-shadow: 0 6px 16px rgba(0, 0, 0, 0.4);
        }

        #${PAGE_BUTTON_ID}:focus-visible {
          outline: 2px solid rgba(255, 59, 92, 0.42);
          outline-offset: 2px;
        }

        #${PAGE_BUTTON_ID}[disabled] {
          cursor: wait;
          opacity: 0.7;
        }

        #${PAGE_STATUS_ID} {
          display: none;
          align-items: center;
          min-height: 30px;
          max-width: min(100%, 280px);
          padding: 0 10px;
          border: 1px solid transparent;
          border-radius: 999px;
          background: var(--ext-surface-soft);
          color: var(--ext-muted);
          font-size: 11px;
          line-height: 1.3;
        }

        #${PAGE_STATUS_ID}[data-visible="true"] {
          display: inline-flex;
        }

        #${PAGE_STATUS_ID}[data-tone="success"] {
          border-color: var(--ext-border);
          background: var(--ext-surface-soft);
          color: var(--ext-text);
        }

        #${PAGE_STATUS_ID}[data-tone="warning"] {
          border-color: rgba(255, 59, 92, 0.24);
          background: var(--ext-accent-soft);
          color: var(--ext-text);
        }

        #${PAGE_STATUS_ID}[data-tone="error"] {
          border-color: rgba(255, 59, 92, 0.3);
          background: var(--ext-accent-soft);
          color: var(--ext-text);
        }

        #${FLOATING_PILL_ID} {
          position: fixed;
          right: 16px;
          bottom: 16px;
          z-index: 240;
          display: flex;
          align-items: center;
          justify-content: center;
          min-height: 52px;
          min-width: 52px;
          width: 52px;
          height: 52px;
          padding: 0;
          border: 1px solid var(--ext-border);
          border-radius: 999px;
          background: #111111;
          box-shadow: 0 14px 34px rgba(0, 0, 0, 0.42);
          max-width: min(348px, calc(100vw - 24px));
          pointer-events: auto;
          transition: box-shadow 200ms ease, background 180ms ease, border-color 180ms ease, transform 200ms ease;
        }

        #${FLOATING_PILL_ID}:hover,
        #${FLOATING_PILL_ID}[data-open="true"] {
          border-color: #444444;
          background: #111111;
          box-shadow: 0 16px 38px rgba(0, 0, 0, 0.5);
          transform: translateY(-4px);
        }

        #${FLOATING_PILL_TRIGGER_ID} svg {
          display: none;
        }

        #${FLOATING_PILL_TRIGGER_ID} {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 100%;
          height: 100%;
          border: none;
          padding: 0;
          background: transparent;
          color: var(--ext-text);
          cursor: pointer;
          transition: transform 150ms ease;
          gap: 0;
          border-radius: 999px;
        }

        #${FLOATING_PILL_TRIGGER_ID}:hover {
          transform: scale(1.03);
        }

        #${FLOATING_PILL_TRIGGER_ID}:focus-visible {
          outline: 2px solid rgba(255, 46, 85, 0.42);
          outline-offset: 2px;
        }

        #${FLOATING_PILL_COUNT_ID} {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 100%;
          height: 100%;
          border: 1px solid var(--ext-border);
          border-radius: 999px;
          background: var(--ext-surface);
          color: var(--ext-text);
          font-size: 18px;
          font-weight: 800;
          letter-spacing: -0.02em;
          font-variant-numeric: tabular-nums;
          transition: transform 220ms ease, background-color 220ms ease, color 220ms ease, border-color 220ms ease;
          text-align: center;
        }

        #${FLOATING_PILL_TRIGGER_ID}[data-has-items="true"] #${FLOATING_PILL_COUNT_ID} {
          border-color: rgba(255, 46, 85, 0.38);
          background: rgba(255, 46, 85, 0.16);
          color: #ffb2c0;
        }

        #${FLOATING_PILL_COUNT_ID}[${FLOATING_PILL_COUNT_BUMP_ATTR}="true"] {
          transform: scale(1.12);
        }

        #${FLOATING_PILL_ACTIONS_ID} {
          position: absolute;
          bottom: calc(100% + 8px);
          right: 0;
          left: auto;
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: 8px;
          padding: 12px;
          border: 1px solid var(--ext-border);
          border-radius: 10px;
          background: #111111;
          box-shadow: 0 14px 34px rgba(0, 0, 0, 0.42);
          opacity: 0;
          pointer-events: none;
          transform: translateY(8px);
          transition: opacity 180ms ease, transform 180ms ease, pointer-events 180ms ease;
          z-index: 241;
          width: fit-content;
        }

        #${FLOATING_PILL_ID}[data-open="true"] #${FLOATING_PILL_ACTIONS_ID} {
          opacity: 1;
          pointer-events: auto;
          transform: translateY(0);
        }

        #${FLOATING_PILL_ACTIONS_ID} button {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          width: 40px;
          height: 40px;
          min-width: 40px;
          min-height: 40px;
          padding: 0;
          border: 1px solid var(--ext-border);
          border-radius: 10px;
          background: var(--ext-surface);
          color: var(--ext-text);
          font-size: 11px;
          font-weight: 700;
          cursor: pointer;
          transition: background 150ms ease, border-color 150ms ease, opacity 150ms ease, color 150ms ease, transform 150ms ease, box-shadow 150ms ease;
          position: relative;
          flex-shrink: 0;
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.03);
        }

        #${FLOATING_PILL_ACTIONS_ID} button:hover {
          background: var(--ext-surface-soft);
          border-color: #3a3a3a;
          color: var(--ext-text);
          transform: translateY(-2px);
          box-shadow: 0 8px 18px rgba(0, 0, 0, 0.28);
        }

        #${FLOATING_PILL_ACTIONS_ID} button:focus-visible {
          outline: 2px solid rgba(255, 59, 92, 0.42);
          outline-offset: 2px;
        }

        #${FLOATING_PILL_ACTIONS_ID} button[disabled] {
          cursor: not-allowed;
          opacity: 0.55;
        }

        #${FLOATING_PILL_ACTIONS_ID} button svg {
          width: 16px;
          height: 16px;
          stroke-width: 1.8;
          flex-shrink: 0;
        }

        #${FLOATING_PILL_ACTIONS_ID} {
          width: 340px;
          min-width: 340px;
          display: flex;
          flex-direction: column;
          gap: 10px;
        }

        .ext-floating-queue-connection {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
        }

        #${FLOATING_PILL_CONNECTION_ID} {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          font-size: 14px;
          font-weight: 600;
          color: var(--ext-text);
          line-height: 1;
        }

        .ext-floating-queue-dot {
          width: 9px;
          height: 9px;
          border-radius: 999px;
          background: #71717a;
          box-shadow: 0 0 0 3px rgba(113, 113, 122, 0.16);
        }

        .ext-floating-queue-dot[data-online="true"] {
          background: #2ecc71;
          box-shadow: 0 0 0 3px rgba(46, 204, 113, 0.16);
        }

        #${FLOATING_PILL_SYNC_ID} {
          width: 38px;
          min-width: 38px;
          height: 38px;
          padding: 0;
          gap: 0;
          border-radius: 6px;
        }

        .ext-floating-queue-actions-row > button {
          flex: 1 1 0;
          width: 100%;
          min-width: 0;
          height: 38px;
          padding: 0 16px;
          gap: 12px;
          justify-content: center;
          align-items: center;
          white-space: nowrap;
          font-size: 13px;
          font-weight: 600;
          line-height: 1;
          border-radius: 6px;
          box-shadow: none;
        }

        .ext-floating-queue-actions-row > button svg {
          flex: 0 0 auto;
          margin-right: 2px;
        }

        .ext-floating-queue-actions-row > button span {
          display: inline-block;
          line-height: 1;
        }

        #${FLOATING_PILL_SEND_ID} {
          background: rgba(255, 46, 85, 0.16);
          border-color: rgba(255, 46, 85, 0.38);
          color: #ff9aad;
        }

        #${FLOATING_PILL_SEND_ID}:hover {
          background: rgba(255, 46, 85, 0.22);
          border-color: #ff4b6f;
          color: #ffc2ce;
        }

        #${FLOATING_PILL_CLEAR_ID} {
          background: var(--ext-surface);
          border-color: var(--ext-border);
          color: #ffffff;
        }

        #${FLOATING_PILL_CLEAR_ID}:hover,
        #${FLOATING_PILL_CLEAR_ID}[data-confirming="true"] {
          background: #202020;
          border-color: #444444;
          color: #ffffff;
        }

        #${FLOATING_PILL_LAST_SYNC_ID} {
          font-size: 11px;
          color: var(--ext-muted);
        }

        #${FLOATING_PILL_SUMMARY_ID} {
          display: none;
          padding: 8px 10px;
          border: 1px solid var(--ext-border);
          border-radius: 8px;
          background: var(--ext-surface);
          color: var(--ext-muted);
          font-size: 11px;
          line-height: 1.35;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        #${FLOATING_PILL_SUMMARY_ID}[data-visible="true"] {
          display: block;
        }

        #${FLOATING_PILL_LIST_ID} {
          display: flex;
          flex-direction: column;
          gap: 6px;
          max-height: 180px;
          overflow-y: auto;
          padding-right: 2px;
        }

        .ext-floating-queue-empty {
          border: 1px solid var(--ext-border);
          border-radius: 10px;
          padding: 10px;
          font-size: 11px;
          color: var(--ext-muted);
          text-align: center;
          background: var(--ext-surface);
        }

        .ext-floating-queue-row {
          display: flex;
          align-items: center;
          gap: 10px;
          border: 1px solid var(--ext-border);
          border-radius: 10px;
          padding: 10px;
          background: linear-gradient(180deg, #1a1a1a 0%, #171717 100%);
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.03);
        }

        .ext-floating-queue-row-text {
          min-width: 0;
          flex: 1;
        }

        .ext-floating-queue-row-title {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-size: 11px;
          color: var(--ext-text);
        }

        .ext-floating-queue-row-id {
          margin-top: 2px;
          font-size: 10px;
          color: var(--ext-muted);
        }

        .ext-floating-queue-remove {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 30px;
          height: 30px;
          border: 1px solid var(--ext-border);
          border-radius: 8px;
          background: var(--ext-surface-soft);
          color: var(--ext-text);
          padding: 0;
          cursor: pointer;
          transition: background 140ms ease, border-color 140ms ease, transform 140ms ease;
        }

        .ext-floating-queue-remove:hover {
          background: rgba(255, 46, 85, 0.14);
          border-color: rgba(255, 46, 85, 0.34);
          transform: translateY(-1px);
        }

        .ext-floating-queue-remove svg {
          width: 14px;
          height: 14px;
        }

        .ext-floating-queue-actions-row {
          display: flex;
          flex-direction: row;
          gap: 8px;
          align-items: stretch;
          width: 100%;
          padding-top: 2px;
        }

        .ext-floating-queue-tooltip {
          position: absolute;
          bottom: -32px;
          left: 50%;
          transform: translateX(-50%);
          padding: 4px 8px;
          background: rgba(0, 0, 0, 0.9);
          color: var(--ext-text);
          font-size: 11px;
          font-weight: 600;
          border-radius: 6px;
          white-space: nowrap;
          opacity: 0;
          pointer-events: none;
          transition: opacity 120ms ease;
          z-index: 242;
        }

        #${FLOATING_PILL_ACTIONS_ID} button:hover .ext-floating-queue-tooltip {
          opacity: 1;
        }

        #${FLOATING_PILL_CLEAR_ID}:hover,
        #${FLOATING_PILL_CLEAR_ID}[data-confirming="true"] {
          background: #202020;
          border-color: #444444;
          color: #ffffff;
        }

        #${FLOATING_PILL_STATUS_ID} {
          display: none;
          position: absolute;
          right: 0;
          bottom: calc(100% + 8px);
          min-height: 30px;
          align-items: center;
          padding: 0 10px;
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-radius: 999px;
          background: rgba(10, 12, 16, 0.88);
          color: var(--ext-muted);
          font-size: 11px;
          line-height: 1.4;
          box-shadow: 0 12px 28px rgba(0, 0, 0, 0.32);
          white-space: nowrap;
        }

        #${FLOATING_PILL_STATUS_ID}[data-visible="true"] {
          display: flex;
        }

        #${FLOATING_PILL_STATUS_ID}[data-tone="success"] {
          border-color: var(--ext-border);
          color: var(--ext-text);
        }

        #${FLOATING_PILL_STATUS_ID}[data-tone="warning"],
        #${FLOATING_PILL_STATUS_ID}[data-tone="error"] {
          border-color: rgba(255, 59, 92, 0.28);
          background: var(--ext-accent-soft);
          color: var(--ext-text);
        }

        @media (max-width: 720px) {
          #${PAGE_BAR_ID} {
            top: 88px;
            width: fit-content;
            max-width: calc(100% - 12px);
            margin-left: auto;
            margin-bottom: 12px;
          }

          #${PAGE_STATUS_ID} {
            max-width: 100%;
          }

          #${FLOATING_PILL_ID} {
            right: 12px;
            bottom: 12px;
            max-width: calc(100vw - 16px);
            padding: 8px;
          }

          #${FLOATING_PILL_ACTIONS_ID} {
            bottom: calc(100% + 6px);
            right: -2px;
          }
        }
      `;

      document.documentElement.appendChild(style);
    }

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
        dot.dataset.online = appOnline ? "true" : "false";
        const text = document.createElement("span");
        text.textContent = appOnline ? "Connected" : "Offline";
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
        sendButton.disabled = !appOnline || queuedIds.size === 0;
      }

      const syncButton = document.getElementById(FLOATING_PILL_SYNC_ID);
      if (syncButton instanceof HTMLButtonElement) {
        syncButton.disabled = !appOnline;
      }
    }

    async function refreshAppConnectionState() {
      try {
        const result = await sendAppMessage("nhq:app-status");
        appOnline = Boolean(result?.success && result?.online);
        appActivityText = appOnline ? formatAppActivity(result?.data) : "";
      } catch {
        appOnline = false;
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
      if (!appOnline) {
        showFloatingPillStatus("App is offline", "warning");
        return { success: false, offline: true };
      }

      setFloatingPillBusy(FLOATING_PILL_SYNC_ID, true);
      showFloatingPillStatus("Syncing library...", "neutral", true);

      try {
        const result = await sendAppMessage("nhq:sync-library");
        if (!result?.success) {
          showFloatingPillStatus("Library sync failed.", "error");
          return { success: false };
        }

        const cacheResult = await loadOwnedCache();
        refreshAllCardStates();
        refreshPageQueueButton();
        updateFloatingPillCount();
        await renderFloatingPillQueueList();
        const removedFromQueue = Number(result.removedFromQueue || cacheResult?.removedFromQueue || 0);
        showFloatingPillStatus(
          removedFromQueue > 0
            ? `Synced ${formatQueueCount(result.count || 0)} owned IDs • removed ${formatQueueCount(removedFromQueue)} from queue`
            : `Synced ${formatQueueCount(result.count || 0)} owned IDs`,
          "success"
        );
        return { success: true };
      } catch (error) {
        reportNonFatalError("Failed to sync library", error);
        showFloatingPillStatus("Library sync failed.", "error");
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

    function setCardState(card, state) {
      if (!(card instanceof HTMLElement)) return;

      const isQueued = state === "queued";
      const isDownloaded = state === "downloaded";

      if (isQueued) card.setAttribute(QUEUED_CARD_ATTR, "true");
      else card.removeAttribute(QUEUED_CARD_ATTR);

      if (isDownloaded) card.setAttribute(DOWNLOADED_CARD_ATTR, "true");
      else card.removeAttribute(DOWNLOADED_CARD_ATTR);

      card.classList.toggle("dm-owned", isDownloaded);

      const button = card.querySelector(`.${BUTTON_CLASS}`);
      if (!button) return;

      if (isDownloaded) {
        button.textContent = "Owned";
        button.dataset.state = "downloaded";
        button.disabled = true;
      } else {
        button.textContent = isQueued ? "Queued" : "Queue";
        button.disabled = false;
        if (isQueued) button.dataset.state = "queued";
        else delete button.dataset.state;
      }

      card.style.outline = isDownloaded
        ? "2px solid rgba(255, 46, 85, 0.82)"
        : isQueued
          ? "2px solid rgba(255, 59, 92, 0.72)"
          : "";
      card.style.outlineOffset = isDownloaded || isQueued ? "2px" : "";
    }

    function setButtonState(button, label, state, persist) {
      button.textContent = label;
      if (state) button.dataset.state = state;
      else delete button.dataset.state;

      if (persist) return;

      window.setTimeout(() => {
        if (!button.isConnected) return;

        const isDownloaded = button.closest(CARD_SELECTOR)?.getAttribute(DOWNLOADED_CARD_ATTR) === "true";
        const isQueued = button.closest(CARD_SELECTOR)?.getAttribute(QUEUED_CARD_ATTR) === "true";
        if (isDownloaded) {
          button.textContent = "Owned";
          button.dataset.state = "downloaded";
          button.disabled = true;
          return;
        }

        button.textContent = isQueued ? "Queued" : "Queue";
        button.disabled = false;
        if (isQueued) button.dataset.state = "queued";
        else delete button.dataset.state;
      }, 1200);
    }

    function refreshAllCardStates() {
      document.querySelectorAll(CARD_SELECTOR).forEach((card) => {
        const id = getCardGalleryId(card);
        if (!id) {
          setCardState(card, "idle");
          return;
        }

        if (ownedIds.has(id)) {
          setCardState(card, "downloaded");
          return;
        }

        setCardState(card, queuedIds.has(id) ? "queued" : "idle");
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

    function injectButton(card) {
      if (!(card instanceof HTMLElement)) return;

      const existingGalleryId = card.getAttribute(CARD_GALLERY_ID_ATTR) || "";
      const galleryId = getCardGalleryId(card);
      const button = card.querySelector(`.${BUTTON_CLASS}`);

      if (!galleryId) {
        card.removeAttribute(CARD_GALLERY_ID_ATTR);
        card.removeAttribute(BUTTON_ATTR);
        card.removeAttribute(QUEUED_CARD_ATTR);
        card.removeAttribute(DOWNLOADED_CARD_ATTR);

        if (button instanceof HTMLElement) {
          button.remove();
        }

        card.style.outline = "";
        card.style.outlineOffset = "";
        return;
      }

      let nextButton = button;
      if (!(nextButton instanceof HTMLButtonElement)) {
        nextButton = document.createElement("button");
        nextButton.type = "button";
        nextButton.className = BUTTON_CLASS;
        nextButton.addEventListener("pointerdown", consumeQueueEvent);
        nextButton.addEventListener("click", handleQueueClick);
        card.appendChild(nextButton);
      }

      if (existingGalleryId !== galleryId) {
        delete nextButton.dataset.state;
      }

      const isDownloaded = ownedIds.has(galleryId);
      nextButton.setAttribute("aria-label", isDownloaded ? `Gallery ${galleryId} is already owned` : `Toggle gallery ${galleryId} in queue`);
      card.setAttribute(BUTTON_ATTR, "true");
      card.setAttribute(CARD_GALLERY_ID_ATTR, galleryId);
      setCardState(card, isDownloaded ? "downloaded" : queuedIds.has(galleryId) ? "queued" : "idle");
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

    function scanAndInject(root) {
      const scope = root instanceof Element || root instanceof Document ? root : document;
      const cards = scope.matches?.(CARD_SELECTOR) ? [scope] : Array.from(scope.querySelectorAll(CARD_SELECTOR));
      cards.forEach(injectButton);
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
            if (node.id === FLOATING_PILL_ID || node.id === PAGE_BAR_ID || node.id === STYLE_ID) continue;
            if (node.matches?.(`.${BUTTON_CLASS}`) || node.hasAttribute?.(PAGE_BAR_ATTR) || node.id === FLOATING_PILL_ID) continue;
            if (node.closest?.(`#${FLOATING_PILL_ID}`) || node.closest?.(`#${PAGE_BAR_ID}`) || node.closest?.(`.${BUTTON_CLASS}`)) continue;
            pendingRefreshRoots.add(node);
            shouldRefresh = true;
          }

          for (const node of mutation.removedNodes) {
            if (!(node instanceof Element)) continue;
            if (node.id === FLOATING_PILL_ID || node.id === PAGE_BAR_ID || node.id === STYLE_ID) continue;
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
      ensureStyles();

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

          if (changes[STORAGE_KEY]) {
            const nextValue = Array.isArray(changes[STORAGE_KEY].newValue) ? changes[STORAGE_KEY].newValue : [];
            queuedIds = new Set(
              nextValue
                .map((item) => (typeof item === "object" && item ? normalizeGalleryId(item.id) : normalizeGalleryId(item)))
                .filter(Boolean)
            );
          }

          if (changes[OWNED_IDS_STORAGE_KEY] || changes[OWNED_SYNCED_AT_STORAGE_KEY]) {
            const nextIds = Array.isArray(changes[OWNED_IDS_STORAGE_KEY]?.newValue)
              ? changes[OWNED_IDS_STORAGE_KEY].newValue.map((id) => normalizeGalleryId(id)).filter(Boolean)
              : Array.from(ownedIds);
            ownedIds = new Set(nextIds);
            lastSyncedAt = Number(changes[OWNED_SYNCED_AT_STORAGE_KEY]?.newValue || lastSyncedAt || 0);
            lastOwnedSyncKey = "";
          }

          refreshAllCardStates();
          refreshPageQueueButton();
          injectQueuePageButton();
          injectFloatingPill();
          void renderFloatingPillQueueList();
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
});
