export const CONTENT_STYLE_LINK_ID = "ext-queue-style";

export function ensureContentStyles() {
  if (document.getElementById(CONTENT_STYLE_LINK_ID)) {
    return;
  }

  const href = chrome?.runtime?.getURL?.("content.css");
  if (!href) {
    return;
  }

  const link = document.createElement("link");
  link.id = CONTENT_STYLE_LINK_ID;
  link.rel = "stylesheet";
  link.href = href;

  (document.head || document.documentElement).appendChild(link);
}