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
exports.getPaytacaCommand = getPaytacaCommand;
exports.isPortAvailable = isPortAvailable;
exports.findAvailablePort = findAvailablePort;
exports.isProcessRunning = isProcessRunning;
exports.getProxyStatus = getProxyStatus;
exports.startProxy = startProxy;
exports.getProxyConfig = getProxyConfig;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const crypto = __importStar(require("crypto"));
const child_process_1 = require("child_process");
const config_1 = require("./config");
const proxy_1 = require("./bundled/proxy");
const wrapper_1 = require("./bundled/wrapper");
function getPaytacaCommand() {
    try {
        const paytacaCliPkg = require.resolve('paytaca-cli/package.json');
        return path.resolve(path.dirname(paytacaCliPkg), 'bin', 'paytaca.js');
    }
    catch { }
    const localPaytaca = path.join(__dirname, '..', 'node_modules', '.bin', 'paytaca');
    if (fs.existsSync(localPaytaca)) {
        return localPaytaca;
    }
    try {
        const globalRoot = (0, child_process_1.execSync)('npm root -g', { encoding: 'utf8' }).trim();
        const pathsToCheck = [
            path.join(globalRoot, 'paytaca-cli', 'bin', 'paytaca.js'),
            path.join(globalRoot, '@paytaca', 'opencode-plugin', 'node_modules', 'paytaca-cli', 'bin', 'paytaca.js'),
        ];
        for (const p of pathsToCheck) {
            if (fs.existsSync(p)) {
                return p;
            }
        }
    }
    catch { }
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
        const result = (0, child_process_1.execSync)(`${which} paytaca`, { encoding: 'utf8' }).trim().split('\n')[0];
        if (result) {
            return result;
        }
    }
    catch { }
    return 'paytaca';
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
        server.listen(port);
    });
}
async function waitForPortFree(port, timeout = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        if (await isPortAvailable(port)) {
            return true;
        }
        await new Promise(resolve => setTimeout(resolve, 300));
    }
    return false;
}
function scriptHash() {
    return crypto.createHash('sha1').update(proxy_1.PROXY_SCRIPT_CONTENT).digest('hex');
}
function persistProxyInfo(configDir, config, port, pid, currentHash) {
    fs.writeFileSync((0, config_1.getPidFile)(configDir), pid.toString());
    config.proxyPort = port;
    config.proxyPid = pid;
    config.proxyScriptHash = currentHash;
    (0, config_1.saveConfig)(configDir, config);
}
async function reuseExistingProxy(configDir, config, status, currentHash) {
    persistProxyInfo(configDir, config, status.port, status.pid, currentHash);
    return { port: status.port, pid: status.pid };
}
async function tryAdoptExistingFreshProxy(configDir, config, currentHash) {
    const status = await getProxyStatus(configDir);
    if (status.running && status.pid && status.port && status.pid > 0 &&
        (0, config_1.loadConfig)(configDir).proxyScriptHash === currentHash) {
        return await reuseExistingProxy(configDir, config, { port: status.port, pid: status.pid }, currentHash);
    }
    return null;
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
    }
    return { running: false };
}
async function startProxy(configDir, config) {
    const proxyScript = (0, config_1.getProxyScript)(configDir);
    const logFile = (0, config_1.getLogFile)(configDir);
    const wrapperScript = (0, config_1.getWrapperScript)(configDir);
    (0, config_1.ensureConfigDir)(configDir);
    // Always refresh the payment wrapper on disk. It is executed fresh on every
    // payment, so it must never go stale even when the proxy is reused/restarted.
    fs.writeFileSync(wrapperScript, wrapper_1.WRAPPER_SCRIPT_CONTENT, 'utf8');
    fs.chmodSync(wrapperScript, '755');
    const currentHash = scriptHash();
    const persistedConfig = (0, config_1.loadConfig)(configDir);
    let existingStatus = await getProxyStatus(configDir);
    const needsRestart = existingStatus.running &&
        (existingStatus.pid || 0) > 0 &&
        persistedConfig.proxyScriptHash !== currentHash;
    if (existingStatus.running && existingStatus.pid && existingStatus.port && !needsRestart) {
        return await reuseExistingProxy(configDir, config, { port: existingStatus.port, pid: existingStatus.pid }, currentHash);
    }
    fs.writeFileSync(proxyScript, proxy_1.PROXY_SCRIPT_CONTENT, 'utf8');
    fs.chmodSync(proxyScript, '755');
    if (existingStatus.running && existingStatus.pid) {
        try {
            process.kill(existingStatus.pid);
        }
        catch { }
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
        }
        catch { }
    }
    console.error(`[paytaca] Proxy failed to start within ${MAX_ATTEMPTS} attempts`);
    throw new Error(`Proxy failed to start within ${MAX_ATTEMPTS} attempts`);
}
async function waitForProxy(port, timeout = 30000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        try {
            const response = await fetch(`http://localhost:${port}/v1/config`, {
                signal: AbortSignal.timeout(8000)
            });
            if (response.ok) {
                return true;
            }
        }
        catch {
        }
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    return false;
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