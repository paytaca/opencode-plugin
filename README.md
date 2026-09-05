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
- Registers a local MCP server (`paytaca`) whose tools let the assistant work with real Paytaca data — AI account (credits, models, plan pricing) and wallet (balance, transactions, addresses, tokens, sending)

### Asking about your account and wallet

Because the MCP server is loaded automatically, you can ask in plain language:

- "How many credits do I have left?"
- "What models are available?"
- "How much does DeepSeek V4 Pro cost?"
- "What's my wallet balance?"
- "Show my latest transactions"
- "What's my receiving address?"

The assistant answers using live data via these tools:

| Tool | Description |
|---|---|
| `get_help` | Q&A guide on the wallet, funding, plans, paying with BCH or LIFT, and more |
| `get_credits` | Remaining time credits per active model session |
| `get_balance` | BCH balance of the Paytaca wallet |
| `get_models` | Available models (id, display name, tier) |
| `get_plans` | Plan pricing grouped by tier (minutes, USD, BCH) |
| `buy_plan` | Buy time credits for any model + plan duration (spends BCH or LIFT) |
| `auto_refill` | Arm/disarm automatic plan refills so long sessions never stall |
| `get_transactions` | Recent wallet transactions (filter by direction, page) |
| `get_receiving_address` | Receiving address, optionally as a BIP21 URI with amount |
| `get_tokens` | CashToken holdings, or details for one token category |

### Buying a plan

You can ask the assistant to buy a plan for any model — even one not active in
the current session ("buy the 30-minute DeepSeek V4 Flash plan"). The assistant
shows pricing with `get_plans`, then purchases via `buy_plan`, which runs the
same x402 payment flow as the interactive proxy prompt. Because this spends
real funds, opencode always asks for approval before the tool runs (the plugin
sets the `paytaca_buy_plan` permission to `ask`).

Plans can be paid with **BCH** (default) or with **LIFT tokens** — say "pay with
LIFT" or "pay with my LIFT tokens" and the tool sells your LIFT balance via
Cauldron to fund the plan. LIFT payments get a discount (rate set server-side;
the assistant can quote the current percent via `get_help` or `get_plans`).
You can't buy a plan while the model still has active credits — spending would
charge nothing and time doesn't stack, so use up or wait out remaining credits
before buying again.

### Auto-refilling a plan

For uninterrupted long sessions ("keep buying 15-minute plans until the task is
done, max 2 hours"), the assistant can arm `auto_refill`. When the model's
credits run out mid-task, the plugin then silently buys another plan of the
chosen size and keeps working — no interactive prompt — until either the task
finishes, `auto_refill` is disarmed, or the total auto-bought minutes reach your
cap. Each refill is a real wallet payment (BCH, or LIFT when requested), so
opencode prompts for approval when the tool is armed.

### Free concierge answers

Even with no paid capacity left, balance and "how it works" questions are
answered for free: the backend runs a lightweight concierge model and, when your
wallet can't pay, answers questions about your BCH/LIFT balance, models, pricing,
and how to top up — instead of a bare `402`. Genuine purchases still require
payment and are never stuck behind the concierge. Accounts with paid capacity
get the concierge too, but the real model answers as usual.

### Sending funds

You can ask the assistant to send BCH or CashTokens ("send 0.01 BCH to
bitcoincash:qp..."). Because that spends real funds, opencode will always
prompt you for approval before the `send` tool executes — the plugin sets the
`paytaca_send` permission to `ask` (an explicit choice in your own config is
respected). Token amounts are in base units and recipients should use
token-aware (z-prefix) addresses.

### Proxy chatter never reaches the model

Payment prompts, tier-selection menus, credits output, and payment notices
produced by the proxy stay visible in your session for you — but they are
stripped from the context sent to the LLM, so coding conversations are not
polluted by payment flow messages. Your replies in those flows (e.g. picking
a plan tier) are also excluded, while all genuine coding messages pass
through untouched.

### Automatic updates

The plugin keeps itself installable and up to date without manual cleanup:

- At startup it checks npm for a newer published version (5s timeout, fully
  offline-safe). If one exists, it clears everything that would keep opencode
  resolving the old one — semver-pinned dependency specs, stale lockfiles, and
  stale plugin cache entries — so the next session or install picks it up.
- Every install re-pins the dependency spec to the exact installed version
  (avoids the `^0.x` semver trap that hides new releases) and removes
  other-version cache entries.

Set `PAYTACA_SELF_UPDATE=0` to disable the startup check. Activity is logged
to `~/.opencode-paytaca/selfheal.log`.

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
