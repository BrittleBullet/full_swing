import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "wxt";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const extensionVersion = fs.readFileSync(path.join(repoRoot, "VERSION"), "utf8").trim();

export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  vite: () => ({
    define: {
      __FULL_SWING_VERSION__: JSON.stringify(extensionVersion)
    }
  }),
  manifest: {
    name: "nhentai Queue",
    short_name: "nhq",
    version: extensionVersion,
    description: "Queue galleries and send them to the local manager app.",
    permissions: ["storage"],
    host_permissions: ["https://nhentai.net/*", "http://localhost/*", "http://127.0.0.1/*"],
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'self'"
    },
    icons: {
      16: "icon-16.png",
      32: "icon-32.png",
      48: "icon-48.png",
      128: "icon-128.png"
    },
    action: {
      default_title: "nhentai Queue",
      default_icon: {
        16: "icon-16.png",
        32: "icon-32.png",
        48: "icon-48.png"
      }
    },
    web_accessible_resources: [
      {
        resources: ["content.css"],
        matches: ["https://nhentai.net/*"]
      }
    ]
  }
});
