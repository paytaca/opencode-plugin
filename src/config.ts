import * as fs from 'fs';
import * as path from 'path';
import { Config } from './types';

// Default production backend
export const DEFAULT_BACKEND_URL = 'https://api.paytaca.ai';
export const DEFAULT_PROXY_PORT = 8001;

// Config directory: ~/.opencode-paytaca/
export function getConfigDir(): string {
  const home = process.env.HOME || process.env.USERPROFILE || '.';
  return path.join(home, '.opencode-paytaca');
}

export function ensureConfigDir(configDir: string): void {
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
}

export function getConfigFile(configDir: string): string {
  return path.join(configDir, 'config.json');
}

export function loadConfig(configDir: string): Config {
  const configFile = getConfigFile(configDir);
  
  // Priority 1: Environment variable (highest priority, for dev/testing)
  const envBackendUrl = process.env.PAYTACA_BACKEND_URL;
  if (envBackendUrl) {
    return {
      backendUrl: envBackendUrl,
      proxyPort: DEFAULT_PROXY_PORT,
    };
  }
  
  // Priority 2: Config file
  if (fs.existsSync(configFile)) {
    try {
      const content = fs.readFileSync(configFile, 'utf8');
      const parsed = JSON.parse(content);
      return {
        backendUrl: parsed.backendUrl || DEFAULT_BACKEND_URL,
        proxyPort: parsed.proxyPort || DEFAULT_PROXY_PORT,
        walletHash: parsed.walletHash,
        proxyPid: parsed.proxyPid,
      };
    } catch (err) {
      console.error('Failed to parse config:', err);
    }
  }
  
  // Priority 3: Default production backend
  return {
    backendUrl: DEFAULT_BACKEND_URL,
    proxyPort: DEFAULT_PROXY_PORT,
  };
}

export function saveConfig(configDir: string, config: Config): void {
  const configFile = getConfigFile(configDir);
  ensureConfigDir(configDir);
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
}

export function getPidFile(configDir: string): string {
  return path.join(configDir, 'proxy.pid');
}

export function getProxyScript(configDir: string): string {
  return path.join(configDir, 'proxy.js');
}

export function getLogFile(configDir: string): string {
  return path.join(configDir, 'proxy.log');
}

export function getWrapperScript(configDir: string): string {
  return path.join(configDir, 'paytaca-pay-wrapper.mjs');
}

export function getHeartbeatFile(configDir: string): string {
  return path.join(configDir, 'heartbeat');
}

// Touch the heartbeat file to signal the proxy we're still alive
export function updateHeartbeat(configDir: string): void {
  const heartbeatFile = getHeartbeatFile(configDir);
  try {
    // Write current timestamp
    fs.writeFileSync(heartbeatFile, Date.now().toString());
  } catch (err) {
    // Ignore errors
  }
}

// Start heartbeat interval that updates every 5 seconds
export function startHeartbeat(configDir: string): NodeJS.Timeout {
  // Update immediately
  updateHeartbeat(configDir);
  // Then every 5 seconds
  return setInterval(() => {
    updateHeartbeat(configDir);
  }, 5000);
}
