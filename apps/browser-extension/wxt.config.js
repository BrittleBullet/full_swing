import { defineConfig } from "wxt";

export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  manifest: {
    name: "nhentai Queue",
    short_name: "nhq",
    version: "0.2.0",
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
    }
  }
});
