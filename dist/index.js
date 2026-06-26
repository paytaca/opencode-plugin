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
const config_1 = require("./config");
const wallet_1 = require("./wallet");
const proxy_1 = require("./proxy");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
async function OpencodePlugin(_input, _options) {
    const configDir = (0, config_1.getConfigDir)();
    (0, config_1.ensureConfigDir)(configDir);
    let config = (0, config_1.loadConfig)(configDir);
    // Ensure paytaca binary is on PATH for internal use
    (0, wallet_1.ensurePaytacaOnPath)();
    // Check if paytaca-cli is installed
    const hasPaytacaCli = await (0, wallet_1.checkPaytacaCli)();
    if (!hasPaytacaCli) {
        console.error('paytaca-cli not found. Install it with: npm install -g paytaca-cli');
        return {};
    }
    // Ensure wallet exists (auto-create if needed)
    try {
        const wallet = await (0, wallet_1.ensureWallet)();
        // Save wallet hash to config
        if (wallet.hash) {
            config.walletHash = wallet.hash;
            (0, config_1.saveConfig)(configDir, config);
        }
    }
    catch (err) {
        console.error('Wallet setup failed:', err.message);
        return {};
    }
    // Auto-create paytaca-ai credential so OpenCode never prompts for an API key
    const authDir = path.join(os.homedir(), '.local', 'share', 'opencode');
    const authFile = path.join(authDir, 'auth.json');
    if (fs.existsSync(authFile)) {
        try {
            const auth = JSON.parse(fs.readFileSync(authFile, 'utf8'));
            if (!auth['paytaca-ai']) {
                auth['paytaca-ai'] = { type: 'api', key: 'paytaca-wallet-auth' };
                fs.writeFileSync(authFile, JSON.stringify(auth, null, 2));
            }
        }
        catch (e) {
            console.error('Failed to update auth.json:', e);
        }
    }
    // Start or reuse proxy
    const proxy = await (0, proxy_1.startProxy)(configDir, config);
    return {
        config: async (cfg) => {
            cfg.provider = cfg.provider || {};
            // Fetch available models from proxy config endpoint
            let models = {};
            try {
                const response = await fetch(`http://localhost:${proxy.port}/v1/config`);
                if (response.ok) {
                    const backendConfig = await response.json();
                    const configData = backendConfig;
                    if (configData.models && Array.isArray(configData.models)) {
                        for (const model of configData.models) {
                            models[model.id] = {
                                name: model.display_name || model.id,
                                limit: {
                                    context: 128000,
                                    output: 8192,
                                },
                            };
                        }
                    }
                }
            }
            catch (err) {
                console.error('Failed to fetch models from proxy:', err);
            }
            // Fallback if no models fetched
            if (Object.keys(models).length === 0) {
                models['deepseek-ai/DeepSeek-V4-Flash'] = {
                    name: 'DeepSeek V4 Flash',
                    limit: {
                        context: 128000,
                        output: 8192,
                    },
                };
            }
            cfg.provider['paytaca-ai'] = {
                npm: '@ai-sdk/openai-compatible',
                name: 'Paytaca AI',
                options: {
                    baseURL: `http://localhost:${proxy.port}/v1`,
                },
                models,
            };
        },
        "chat.headers": async (_input, output) => {
            let wallet = await (0, wallet_1.checkWallet)();
            if (!wallet.exists) {
                wallet = await (0, wallet_1.ensureWallet)();
            }
            output.headers = {
                'X-Wallet-Hash': wallet.hash || '',
            };
        },
    };
}
module.exports = { id: '@paytaca/opencode-plugin', server: OpencodePlugin };
//# sourceMappingURL=index.js.map