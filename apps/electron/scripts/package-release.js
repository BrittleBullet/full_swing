const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const electronDir = path.resolve(__dirname, "..");
const repoRoot = path.resolve(electronDir, "..", "..");
const distDir = path.join(repoRoot, "dist");
const extensionBuildDir = path.join(repoRoot, "apps", "browser-extension", ".output", "chrome-mv3");
const version = require(path.join(electronDir, "package.json")).version;
const releaseDirName = `Full-Swing-v${version}`;
const releaseDir = path.join(distDir, releaseDirName);
const zipPath = path.join(distDir, `${releaseDirName}.zip`);

function ensureExists(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing ${label}: ${filePath}`);
  }
  return filePath;
}

function copyFile(sourcePath, destinationPath) {
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  fs.copyFileSync(sourcePath, destinationPath);
}

function findBuiltAsset(folderPath, prefix, extension) {
  const matches = fs.readdirSync(folderPath)
    .filter((name) => name.startsWith(prefix) && name.endsWith(extension))
    .sort();

  if (matches.length === 0) {
    throw new Error(`Missing built asset ${prefix}*${extension} in ${folderPath}`);
  }

  return path.join(folderPath, matches[matches.length - 1]);
}

function writeReleaseReadme(destinationPath) {
  const content = `Full Swing v${version}
=================

REQUIREMENTS
- Windows 10/11 x64
- Chrome or Arc browser

INSTALLATION
1. Run "Full Swing Setup ${version}.exe" to install
   OR use "Full-Swing-${version}-portable.exe" for a no-install version

2. Load the browser extension:
   - Open Chrome or Arc
   - Go to Extensions (chrome://extensions)
   - Enable Developer Mode (top right toggle)
   - Click "Load unpacked"
   - Select the "extension" folder from this zip

3. Launch Full Swing from the Start Menu or system tray

4. On first run, set your Library Path and Download Path in Settings

5. The extension will show "Connected" when the app is running

UPDATING
- Always replace both the app and extension together
- Using mismatched versions will show a warning in the extension

UNINSTALLING
- Use Add/Remove Programs to uninstall
- Your library and settings are preserved on uninstall
`;

  fs.writeFileSync(destinationPath, content, "utf8");
}

function main() {
  ensureExists(distDir, "dist directory");
  ensureExists(extensionBuildDir, "built extension directory");

  fs.rmSync(releaseDir, { recursive: true, force: true });
  fs.rmSync(zipPath, { force: true });
  fs.mkdirSync(releaseDir, { recursive: true });

  const installerNames = [
    `Full Swing Setup ${version}.exe`,
    `Full-Swing-${version}-portable.exe`
  ];

  for (const name of installerNames) {
    copyFile(ensureExists(path.join(distDir, name), `release executable ${name}`), path.join(releaseDir, name));
  }

  const extensionDir = path.join(releaseDir, "extension");
  const iconsDir = path.join(extensionDir, "icons");
  fs.mkdirSync(iconsDir, { recursive: true });

  copyFile(path.join(extensionBuildDir, "manifest.json"), path.join(extensionDir, "manifest.json"));
  copyFile(path.join(extensionBuildDir, "background.js"), path.join(extensionDir, "background.js"));
  copyFile(path.join(extensionBuildDir, "content-scripts", "content.js"), path.join(extensionDir, "content.js"));
  copyFile(path.join(extensionBuildDir, "popup.html"), path.join(extensionDir, "popup.html"));
  copyFile(findBuiltAsset(path.join(extensionBuildDir, "chunks"), "popup-", ".js"), path.join(extensionDir, "popup.js"));
  copyFile(findBuiltAsset(path.join(extensionBuildDir, "assets"), "popup-", ".css"), path.join(extensionDir, "styles.css"));
  copyFile(path.join(extensionBuildDir, "icon-16.png"), path.join(iconsDir, "icon16.png"));
  copyFile(path.join(extensionBuildDir, "icon-48.png"), path.join(iconsDir, "icon48.png"));
  copyFile(path.join(extensionBuildDir, "icon-128.png"), path.join(iconsDir, "icon128.png"));

  writeReleaseReadme(path.join(releaseDir, "README.txt"));

  execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      `Compress-Archive -Path \"${releaseDir}\" -DestinationPath \"${zipPath}\" -Force`
    ],
    { stdio: "inherit" }
  );

  fs.rmSync(releaseDir, { recursive: true, force: true });
  process.stdout.write(`Release package created: ${zipPath}\n`);
}

main();
