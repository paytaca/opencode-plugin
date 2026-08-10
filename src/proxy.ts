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
  getHeartbeatFile,
  saveConfig, 
  loadConfig,
  ensureConfigDir
} from './config';
import { PROXY_SCRIPT_CONTENT } from './bundled/proxy';
import { WRAPPER_SCRIPT_CONTENT } from './bundled/wrapper';

// Store heartbeat interval reference
let heartbeatInterval: NodeJS.Timeout | null = null;

// Get path to paytaca binary (multi-strategy resolution)
function getPaytacaCommand(): string {
  // Priority 1: Local node_modules (via require.resolve)
  try {
    const paytacaCliPkg = require.resolve('paytaca-cli/package.json');
    return path.resolve(path.dirname(paytacaCliPkg), 'bin', 'paytaca.js');
  } catch {}

  // Priority 2: Local .bin symlink
  const localPaytaca = path.join(__dirname, '..', 'node_modules', '.bin', 'paytaca');
  if (fs.existsSync(localPaytaca)) {
    return localPaytaca;
  }

  // Priority 3: Global npm root
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

  // Priority 4: Common global installation paths
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

  // Priority 5: which/where on PATH
  try {
    const which = process.platform === 'win32' ? 'where' : 'which';
    const result = execSync(`${which} paytaca`, { encoding: 'utf8' }).trim().split('\n')[0];
    if (result) {
      return result;
    }
  } catch {}

  // Priority 6: Bare command (rely on PATH at runtime)
  return 'paytaca';
}

export async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    // Bind EXACTLY like the proxy does (no host -> wildcard / dual-stack).
    // Probing only 127.0.0.1 would miss an existing proxy listener on the
    // IPv6 wildcard address (Node's default listen()), making findAvailablePort
    // hand out a port that's actually in use (-> EADDRINUSE on spawn).
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

// Wait until a port is free (or the timeout elapses). Used after killing an
// outdated proxy so the replacement can bind the same port.
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

// Hash of the bundled proxy script so we can detect when the code changed and
// restart a running proxy instead of silently reusing stale code.
function scriptHash(): string {
  return crypto.createHash('sha1').update(PROXY_SCRIPT_CONTENT).digest('hex');
}

// Persist the pid file + config so every future lookup points at the current
// (known-good) proxy. Centralizes the bookkeeping.
function persistProxyInfo(configDir: string, config: Config, port: number, pid: number, currentHash: string): void {
  fs.writeFileSync(getPidFile(configDir), pid.toString());
  config.proxyPort = port;
  config.proxyPid = pid;
  config.proxyScriptHash = currentHash;
  saveConfig(configDir, config);
}

// Keep the heartbeat file fresh so the proxy doesn't shut itself down.
function startHeartbeatUpdates(configDir: string): void {
  const heartbeatFile = getHeartbeatFile(configDir);
  fs.writeFileSync(heartbeatFile, Date.now().toString());
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
  }
  heartbeatInterval = setInterval(() => {
    try {
      fs.writeFileSync(heartbeatFile, Date.now().toString());
    } catch {}
  }, 5000);
}

// Reuse an existing (fresh) proxy: correct pid file + config, keep heartbeat
// alive, and hand its port back to the caller.
async function reuseExistingProxy(configDir: string, config: Config, status: { port: number; pid: number }, currentHash: string): Promise<ProxyInfo> {
  persistProxyInfo(configDir, config, status.port, status.pid, currentHash);
  startHeartbeatUpdates(configDir);
  return { port: status.port, pid: status.pid };
}

// If a healthy proxy running the current code already exists (e.g. another
// opencode window won the spawn race), adopt it instead of spawning a second
// one. Returns null when no suitable proxy is found.
async function tryAdoptExistingFreshProxy(configDir: string, config: Config, currentHash: string): Promise<ProxyInfo | null> {
  const status = await getProxyStatus(configDir);
  if (status.running && status.pid && status.port && status.pid > 0 &&
      loadConfig(configDir).proxyScriptHash === currentHash) {
    console.log(`[paytaca] Using existing proxy (pid ${status.pid}, port ${status.port}) that started during this session.`);
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
    // Invalid PID file
  }
  
  return { running: false };
}

