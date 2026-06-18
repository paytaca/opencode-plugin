# opencode-plugin

An [OpenCode](https://opencode.ai) plugin that connects to **Paytaca AI** — a BCH (Bitcoin Cash) micropayment provider for **DeepSeek V4 Flash**.

## How it works

1. OpenCode loads the plugin on startup
2. The plugin checks for `paytaca-cli` and ensures a wallet exists (auto-creates one if needed)
3. A local proxy server is started (or an existing one is reused) on `localhost:8001`
4. All LLM requests go through the proxy, which forwards them to the Paytaca backend
5. When a **402 Payment Required** response is received, the proxy intercepts it, shows a payment prompt via SSE, and handles approval/inline payment through the paytaca-cli x402 module

## Requirements

- **Node.js** >= 20.0.0
- **OpenCode** >= 1.0.0
- **paytaca-cli** (`npm install -g paytaca-cli`)

## Installation

```bash
npm install opencode-plugin
```

The `paytaca-cli` must be installed globally:

```bash
npm install -g paytaca-cli
```

## Usage

Once installed and configured in your OpenCode settings, the plugin automatically:

- Creates a wallet on first run (recovery phrase is printed — save it securely)
- Starts a local proxy that manages x402 payment flows transparently
- Provides the `paytaca-ai` provider with the `deepseek-ai/DeepSeek-V4-Flash` model

### Wallet management

A wallet is created automatically, but you can manage it manually:

```bash
# Check wallet status
paytaca wallet info

# Import existing wallet
paytaca wallet import

# Get receiving address
paytaca receive --no-qr
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
OpenCode → localhost:8001 (proxy) → api.paytaca.ai
                         ↕
              paytaca-cli (wallet / x402)
```

The proxy is a detached Node.js process with heartbeat monitoring. It auto-exits after 15 seconds without a heartbeat (when all editor windows close).

## License

MIT
