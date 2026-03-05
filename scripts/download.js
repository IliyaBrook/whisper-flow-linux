#!/usr/bin/env node
/**
 * Download Wispr Flow Windows installer
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DOWNLOAD_URL = 'https://dl.wisprflow.ai/windows/latest';
const TMP_DIR = path.join(__dirname, '..', 'tmp');
const EXE_PATH = path.join(TMP_DIR, 'wispr-flow-setup.exe');

function main() {
  fs.mkdirSync(TMP_DIR, { recursive: true });

  if (fs.existsSync(EXE_PATH)) {
    const stats = fs.statSync(EXE_PATH);
    if (stats.size > 100 * 1024 * 1024) {
      console.log('Installer already downloaded, skipping...');
      return;
    }
  }

  console.log('Downloading Wispr Flow Windows installer...');
  execSync(
    `curl -L -o "${EXE_PATH}" "${DOWNLOAD_URL}" --progress-bar --max-time 600`,
    { stdio: 'inherit' }
  );

  const stats = fs.statSync(EXE_PATH);
  console.log(`Downloaded: ${(stats.size / 1024 / 1024).toFixed(1)} MB`);
}

main();
