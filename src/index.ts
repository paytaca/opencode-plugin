import { ensureConfigDir, getConfigDir, loadConfig, saveConfig } from './config';
import { checkWallet, ensureWallet, checkPaytacaCli, ensurePaytacaOnPath } from './wallet';
import { startProxy } from './proxy';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

async function OpencodePlugin(_input?: any, _options?: any) {
  const configDir = getConfigDir();
  ensureConfigDir(configDir);

  let config = loadConfig(configDir);

  // Ensure paytaca binary is on PATH for internal use
  ensurePaytacaOnPath();

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
    } catch (e) {
      console.error('Failed to update auth.json:', e);
    }
  }

  // Start or reuse proxy
  const proxy = await startProxy(configDir, config);

  return {
    config: async (cfg: any) => {
      cfg.provider = cfg.provider || {};

      // Fetch available models from proxy config endpoint
      let models: Record<string, any> = {};
      try {
        const response = await fetch(`http://localhost:${proxy.port}/v1/config`);
        if (response.ok) {
          const backendConfig = await response.json();
          const configData = backendConfig as any;
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
      } catch (err) {
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
    "chat.headers": async (_input: any, output: any) => {
      let wallet = await checkWallet();
      if (!wallet.exists) {
        wallet = await ensureWallet();
      }
      output.headers = {
        'X-Wallet-Hash': wallet.hash || '',
      };
    },
  };
}

export = { id: '@paytaca/opencode-plugin', server: OpencodePlugin };
