import { initializeContentScript } from "../src/content/content-coordinator";

export default defineContentScript({
  matches: ["https://nhentai.net/*"],
  runAt: "document_idle",
  main() {
    initializeContentScript();
  }
});
