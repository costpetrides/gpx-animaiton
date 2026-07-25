import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_NAME = 'GPX Animator Studio';
const DEV_URL = 'http://127.0.0.1:5173';
const PORT = 5173;

function patchMacElectronBundleName() {
  if (process.platform !== 'darwin') return;
  try {
    const plistPath = path.resolve(path.dirname(electronPath), '..', 'Info.plist');
    if (!fs.existsSync(plistPath)) return;
    let plist = fs.readFileSync(plistPath, 'utf8');
    const next = plist
      .replace(
        /(<key>CFBundleName<\/key>\s*<string>)([^<]*)(<\/string>)/,
        `$1${APP_NAME}$3`,
      )
      .replace(
        /(<key>CFBundleDisplayName<\/key>\s*<string>)([^<]*)(<\/string>)/,
        `$1${APP_NAME}$3`,
      );
    if (next !== plist) fs.writeFileSync(plistPath, next);
  } catch {
    // Non-fatal in dev.
  }
}

function waitForPort(port, host = '127.0.0.1', timeoutMs = 60000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tryConnect = () => {
      const socket = net.connect(port, host, () => {
        socket.end();
        resolve();
      });
      socket.on('error', () => {
        if (Date.now() - started > timeoutMs) {
          reject(new Error(`Timed out waiting for Vite on ${host}:${port}`));
          return;
        }
        setTimeout(tryConnect, 250);
      });
    };
    tryConnect();
  });
}

patchMacElectronBundleName();

const viteBin = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
const vite = spawn(process.execPath, [viteBin, '--host', '127.0.0.1', '--port', String(PORT)], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env },
});

vite.on('exit', (code) => {
  if (code && code !== 0) process.exit(code);
});

try {
  await waitForPort(PORT);
} catch (err) {
  vite.kill('SIGTERM');
  console.error(err.message);
  process.exit(1);
}

const electronEnv = { ...process.env };
delete electronEnv.ELECTRON_RUN_AS_NODE;

const electron = spawn(electronPath, ['.'], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...electronEnv,
    VITE_DEV_SERVER_URL: DEV_URL,
    ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
  },
});

function shutdown(signal) {
  electron.kill(signal);
  vite.kill(signal);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

electron.on('exit', (code) => {
  vite.kill('SIGTERM');
  process.exit(code ?? 0);
});
