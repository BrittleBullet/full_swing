import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.resolve(__dirname, "..");
const sharedPngDir = path.resolve(extensionRoot, "..", "..", "assets", "icons", "png");
const publicDir = path.join(extensionRoot, "public");

const iconMap = new Map([
  ["16x16.png", "icon-16.png"],
  ["32x32.png", "icon-32.png"],
  ["48x48.png", "icon-48.png"],
  ["128x128.png", "icon-128.png"],
  ["512x512.png", "icon.png"]
]);

fs.mkdirSync(publicDir, { recursive: true });

for (const [sourceName, targetName] of iconMap) {
  const sourcePath = path.join(sharedPngDir, sourceName);
  const targetPath = path.join(publicDir, targetName);

  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Missing shared icon: ${sourcePath}`);
  }

  fs.copyFileSync(sourcePath, targetPath);
}

console.log(`Synced ${iconMap.size} shared icons from ${sharedPngDir}`);
