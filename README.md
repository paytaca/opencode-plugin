# opencode-plugin

An [OpenCode](https://opencode.ai) plugin that connects to **Paytaca AI** — an AI inference provider powered by Bitcoin Cash micropayments.

## How it works

1. OpenCode loads the plugin on startup
2. The plugin checks for `paytaca-cli` and ensures a wallet exists (auto-creates one if needed)
3. A local proxy server is started (or an existing one is reused) on `localhost:8001`
4. All LLM requests go through the proxy, which forwards them to the Paytaca backend
5. When a **402 Payment Required** response is received, the proxy intercepts it, shows a payment prompt via SSE, and handles approval/inline payment through the paytaca-cli x402 module

## Requirements

- **Node.js** >= 20.0.0
- **OpenCode** >= 1.0.0

## Installation

```bash
# Global install (recommended)
opencode plugin @paytaca/opencode-plugin -g

# Or project-scoped
opencode plugin @paytaca/opencode-plugin
```

The `paytaca-cli` is bundled as a dependency and installed automatically.

## Usage

Once installed and configured in your OpenCode settings, the plugin automatically:

- Creates a wallet on first run (recovery phrase is printed — save it securely)
- Starts a local proxy that manages x402 payment flows transparently
- Provides the `paytaca-ai` provider with the `deepseek/deepseek-v4-flash` model
- Registers a local MCP server (`paytaca`) whose tools let the assistant answer account questions with real data — credits, wallet balance, available models, and plan pricing

### Asking about your account

Because the MCP server is loaded automatically, you can ask in plain language:

- "How many credits do I have left?"
- "What models are available?"
- "How much does DeepSeek V4 Pro cost?"
- "What's my wallet balance?"

The assistant answers using live data from the Paytaca backend via these tools:

| Tool | Description |
|---|---|
| `get_credits` | Remaining time credits per active model session |
| `get_balance` | BCH balance of the Paytaca wallet |
| `get_models` | Available models (id, display name, tier) |
| `get_plans` | Plan pricing grouped by tier (minutes, USD, BCH) |

### Proxy chatter never reaches the model

Payment prompts, tier-selection menus, credits output, and payment notices
produced by the proxy stay visible in your session for you — but they are
stripped from the context sent to the LLM, so coding conversations are not
polluted by payment flow messages. Your replies in those flows (e.g. picking
a plan tier) are also excluded, while all genuine coding messages pass
through untouched.

### Wallet management

A wallet is created automatically, but you can manage it manually:

```bash
# Check wallet status
paytaca wallet info

# Import existing wallet
paytaca wallet import

# Get receiving address
paytaca receive
```

## Configuration

Config is stored in `~/.opencode-paytaca/config.json`:

| Field | Default | Description |
|---|---|---|
| `backendUrl` | `https://api.paytaca.ai` | Paytaca API backend |
| `proxyPort` | `8001` | Local proxy port (auto-chooses 8001–8010) |

Override via `PAYTACA_BACKEND_URL` environment variable (highest priority).

## Architecture

```
┌──────────┐    LLM request     ┌──────────────┐     forward     ┌─────────────────┐
│  OpenCode │ ─────────────────→ │  Proxy       │ ──────────────→ │  Paytaca API    │
│           │                    │  localhost   │                 │  api.paytaca.ai │
│  (editor) │ ←──────────────── │  :8001-8010  │ ←────────────── │                 │
└──────────┘    response        └──────┬───────┘    response     └─────────────────┘
                                       │
                              ┌────────▼────────┐
                              │  402 Payment    │
                              │  intercepted    │
                              └────────┬────────┘
                                       │
                              ┌────────▼────────┐
                              │  paytaca-cli    │
                              │  (wallet/x402)  │
                              └─────────────────┘
```

The proxy runs as a detached Node.js process. It stays running from the first OpenCode session until the machine shuts down (or the process is killed with `kill <pid>`), so it survives laptop sleep and subsequent OpenCode launches reuse it — no context loss, faster startup.

## License

MIT
