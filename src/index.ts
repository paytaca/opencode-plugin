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
  let walletHashSource: 'cli' | 'config' | 'missing' = 'missing';
  let cachedWalletHash = '';
  try {
    const wallet = await ensureWallet();

    // Fresh hash parsed from paytaca CLI at load
    if (wallet.hash) {
      config.walletHash = wallet.hash;
      cachedWalletHash = wallet.hash;
      walletHashSource = 'cli';
      saveConfig(configDir, config);
    } else {
      // CLI had no hash (e.g. keychain unreachable) — fall back to the
      // hash we persisted on a previous successful run, if any.
      cachedWalletHash = config.walletHash || '';
      walletHashSource = cachedWalletHash ? 'config' : 'missing';
    }
  } catch (err: any) {
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

  // Auto-create paytaca-ai credential so OpenCode never prompts for an API key
  const authCandidates: string[] = [
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
    } catch (e) {
      console.error('Failed to update auth.json:', e);
    }
  }

  // Start or reuse proxy
  const proxy = await startProxy(configDir, config);

  // Auto-install paytaca-wallet skill globally (copy from paytaca-cli dependency)
  try {
    const skillCandidates: string[] = [
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
  } catch (e: any) {
    console.error('Failed to install paytaca-wallet skill:', e.message);
  }

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
            const tierLabel = (t: any) => {
              const k = String(t || '').toLowerCase();
              if (k === 'budget') return 'Budget';
              if (k === 'premium') return 'Premium';
              if (k === 'frontier') return 'Frontier';
              return '';
            };
            for (const model of configData.models) {
              const suffix = tierLabel(model.tier);
              models[model.id] = {
                name: (model.display_name || model.id) + (suffix ? ' (' + suffix + ')' : ''),
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
        const existing = (cfg.provider['paytaca-ai'].options as any).headers || {};
        (cfg.provider['paytaca-ai'].options as any).headers = {
          ...existing,
          'X-Wallet-Hash': cachedWalletHash,
        };
      }
    },
    "chat.headers": async (_input: any, output: any) => {
      // Secondary fallback delivery path. Never send an empty value —
      // opencode/SDK may strip an empty header, which would make the
      // proxy report a missing X-Wallet-Hash.
      if (cachedWalletHash) {
        output.headers = {
          ...(output.headers || {}),
          'X-Wallet-Hash': cachedWalletHash,
        };
        return;
      }

      // Last-resort: cachedWalletHash was empty at startup (e.g. the wallet
      // CLI/keychain wasn't ready at that instant). Re-lookup the wallet now
      // that a request is being sent — mirrors the pre-v0.1.7 behavior where
      // the wallet was re-checked per request.
      try {
        const wallet = await checkWallet();
        if (wallet.hash) {
          cachedWalletHash = wallet.hash;
          output.headers = {
            ...(output.headers || {}),
            'X-Wallet-Hash': cachedWalletHash,
          };
        }
      } catch (e) {
        // Leave headers untouched — the proxy will surface the missing header.
      }
    },
  };
}

export = { id: '@paytaca/opencode-plugin', server: OpencodePlugin };
