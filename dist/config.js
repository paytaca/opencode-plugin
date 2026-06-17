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
exports.DEFAULT_PROXY_PORT = exports.DEFAULT_BACKEND_URL = void 0;
exports.getConfigDir = getConfigDir;
exports.ensureConfigDir = ensureConfigDir;
exports.getConfigFile = getConfigFile;
exports.loadConfig = loadConfig;
exports.saveConfig = saveConfig;
exports.getPidFile = getPidFile;
exports.getProxyScript = getProxyScript;
exports.getLogFile = getLogFile;
exports.getWrapperScript = getWrapperScript;
exports.getHeartbeatFile = getHeartbeatFile;
exports.updateHeartbeat = updateHeartbeat;
exports.startHeartbeat = startHeartbeat;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
// Default production backend
exports.DEFAULT_BACKEND_URL = 'https://api.paytaca.ai';
exports.DEFAULT_PROXY_PORT = 8001;
// Config directory: ~/.opencode-paytaca/
function getConfigDir() {
    const home = process.env.HOME || process.env.USERPROFILE || '.';
    return path.join(home, '.opencode-paytaca');
}
function ensureConfigDir(configDir) {
    if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
    }
}
function getConfigFile(configDir) {
    return path.join(configDir, 'config.json');
}
function loadConfig(configDir) {
    const configFile = getConfigFile(configDir);
    // Priority 1: Environment variable (highest priority, for dev/testing)
    const envBackendUrl = process.env.PAYTACA_BACKEND_URL;
    if (envBackendUrl) {
        return {
            backendUrl: envBackendUrl,
            proxyPort: exports.DEFAULT_PROXY_PORT,
        };
    }
    // Priority 2: Config file
    if (fs.existsSync(configFile)) {
        try {
            const content = fs.readFileSync(configFile, 'utf8');
            const parsed = JSON.parse(content);
            return {
                backendUrl: parsed.backendUrl || exports.DEFAULT_BACKEND_URL,
                proxyPort: parsed.proxyPort || exports.DEFAULT_PROXY_PORT,
                walletHash: parsed.walletHash,
                proxyPid: parsed.proxyPid,
            };
        }
        catch (err) {
            console.error('Failed to parse config:', err);
        }
    }
    // Priority 3: Default production backend
    return {
        backendUrl: exports.DEFAULT_BACKEND_URL,
        proxyPort: exports.DEFAULT_PROXY_PORT,
    };
}
function saveConfig(configDir, config) {
    const configFile = getConfigFile(configDir);
    ensureConfigDir(configDir);
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
}
function getPidFile(configDir) {
    return path.join(configDir, 'proxy.pid');
}
function getProxyScript(configDir) {
    return path.join(configDir, 'proxy.js');
}
function getLogFile(configDir) {
    return path.join(configDir, 'proxy.log');
}
function getWrapperScript(configDir) {
    return path.join(configDir, 'paytaca-pay-wrapper.mjs');
}
function getHeartbeatFile(configDir) {
    return path.join(configDir, 'heartbeat');
}
// Touch the heartbeat file to signal the proxy we're still alive
function updateHeartbeat(configDir) {
    const heartbeatFile = getHeartbeatFile(configDir);
    try {
        // Write current timestamp
        fs.writeFileSync(heartbeatFile, Date.now().toString());
    }
    catch (err) {
        // Ignore errors
    }
}
// Start heartbeat interval that updates every 5 seconds
function startHeartbeat(configDir) {
    // Update immediately
    updateHeartbeat(configDir);
    // Then every 5 seconds
    return setInterval(() => {
        updateHeartbeat(configDir);
    }, 5000);
}
//# sourceMappingURL=config.js.map