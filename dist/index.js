"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = OpencodePlugin;
const config_1 = require("./config");
const wallet_1 = require("./wallet");
const proxy_1 = require("./proxy");
async function OpencodePlugin() {
    const configDir = (0, config_1.getConfigDir)();
    (0, config_1.ensureConfigDir)(configDir);
    let config = (0, config_1.loadConfig)(configDir);
    // Check if paytaca-cli is installed
    const hasPaytacaCli = await (0, wallet_1.checkPaytacaCli)();
    if (!hasPaytacaCli) {
        return {
            connect: {
                types: [{
                        name: 'paytaca-ai',
                        description: 'Connect to Paytaca AI (requires paytaca-cli)',
                        async connect() {
                            return {
                                error: `paytaca-cli could not be found. This is unexpected — try reinstalling opencode-plugin:\n\n  npm install @paytaca/opencode-plugin\n\nIf the issue persists, run:\n\n  npm install -g paytaca-cli`
                            };
                        }
                    }]
            }
        };
    }
    // Ensure wallet exists (auto-create if needed)
    try {
        const wallet = await (0, wallet_1.ensureWallet)();
        // Save wallet hash to config
        if (wallet.hash && wallet.hash !== config.walletHash) {
            config.walletHash = wallet.hash;
            (0, config_1.saveConfig)(configDir, config);
        }
    }
    catch (err) {
        console.error('Wallet setup failed:', err.message);
        return {
            connect: {
                types: [{
                        name: 'paytaca-ai',
                        description: 'Connect to Paytaca AI (requires wallet setup)',
                        async connect() {
                            return {
                                error: 'Wallet setup required. Please run: paytaca wallet create (for new) or paytaca wallet import (for existing)'
                            };
                        }
                    }]
            }
        };
    }
    // Start or reuse proxy
    const proxy = await (0, proxy_1.startProxy)(configDir, config);
    return {
        // Simple return - just connection type and exit handler
        connect: {
            types: [{
                    name: 'paytaca-ai',
                    description: 'Connect to Paytaca AI (AI inference powered by Bitcoin Cash micropayments)',
                    async connect() {
                        return {
                            provider: {
                                'paytaca-ai': {
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
                                }
                            }
                        };
                    }
                }]
        },
        async onExit() {
            await (0, proxy_1.stopProxy)(configDir);
        }
    };
}
//# sourceMappingURL=index.js.map