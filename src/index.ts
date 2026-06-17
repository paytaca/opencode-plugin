import { ensureConfigDir, getConfigDir, loadConfig, saveConfig } from './config';
import { ensureWallet, checkWallet, checkPaytacaCli } from './wallet';
import { startProxy, stopProxy } from './proxy';

export default async function OpencodePlugin() {
  const configDir = getConfigDir();
  ensureConfigDir(configDir);
  
  let config = loadConfig(configDir);
  
  // Check if paytaca-cli is installed
  const hasPaytacaCli = await checkPaytacaCli();
  if (!hasPaytacaCli) {
    return {
      connect: {
        types: [{
          name: 'paytaca-ai',
          description: 'Connect to Paytaca AI (requires paytaca-cli)',
          async connect() {
            return {
              error: `paytaca-cli is not installed.\n\nPlease install it first:\n\n  npm install -g paytaca-cli\n\nThen restart OpenCode and try again.`
            };
          }
        }]
      }
    };
  }
  
  // Ensure wallet exists (auto-create if needed)
  try {
    const wallet = await ensureWallet();
    
    // Save wallet hash to config
    if (wallet.hash && wallet.hash !== config.walletHash) {
      config.walletHash = wallet.hash;
      saveConfig(configDir, config);
    }
  } catch (err: any) {
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
  const proxy = await startProxy(configDir, config);
  
  return {
    // Simple return - just connection type and exit handler
    connect: {
      types: [{
        name: 'paytaca-ai',
        description: 'Connect to Paytaca AI (BCH micropayments for DeepSeek V4 Flash)',
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
      await stopProxy(configDir);
    }
  };
}
