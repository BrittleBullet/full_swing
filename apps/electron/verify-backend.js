const fs = require('fs');
const path = require('path');

const backendPath = path.join(__dirname, '..', 'backend', 'doujinshi-manager.exe');

if (!fs.existsSync(backendPath)) {
  console.error(`Missing backend binary: ${backendPath}`);
  process.exit(1);
}

const stats = fs.statSync(backendPath);
if (!stats.isFile() || stats.size <= 0) {
  console.error(`Backend binary is invalid: ${backendPath}`);
  process.exit(1);
}

process.stdout.write(`Verified backend binary: ${backendPath}\n`);