export async function startProxy(configDir: string, config: Config): Promise<ProxyInfo> {
  const proxyScript = getProxyScript(configDir);
  const logFile = getLogFile(configDir);
  const wrapperScript = getWrapperScript(configDir);
  
  // Ensure config directory exists
  ensureConfigDir(configDir);
  
  // Detect if the running proxy was started from different code than this build
  const currentHash = scriptHash();
  const persistedConfig = loadConfig(configDir);
  
  // Check if proxy already running
  let existingStatus = await getProxyStatus(configDir);
  
  // A running proxy is stale if it was spawned before the current code hash
  // was persisted (i.e. the bundled script has changed since it was started).
  const needsRestart = existingStatus.running &&
    (existingStatus.pid || 0) > 0 &&
    persistedConfig.proxyScriptHash !== currentHash;
  
  // Always rewrite proxy script so code changes take effect on next restart
  fs.writeFileSync(proxyScript, PROXY_SCRIPT_CONTENT, 'utf8');
  fs.chmodSync(proxyScript, '755');
  
  if (existingStatus.running && existingStatus.pid && existingStatus.port && !needsRestart) {
    return await reuseExistingProxy(configDir, config, { port: existingStatus.port, pid: existingStatus.pid }, currentHash);
  }
  
  // A proxy is running but with outdated code — shut it down so the
  // replacement can take over (fixes stale code persisting across restarts).
  if (existingStatus.running && existingStatus.pid) {
    console.log(`[paytaca] Proxy (pid ${existingStatus.pid}) runs outdated code; restarting with updated script...`);
    try {
      process.kill(existingStatus.pid);
    } catch (e) {
      console.log(`[paytaca] Could not signal proxy ${existingStatus.pid}: ${(e as Error).message}`);
    }
    if (existingStatus.port) {
      const freed = await waitForPortFree(existingStatus.port);
      if (!freed) {
        console.log(`[paytaca] Port ${existingStatus.port} still busy after kill; will use next available port.`);
      }
    }
  }
  
  // Another window may have started a fresh proxy while we were deciding
  // (e.g. it won the same-port spawn race) — adopt it rather than double-spawn.
  const adopted = await tryAdoptExistingFreshProxy(configDir, config, currentHash);
  if (adopted) {
    return adopted;
  }
  
  // Write bundled wrapper script to config directory (shared across attempts)
  fs.writeFileSync(wrapperScript, WRAPPER_SCRIPT_CONTENT, 'utf8');
  fs.chmodSync(wrapperScript, '755');
  
  // Start proxy (detached to avoid receiving SIGINT from terminal)
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
      console.log(`[paytaca] Spawn attempt ${attempt} failed (no PID); retrying...`);
      continue;
    }
    
    // Track whether OUR child exited — if so the port is served by another
    // proxy that won the bind race, and we should adopt it instead.
    let childExited = false;
    proxy.once('exit', () => { childExited = true; });
    
    startHeartbeatUpdates(configDir);
    
    // Handle proxy output
    const logStream = fs.createWriteStream(logFile, { flags: 'a' });
    proxy.stdout?.pipe(logStream);
    proxy.stderr?.pipe(logStream);
    
    const ready = await waitForProxy(port, 15000);
    
    if (childExited) {
      // Our child lost the bind race (EADDRINUSE) or crashed immediately.
      // Adopt an existing fresh proxy if there is one; otherwise try again.
      console.log(`[paytaca] Spawned proxy (pid ${proxy.pid}) exited early on port ${port}; checking for an existing proxy...`);
      const a = await tryAdoptExistingFreshProxy(configDir, config, currentHash);
      if (a) {
        return a;
      }
      continue;
    }
    
    if (ready) {
      // Confirm our child is genuinely the one serving (it could have exited
      // between the readiness poll and here). Persist only when healthy.
      if (childExited) {
        const a = await tryAdoptExistingFreshProxy(configDir, config, currentHash);
        if (a) {
          return a;
        }
        continue;
      }
      persistProxyInfo(configDir, config, port, proxy.pid, currentHash);
      console.log(`[paytaca] Proxy started on port ${port} (pid ${proxy.pid}).`);
      return { port, pid: proxy.pid };
    }
    
    // Child alive but never became ready — give it one more window, then retry.
    const ready2 = await waitForProxy(port, 15000);
    if (ready2 && !childExited) {
      persistProxyInfo(configDir, config, port, proxy.pid, currentHash);
      console.log(`[paytaca] Proxy started on port ${port} (pid ${proxy.pid}).`);
      return { port, pid: proxy.pid };
    }
    if (childExited) {
      const a = await tryAdoptExistingFreshProxy(configDir, config, currentHash);
      if (a) {
        return a;
      }
    }
    console.log(`[paytaca] Spawn attempt ${attempt} not ready on port ${port}; retrying...`);
    try {
      process.kill(proxy.pid);
    } catch {}
  }
  
  throw new Error(`Proxy failed to start within ${MAX_ATTEMPTS} attempts`);
}

export async function stopProxy(configDir: string): Promise<void> {
  // Stop heartbeat updates
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
  
  // Note: We don't kill the proxy here anymore.
  // The proxy monitors the heartbeat file and exits itself when stale.
  // This handles multi-window scenarios correctly.
  
  // Optional: Write a special "stopping" timestamp to speed up proxy shutdown
  const heartbeatFile = getHeartbeatFile(configDir);
  try {
    fs.writeFileSync(heartbeatFile, '0');  // Special value: stopping
    // Remove heartbeat file after a short delay
    setTimeout(() => {
      try {
        if (fs.existsSync(heartbeatFile)) {
          fs.unlinkSync(heartbeatFile);
        }
      } catch {}
    }, 100);
  } catch {}
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
      // Not ready yet
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  console.log(`[paytaca] Proxy did not become ready on port ${port} within ${timeout}ms`);
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
