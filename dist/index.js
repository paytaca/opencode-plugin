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
    let walletHashSource = 'missing';
    let cachedWalletHash = '';
    try {
        const wallet = await (0, wallet_1.ensureWallet)();
        // Fresh hash parsed from paytaca CLI at load
        if (wallet.hash) {
            config.walletHash = wallet.hash;
            cachedWalletHash = wallet.hash;
            walletHashSource = 'cli';
            (0, config_1.saveConfig)(configDir, config);
        }
        else {
            // CLI had no hash (e.g. keychain unreachable) — fall back to the
            // hash we persisted on a previous successful run, if any.
            cachedWalletHash = config.walletHash || '';
            walletHashSource = cachedWalletHash ? 'config' : 'missing';
        }
    }
    catch (err) {
        console.error('Wallet setup failed:', err.message);
        // Even if wallet setup threw, try to fall back to a previously
        // persisted wallet hash so we don't fail closed when the CLI is
        // temporarily unreachable but we already know the wallet.
        cachedWalletHash = config.walletHash || '';
        walletHashSource = cachedWalletHash ? 'config' : 'missing';
        if (!cachedWalletHash) {
            return {};
        }
    }
    if (walletHashSource === 'missing') {
        console.error('⚠️  No Paytaca wallet hash available. X-Wallet-Hash will NOT be sent. Reinstall/restart the plugin or run: paytaca wallet info');
    }
    else {
        console.log(`🔑 Wallet hash source: ${walletHashSource}`);
    }
    // Auto-create paytaca-ai credential so OpenCode never prompts for an API key
    const authCandidates = [
        path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json'),
        path.join(os.homedir(), 'Library', 'Application Support', 'opencode', 'auth.json'),
    ];
    if (process.env.APPDATA) {
        authCandidates.push(path.join(process.env.APPDATA, 'opencode', 'auth.json'));
    }
    let authFile = authCandidates[0];
    for (const f of authCandidates) {
        if (fs.existsSync(f)) {
            authFile = f;
            break;
        }
    }
    if (fs.existsSync(authFile)) {
        try {
            const auth = JSON.parse(fs.readFileSync(authFile, 'utf8'));
            if (!auth['paytaca-ai']) {
                auth['paytaca-ai'] = { type: 'api', key: 'sk-paytaca-wallet-auth' };
                fs.writeFileSync(authFile, JSON.stringify(auth, null, 2));
            }
        }
        catch (e) {
            console.error('Failed to update auth.json:', e);
        }
    }
    // Start or reuse proxy
    const proxy = await (0, proxy_1.startProxy)(configDir, config);
    // Auto-install paytaca-wallet skill globally (copy from paytaca-cli dependency)
    try {
        const skillCandidates = [
            path.join(os.homedir(), '.config', 'opencode', 'skills'),
            path.join(os.homedir(), 'Library', 'Application Support', 'opencode', 'skills'),
        ];
        if (process.env.APPDATA) {
            skillCandidates.push(path.join(process.env.APPDATA, 'opencode', 'skills'));
        }
        let globalSkillsDir = skillCandidates[0];
        for (const d of skillCandidates) {
            if (fs.existsSync(d) || d === skillCandidates[0]) {
                globalSkillsDir = d;
                break;
            }
        }
        const walletSkillDir = path.join(globalSkillsDir, 'paytaca-wallet');
        if (!fs.existsSync(walletSkillDir)) {
            const paytacaCliPkg = require.resolve('paytaca-cli/package.json');
            const srcSkillDir = path.resolve(path.dirname(paytacaCliPkg), 'skills', 'paytaca-wallet');
            const srcSkillFile = path.join(srcSkillDir, 'SKILL.md');
            if (fs.existsSync(srcSkillFile)) {
                fs.mkdirSync(walletSkillDir, { recursive: true });
                fs.copyFileSync(srcSkillFile, path.join(walletSkillDir, 'SKILL.md'));
            }
        }
    }
    catch (e) {
        console.error('Failed to install paytaca-wallet skill:', e.message);
    }
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
                models['deepseek/deepseek-v4-flash'] = {
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
            // Inject X-Wallet-Hash into the provider's options.headers so it is
            // forwarded reliably by the AI SDK (matches the mechanism the older
            // opencode.json setup used). Only set when we have a hash, so a
            // hardcoded header in the user's own opencode.json is preserved.
            if (cachedWalletHash) {
                const existing = cfg.provider['paytaca-ai'].options.headers || {};
                cfg.provider['paytaca-ai'].options.headers = {
                    ...existing,
                    'X-Wallet-Hash': cachedWalletHash,
                };
            }
        },
        "chat.headers": async (_input, output) => {
            // Secondary fallback delivery path. Never send an empty value —
            // opencode/SDK may strip an empty header, which would make the
            // proxy report a missing X-Wallet-Hash.
            if (cachedWalletHash) {
                output.headers = {
                    ...(output.headers || {}),
                    'X-Wallet-Hash': cachedWalletHash,
                };
            }
        },
    };
}
module.exports = { id: '@paytaca/opencode-plugin', server: OpencodePlugin };
//# sourceMappingURL=index.js.map