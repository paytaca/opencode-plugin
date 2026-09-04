import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawn, execSync } from 'child_process';
import { Config, ProxyInfo } from './types';
import {
  getConfigDir,
  getPidFile,
  getProxyScript,
  getLogFile,
  getWrapperScript,
  saveConfig,
  loadConfig,
  ensureConfigDir
} from './config';
import { PROXY_SCRIPT_CONTENT } from './bundled/proxy';
import { WRAPPER_SCRIPT_CONTENT } from './bundled/wrapper';

export function getPaytacaCommand(): string {
  try {
    const paytacaCliPkg = require.resolve('paytaca-cli/package.json');
    return path.resolve(path.dirname(paytacaCliPkg), 'bin', 'paytaca.js');
  } catch {}

  const localPaytaca = path.join(__dirname, '..', 'node_modules', '.bin', 'paytaca');
  if (fs.existsSync(localPaytaca)) {
    return localPaytaca;
  }

  try {
    const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
    const pathsToCheck = [
      path.join(globalRoot, 'paytaca-cli', 'bin', 'paytaca.js'),
      path.join(globalRoot, '@paytaca', 'opencode-plugin', 'node_modules', 'paytaca-cli', 'bin', 'paytaca.js'),
    ];
    for (const p of pathsToCheck) {
      if (fs.existsSync(p)) {
        return p;
      }
    }
  } catch {}

  const commonPaths = [
    '/usr/lib/node_modules/paytaca-cli/bin/paytaca.js',
    '/usr/local/lib/node_modules/paytaca-cli/bin/paytaca.js',
    '/opt/homebrew/lib/node_modules/paytaca-cli/bin/paytaca.js',
  ];
  for (const p of commonPaths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }

  try {
    const which = process.platform === 'win32' ? 'where' : 'which';
    const result = execSync(`${which} paytaca`, { encoding: 'utf8' }).trim().split('\n')[0];
    if (result) {
      return result;
    }
  } catch {}

  return 'paytaca';
}

export async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = require('net').createServer();
    server.once('error', () => {
      resolve(false);
    });
    server.once('listening', () => {
      server.close();
      resolve(true);
    });
    server.listen(port);
  });
}

async function waitForPortFree(port: number, timeout: number = 10000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await isPortAvailable(port)) {
      return true;
    }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  return false;
}

function scriptHash(): string {
  return crypto.createHash('sha1').update(PROXY_SCRIPT_CONTENT).digest('hex');
}

function persistProxyInfo(configDir: string, config: Config, port: number, pid: number, currentHash: string): void {
  fs.writeFileSync(getPidFile(configDir), pid.toString());
  config.proxyPort = port;
  config.proxyPid = pid;
  config.proxyScriptHash = currentHash;
  saveConfig(configDir, config);
}

async function reuseExistingProxy(configDir: string, config: Config, status: { port: number; pid: number }, currentHash: string): Promise<ProxyInfo> {
  persistProxyInfo(configDir, config, status.port, status.pid, currentHash);
  return { port: status.port, pid: status.pid };
}

async function tryAdoptExistingFreshProxy(configDir: string, config: Config, currentHash: string): Promise<ProxyInfo | null> {
  const status = await getProxyStatus(configDir);
  if (status.running && status.pid && status.port && status.pid > 0 &&
      loadConfig(configDir).proxyScriptHash === currentHash) {
    return await reuseExistingProxy(configDir, config, { port: status.port, pid: status.pid }, currentHash);
  }
  return null;
}

