import * as fs from 'fs';
import * as path from 'path';
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
    const server = require('net').createServer();
    server.once('error', () => {
      resolve(false);
    });
    server.once('listening', () => {
      server.close();
      resolve(true);
    });
    server.listen(port, '127.0.0.1');
  });
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
  const pidFile = getPidFile(configDir);
  const proxyScript = getProxyScript(configDir);
  const logFile = getLogFile(configDir);
  const wrapperScript = getWrapperScript(configDir);
  
  // Ensure config directory exists
  ensureConfigDir(configDir);
  
  // Check if proxy already running
  const existingStatus = await getProxyStatus(configDir);
  if (existingStatus.running && existingStatus.pid && existingStatus.port) {
    // Just reuse existing proxy, update heartbeat
    const heartbeatFile = getHeartbeatFile(configDir);
    fs.writeFileSync(heartbeatFile, Date.now().toString());
    
    // Start heartbeat updates
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
    }
    heartbeatInterval = setInterval(() => {
      try {
        fs.writeFileSync(heartbeatFile, Date.now().toString());
      } catch {}
    }, 5000);
    
    return {
      port: existingStatus.port,
      pid: existingStatus.pid
    };
  }
  
  // Find available port
  const port = await findAvailablePort(8001, 8010);
  
  // Write bundled proxy script to config directory
  fs.writeFileSync(proxyScript, PROXY_SCRIPT_CONTENT, 'utf8');
  fs.chmodSync(proxyScript, '755');
  
  // Write bundled wrapper script to config directory
  fs.writeFileSync(wrapperScript, WRAPPER_SCRIPT_CONTENT, 'utf8');
  fs.chmodSync(wrapperScript, '755');
  
  // Start proxy (detached to avoid receiving SIGINT from terminal)
  const paytacaCmd = getPaytacaCommand();
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
    throw new Error('Failed to start proxy: no PID available');
  }
  
  // Write PID file
  fs.writeFileSync(pidFile, proxy.pid.toString());
  
  // Update config - new proxy (preserve wallet hash from passed config)
  config.proxyPort = port;
  config.proxyPid = proxy.pid;
  saveConfig(configDir, config);
  
  // Initialize heartbeat file
  const heartbeatFile = getHeartbeatFile(configDir);
  fs.writeFileSync(heartbeatFile, Date.now().toString());
  
  // Start heartbeat updates
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
  }
  heartbeatInterval = setInterval(() => {
    try {
      fs.writeFileSync(heartbeatFile, Date.now().toString());
    } catch {}
  }, 5000);
  
  // Handle proxy output
  const logStream = fs.createWriteStream(logFile, { flags: 'a' });
  proxy.stdout?.pipe(logStream);
  proxy.stderr?.pipe(logStream);
  
  // Wait for proxy to be ready
  await waitForProxy(port);
  
  return {
    port,
    pid: proxy.pid
  };
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

async function waitForProxy(port: number, timeout: number = 10000): Promise<void> {
  const start = Date.now();
  
  while (Date.now() - start < timeout) {
    try {
      const response = await fetch(`http://localhost:${port}/v1/config`, {
        signal: AbortSignal.timeout(1000)
      });
      if (response.ok) {
        return;
      }
    } catch {
      // Not ready yet
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  throw new Error(`Proxy failed to start on port ${port} within ${timeout}ms`);
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
