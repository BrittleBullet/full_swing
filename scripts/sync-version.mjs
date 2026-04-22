import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const versionPath = path.join(repoRoot, "VERSION");
const electronPackagePath = path.join(repoRoot, "apps", "electron", "package.json");
const extensionPackagePath = path.join(repoRoot, "apps", "browser-extension", "package.json");

function readVersion() {
  const version = fs.readFileSync(versionPath, "utf8").trim();
  if (!version) {
    throw new Error(`VERSION file is empty: ${versionPath}`);
  }
  return version;
}

function syncPackageVersion(packagePath, version) {
  const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  if (packageJson.version === version) {
    return false;
  }
  packageJson.version = version;
  fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
  return true;
}

function main() {
  const version = readVersion();
  const changed = [];

  if (syncPackageVersion(electronPackagePath, version)) {
    changed.push(path.relative(repoRoot, electronPackagePath));
  }
  if (syncPackageVersion(extensionPackagePath, version)) {
    changed.push(path.relative(repoRoot, extensionPackagePath));
  }

  const status = changed.length > 0 ? `updated ${changed.join(", ")}` : "already in sync";
  process.stdout.write(`Synced version ${version} from VERSION: ${status}\n`);
}

main();