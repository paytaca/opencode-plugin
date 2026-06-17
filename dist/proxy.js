"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.isPortAvailable = isPortAvailable;
exports.findAvailablePort = findAvailablePort;
exports.isProcessRunning = isProcessRunning;
exports.getProxyStatus = getProxyStatus;
exports.startProxy = startProxy;
exports.stopProxy = stopProxy;
exports.getProxyConfig = getProxyConfig;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const child_process_1 = require("child_process");
const config_1 = require("./config");
const proxy_1 = require("./bundled/proxy");
const wrapper_1 = require("./bundled/wrapper");
// Store heartbeat interval reference
let heartbeatInterval = null;
// Get path to local paytaca binary
function getPaytacaCommand() {
    const localPaytaca = path.join(__dirname, '..', 'node_modules', '.bin', 'paytaca');
    return fs.existsSync(localPaytaca) ? localPaytaca : 'paytaca';
}
async function isPortAvailable(port) {
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
async function findAvailablePort(startPort = 8001, endPort = 8010) {
    for (let port = startPort; port <= endPort; port++) {
        if (await isPortAvailable(port)) {
            return port;
        }
    }
    throw new Error(`No available ports in range ${startPort}-${endPort}`);
}
function isProcessRunning(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
async function getProxyStatus(configDir) {
    const pidFile = (0, config_1.getPidFile)(configDir);
    if (!fs.existsSync(pidFile)) {
        return { running: false };
    }
    try {
        const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim());
        if (isProcessRunning(pid)) {
            const config = (0, config_1.loadConfig)(configDir);
            return { running: true, port: config.proxyPort, pid };
        }
    }
    catch {
        // Invalid PID file
    }
    return { running: false };
}
async function startProxy(configDir, config) {
    const pidFile = (0, config_1.getPidFile)(configDir);
    const proxyScript = (0, config_1.getProxyScript)(configDir);
    const logFile = (0, config_1.getLogFile)(configDir);
    const wrapperScript = (0, config_1.getWrapperScript)(configDir);
    // Ensure config directory exists
    (0, config_1.ensureConfigDir)(configDir);
    // Check if proxy already running
    const existingStatus = await getProxyStatus(configDir);
    if (existingStatus.running && existingStatus.pid && existingStatus.port) {
        // Just reuse existing proxy, update heartbeat
        const heartbeatFile = (0, config_1.getHeartbeatFile)(configDir);
        fs.writeFileSync(heartbeatFile, Date.now().toString());
        // Start heartbeat updates
        if (heartbeatInterval) {
            clearInterval(heartbeatInterval);
        }
        heartbeatInterval = setInterval(() => {
            try {
                fs.writeFileSync(heartbeatFile, Date.now().toString());
            }
            catch { }
        }, 5000);
        return {
            port: existingStatus.port,
            pid: existingStatus.pid
        };
    }
    // Find available port
    const port = await findAvailablePort(8001, 8010);
    // Write bundled proxy script to config directory
    fs.writeFileSync(proxyScript, proxy_1.PROXY_SCRIPT_CONTENT, 'utf8');
    fs.chmodSync(proxyScript, '755');
    // Write bundled wrapper script to config directory
    fs.writeFileSync(wrapperScript, wrapper_1.WRAPPER_SCRIPT_CONTENT, 'utf8');
    fs.chmodSync(wrapperScript, '755');
    // Start proxy (detached to avoid receiving SIGINT from terminal)
    const paytacaCmd = getPaytacaCommand();
    const proxy = (0, child_process_1.spawn)('node', [
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
    // Update config - new proxy
    const updatedConfig = (0, config_1.loadConfig)(configDir);
    updatedConfig.proxyPort = port;
    updatedConfig.proxyPid = proxy.pid;
    (0, config_1.saveConfig)(configDir, updatedConfig);
    // Initialize heartbeat file
    const heartbeatFile = (0, config_1.getHeartbeatFile)(configDir);
    fs.writeFileSync(heartbeatFile, Date.now().toString());
    // Start heartbeat updates
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
    }
    heartbeatInterval = setInterval(() => {
        try {
            fs.writeFileSync(heartbeatFile, Date.now().toString());
        }
        catch { }
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
async function stopProxy(configDir) {
    // Stop heartbeat updates
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
    }
    // Note: We don't kill the proxy here anymore.
    // The proxy monitors the heartbeat file and exits itself when stale.
    // This handles multi-window scenarios correctly.
    // Optional: Write a special "stopping" timestamp to speed up proxy shutdown
    const heartbeatFile = (0, config_1.getHeartbeatFile)(configDir);
    try {
        fs.writeFileSync(heartbeatFile, '0'); // Special value: stopping
        // Remove heartbeat file after a short delay
        setTimeout(() => {
            try {
                if (fs.existsSync(heartbeatFile)) {
                    fs.unlinkSync(heartbeatFile);
                }
            }
            catch { }
        }, 100);
    }
    catch { }
}
async function waitForProxy(port, timeout = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        try {
            const response = await fetch(`http://localhost:${port}/v1/config`, {
                signal: AbortSignal.timeout(1000)
            });
            if (response.ok) {
                return;
            }
        }
        catch {
            // Not ready yet
        }
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error(`Proxy failed to start on port ${port} within ${timeout}ms`);
}
async function getProxyConfig(configDir) {
    const status = await getProxyStatus(configDir);
    if (status.running && status.port) {
        const config = (0, config_1.loadConfig)(configDir);
        return {
            backendUrl: config.backendUrl,
            port: status.port
        };
    }
    return null;
}
//# sourceMappingURL=proxy.js.map