export async function findAvailablePort(startPort: number = 8001, endPort: number = 8010): Promise<number> {
  for (let port = startPort; port <= endPort; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available ports in range ${startPort}-${endPort}`);
}

export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function getProxyStatus(configDir: string): Promise<{ running: boolean; port?: number; pid?: number }> {
  const pidFile = getPidFile(configDir);
  
  if (!fs.existsSync(pidFile)) {
    return { running: false };
  }
  
  try {
    const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim());
    if (isProcessRunning(pid)) {
      const config = loadConfig(configDir);
      return { running: true, port: config.proxyPort, pid };
    }
  } catch {
  }
  
  return { running: false };
}

export async function startProxy(configDir: string, config: Config): Promise<ProxyInfo> {
  const proxyScript = getProxyScript(configDir);
  const logFile = getLogFile(configDir);
  const wrapperScript = getWrapperScript(configDir);

  ensureConfigDir(configDir);

  // Always refresh the payment wrapper on disk. It is executed fresh on every
  // payment, so it must never go stale even when the proxy is reused/restarted.
  fs.writeFileSync(wrapperScript, WRAPPER_SCRIPT_CONTENT, 'utf8');
  fs.chmodSync(wrapperScript, '755');

  const currentHash = scriptHash();
  const persistedConfig = loadConfig(configDir);

  let existingStatus = await getProxyStatus(configDir);

  const needsRestart = existingStatus.running &&
    (existingStatus.pid || 0) > 0 &&
    persistedConfig.proxyScriptHash !== currentHash;

  if (existingStatus.running && existingStatus.pid && existingStatus.port && !needsRestart) {
    return await reuseExistingProxy(configDir, config, { port: existingStatus.port, pid: existingStatus.pid }, currentHash);
  }

  fs.writeFileSync(proxyScript, PROXY_SCRIPT_CONTENT, 'utf8');
  fs.chmodSync(proxyScript, '755');

  if (existingStatus.running && existingStatus.pid) {
    try {
      process.kill(existingStatus.pid);
    } catch {}
    if (existingStatus.port) {
      await waitForPortFree(existingStatus.port);
    }
  }

  const adopted = await tryAdoptExistingFreshProxy(configDir, config, currentHash);
  if (adopted) {
    return adopted;
  }

  const paytacaCmd = getPaytacaCommand();

  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const port = await findAvailablePort(8001, 8010);
    const proxy = spawn('node', [
      proxyScript,
      config.backendUrl,
      port.toString()
    ], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PAYTACA_CMD: paytacaCmd
      }
    });

    proxy.unref();

    if (!proxy.pid) {
      continue;
    }

    let childExited = false;
    proxy.once('exit', () => { childExited = true; });

    const logStream = fs.createWriteStream(logFile, { flags: 'a' });
    proxy.stdout?.pipe(logStream);
    proxy.stderr?.pipe(logStream);

    const ready = await waitForProxy(port, 15000);

    if (childExited) {
      const a = await tryAdoptExistingFreshProxy(configDir, config, currentHash);
      if (a) {
        return a;
      }
      continue;
    }

    if (ready) {
      if (childExited) {
        const a = await tryAdoptExistingFreshProxy(configDir, config, currentHash);
        if (a) {
          return a;
        }
        continue;
      }
      persistProxyInfo(configDir, config, port, proxy.pid, currentHash);
      return { port, pid: proxy.pid };
    }

    const ready2 = await waitForProxy(port, 15000);
    if (ready2 && !childExited) {
      persistProxyInfo(configDir, config, port, proxy.pid, currentHash);
      return { port, pid: proxy.pid };
    }
    if (childExited) {
      const a = await tryAdoptExistingFreshProxy(configDir, config, currentHash);
      if (a) {
        return a;
      }
    }
    try {
      process.kill(proxy.pid);
    } catch {}
  }

  console.error(`[paytaca] Proxy failed to start within ${MAX_ATTEMPTS} attempts`);
  throw new Error(`Proxy failed to start within ${MAX_ATTEMPTS} attempts`);
}

async function waitForProxy(port: number, timeout: number = 30000): Promise<boolean> {
  const start = Date.now();
  
  while (Date.now() - start < timeout) {
    try {
      const response = await fetch(`http://localhost:${port}/v1/config`, {
        signal: AbortSignal.timeout(8000)
      });
      if (response.ok) {
        return true;
      }
    } catch {
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  return false;
}

export async function getProxyConfig(configDir: string): Promise<{ backendUrl: string; port: number } | null> {
  const status = await getProxyStatus(configDir);
  if (status.running && status.port) {
    const config = loadConfig(configDir);
    return {
      backendUrl: config.backendUrl,
      port: status.port
    };
  }
  return null;
}