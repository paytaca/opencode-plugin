"use strict";
const config_1 = require("./config");
const wallet_1 = require("./wallet");
const proxy_1 = require("./proxy");
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
    // Start or reuse proxy
    const proxy = await (0, proxy_1.startProxy)(configDir, config);
    return {
        config: async (cfg) => {
            cfg.provider = cfg.provider || {};
            cfg.provider['paytaca-ai'] = {
                npm: '@ai-sdk/openai-compatible',
                name: 'Paytaca AI',
                options: {
                    baseURL: `http://localhost:${proxy.port}/v1`
                },
                models: {
                    'deepseek-ai/DeepSeek-V4-Flash': {
                        name: 'DeepSeek V4 Flash',
                        limit: {
                            context: 128000,
                            output: 8192
                        }
                    }
                }
            };
        },
        "chat.headers": async (_input, output) => {
            let wallet = await (0, wallet_1.checkWallet)();
            if (!wallet.exists) {
                wallet = await (0, wallet_1.ensureWallet)();
            }
            output.headers = {
                'X-Wallet-Hash': wallet.hash || ''
            };
        }
    };
}
module.exports = { id: '@paytaca/opencode-plugin', server: OpencodePlugin };
//# sourceMappingURL=index.js.map