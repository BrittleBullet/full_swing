const RESULTS_PATH_PREFIXES = ["/search", "/tag", "/category", "/character", "/artist", "/group", "/language", "/parody"];

export function matchesPathPrefix(pathname, prefix) {
  if (prefix === "/") return pathname === "/";
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function isGalleryPath(pathname) {
  return /^\/g\/\d+\/?$/.test(pathname || "");
}

export function isSupportedQueuePagePath(pathname) {
  if (pathname === "/") return true;
  if (pathname === "/user/favorites" || pathname === "/user/favorites/") return true;
  if (isGalleryPath(pathname)) return true;
  return RESULTS_PATH_PREFIXES.some((prefix) => matchesPathPrefix(pathname, prefix));
}

export function isSupportedQueuePageUrl(url) {
  try {
    const parsedUrl = new URL(url);
    const hostname = parsedUrl.hostname.toLowerCase();
    if (hostname !== "nhentai.net" && !hostname.endsWith(".nhentai.net")) {
      return false;
    }

    return isSupportedQueuePagePath(parsedUrl.pathname || "/");
  } catch {
    return false;
  }
}

export function getSupportedQueuePagePatterns() {
  const hosts = ["https://nhentai.net", "https://*.nhentai.net"];
  const paths = [
    "/",
    "/g/*",
    "/search*",
    "/tag/*",
    "/category/*",
    "/character/*",
    "/artist/*",
    "/group/*",
    "/language/*",
    "/parody/*",
    "/user/favorites*"
  ];

  return hosts.flatMap((host) => paths.map((path) => `${host}${path}`));
}
