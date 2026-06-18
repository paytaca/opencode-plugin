import { ensureConfigDir, getConfigDir, loadConfig, saveConfig } from './config';
import { checkWallet, ensureWallet, checkPaytacaCli } from './wallet';
import { startProxy } from './proxy';

async function OpencodePlugin(_input?: any, _options?: any) {
  const configDir = getConfigDir();
  ensureConfigDir(configDir);

  let config = loadConfig(configDir);

  // Check if paytaca-cli is installed
  const hasPaytacaCli = await checkPaytacaCli();
  if (!hasPaytacaCli) {
    console.error('paytaca-cli not found. Install it with: npm install -g paytaca-cli');
    return {};
  }

  // Ensure wallet exists (auto-create if needed)
  try {
    const wallet = await ensureWallet();

    // Save wallet hash to config
    if (wallet.hash) {
      config.walletHash = wallet.hash;
      saveConfig(configDir, config);
    }
  } catch (err: any) {
    console.error('Wallet setup failed:', err.message);
    return {};
  }

  // Start or reuse proxy
  const proxy = await startProxy(configDir, config);

  return {
    config: async (cfg: any) => {
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
    "chat.headers": async (_input: any, output: any) => {
      let wallet = await checkWallet();
      if (!wallet.exists) {
        wallet = await ensureWallet();
      }
      output.headers = {
        'X-Wallet-Hash': wallet.hash || ''
      };
    }
  };
}

export = { id: '@paytaca/opencode-plugin', server: OpencodePlugin };
