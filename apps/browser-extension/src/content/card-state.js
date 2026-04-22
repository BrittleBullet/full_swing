import { STORAGE_KEY, normalizeGalleryId } from "../lib/queue";
import { OWNED_IDS_STORAGE_KEY, OWNED_SYNCED_AT_STORAGE_KEY } from "../lib/owned";

const CARD_SELECTOR = ".gallery";
const CARD_LINK_SELECTOR = "a.cover";
const BUTTON_CLASS = "ext-queue-btn";
const BUTTON_ATTR = "data-ext-queue-button";
const QUEUED_CARD_ATTR = "data-ext-queued";
const DOWNLOADED_CARD_ATTR = "data-ext-downloaded";
const CARD_GALLERY_ID_ATTR = "data-ext-queue-gallery-id";

function extractGalleryIdFromHref(href, reportNonFatalError) {
  if (!href) {
    return null;
  }

  try {
    const parsedUrl = new URL(href, globalThis.location?.origin || "https://nhentai.net");
    const match = parsedUrl.pathname.match(/\/g\/(\d+)\/?$/);
    return match ? normalizeGalleryId(match[1]) : null;
  } catch (error) {
    reportNonFatalError("Failed to parse gallery URL", error);
    return null;
  }
}

function getCardGalleryId(card, reportNonFatalError) {
  const link = card?.querySelector?.(CARD_LINK_SELECTOR);
  return link ? extractGalleryIdFromHref(link.href, reportNonFatalError) : null;
}

function getCardTitle(card) {
  if (!(card instanceof HTMLElement)) {
    return "";
  }

  const selectors = [".caption", ".caption .name", "[title]", "img[alt]"];
  for (const selector of selectors) {
    const node = card.querySelector(selector);
    const rawTitle =
      node?.getAttribute?.("title") ||
      node?.getAttribute?.("alt") ||
      node?.textContent ||
      "";
    const normalizedTitle = rawTitle.replace(/\s+/g, " ").trim();
    if (normalizedTitle) {
      return normalizedTitle;
    }
  }

  return "";
}

function getCardQueueItem(card, reportNonFatalError) {
  const id = getCardGalleryId(card, reportNonFatalError);
  if (!id) {
    return null;
  }

  return {
    id,
    title: getCardTitle(card)
  };
}

function setCardState(card, state) {
  if (!(card instanceof HTMLElement)) {
    return;
  }

  const isQueued = state === "queued";
  const isDownloaded = state === "downloaded";

  if (isQueued) card.setAttribute(QUEUED_CARD_ATTR, "true");
  else card.removeAttribute(QUEUED_CARD_ATTR);

  if (isDownloaded) card.setAttribute(DOWNLOADED_CARD_ATTR, "true");
  else card.removeAttribute(DOWNLOADED_CARD_ATTR);

  card.classList.toggle("dm-owned", isDownloaded);

  const button = card.querySelector(`.${BUTTON_CLASS}`);
  if (!button) {
    return;
  }

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

  if (persist) {
    return;
  }

  window.setTimeout(() => {
    if (!button.isConnected) {
      return;
    }

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

function repaintAllCards(ownedIds, queuedIds, reportNonFatalError) {
  document.querySelectorAll(CARD_SELECTOR).forEach((card) => {
    const id = getCardGalleryId(card, reportNonFatalError);
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

export function createCardStateController({
  getQueuedIds,
  setQueuedIds,
  getOwnedIds,
  setOwnedIds,
  getLastSyncedAt,
  setLastSyncedAt,
  handleQueueClick,
  consumeQueueEvent,
  reportNonFatalError
}) {
  return {
    extractGalleryIdFromHref: (href) => extractGalleryIdFromHref(href, reportNonFatalError),
    getCardGalleryId: (card) => getCardGalleryId(card, reportNonFatalError),
    getCardQueueItem: (card) => getCardQueueItem(card, reportNonFatalError),
    setButtonState,
    setCardState,
    refreshAllCardStates() {
      repaintAllCards(getOwnedIds(), getQueuedIds(), reportNonFatalError);
    },
    async rebuildCardStates() {
      const data = await chrome.storage.local.get([OWNED_IDS_STORAGE_KEY, OWNED_SYNCED_AT_STORAGE_KEY, STORAGE_KEY]);
      const freshOwned = new Set(
        (Array.isArray(data[OWNED_IDS_STORAGE_KEY]) ? data[OWNED_IDS_STORAGE_KEY] : [])
          .map((id) => normalizeGalleryId(id))
          .filter(Boolean)
      );
      const freshQueued = new Set(
        (Array.isArray(data[STORAGE_KEY]) ? data[STORAGE_KEY] : [])
          .map((item) => (typeof item === "object" && item ? normalizeGalleryId(item.id) : normalizeGalleryId(item)))
          .filter(Boolean)
      );

      setOwnedIds(freshOwned);
      setQueuedIds(freshQueued);
      setLastSyncedAt(Number(data[OWNED_SYNCED_AT_STORAGE_KEY] || getLastSyncedAt() || 0));
      repaintAllCards(freshOwned, freshQueued, reportNonFatalError);
    },
    injectButton(card) {
      if (!(card instanceof HTMLElement)) {
        return;
      }

      const existingGalleryId = card.getAttribute(CARD_GALLERY_ID_ATTR) || "";
      const galleryId = getCardGalleryId(card, reportNonFatalError);
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

      const isDownloaded = getOwnedIds().has(galleryId);
      nextButton.setAttribute("aria-label", isDownloaded ? `Gallery ${galleryId} is already owned` : `Toggle gallery ${galleryId} in queue`);
      card.setAttribute(BUTTON_ATTR, "true");
      card.setAttribute(CARD_GALLERY_ID_ATTR, galleryId);
      setCardState(card, isDownloaded ? "downloaded" : getQueuedIds().has(galleryId) ? "queued" : "idle");
    },
    scanAndInject(root) {
      const scope = root instanceof Element || root instanceof Document ? root : document;
      const cards = scope.matches?.(CARD_SELECTOR) ? [scope] : Array.from(scope.querySelectorAll(CARD_SELECTOR));
      cards.forEach((card) => this.injectButton(card));
    }
  };
}