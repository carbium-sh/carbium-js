# carbium

The command line for Carbium's Solana services on [services.carbium.sh](https://carbium.sh): sign in, service keys,
every served RPC and DAS method by name, swap quotes and unsigned swap builds, prices, WebSocket and Carbon Stream
tails, webhooks, usage and balance, DCA reads and unsigned builds, token lookups, shell completion. It runs on
`@carbium/sdk`. Nothing here signs or sends a transaction, no command holds a private key, and a key never appears in
output, on the command line or in logs.

```sh
npm install -g carbium
carbium --help
```

It runs on Node 22.12 or later and on Bun.

Without Node, take a standalone binary (Linux, macOS and Windows, x64 and arm64). Each is checked against the release's
`SHA256SUMS` before it is installed:

```sh
curl --proto '=https' --tlsv1.2 -fsSL https://raw.githubusercontent.com/carbium-sh/carbium-js/main/packages/cli/install.sh | sh
brew install carbium-sh/tap/carbium
scoop bucket add carbium https://github.com/carbium-sh/scoop-bucket; scoop install carbium/carbium
```

The script installs to `~/.carbium/bin` without sudo and prints the PATH line to add; `CARBIUM_VERSION=0.1.0` pins a
version. In GitHub Actions: `uses: carbium-sh/setup-carbium@v1`. The binaries and the script are the assets of the
`cli-vX.Y.Z` releases, attested by GitHub (`gh attestation verify <file> -R carbium-sh/carbium-js`); the binaries are
not yet signed by a publisher, so a browser download may meet a Windows or macOS warning. Alpine needs
`apk add libstdc++ libgcc`. Carbon Stream is not in the binaries: it needs the npm package.

## Update

On a terminal, `carbium` prints one line on stderr, at most once a day, when npm has a newer version. It is one keyless
read of npm's public registry a day, started with a command's first call to the network; that command waits up to a
second and a half for it after printing its own answer. It never runs in CI, in a pipe, or with `--json` or `--quiet`.
`carbium doctor` shows the latest version beside its own, and asks npm each time it runs.
`CARBIUM_NO_UPDATE_NOTIFIER=1` turns both off.

| Installed with | Update with |
|---|---|
| npm | `npm install -g carbium@latest` |
| the install script | the same line again |
| Homebrew | `brew upgrade carbium` |
| Scoop | `scoop update carbium` |
| GitHub Actions | nothing: `carbium-sh/setup-carbium@v1` installs the latest at each run |

Homebrew and Scoop follow npm within a day. Each version's notes are at
https://github.com/carbium-sh/carbium-js/releases.

## Quick start

```sh
# no key: the public hosts answer
carbium tokens lookup So11111111111111111111111111111111111111112
carbium plans
carbium dca health

# sign in by emailed code (opens the account on a new address), or paste an account key, or sign with your wallet
carbium login --email you@example.com
carbium login --key          # pasted at a hidden prompt, or piped: carbium login --key < key.txt
carbium login --wallet <pubkey>

# then
carbium test                 # getHealth and getLatestBlockhash with your service key
carbium rpc getSlot
carbium rpc getBalance <pubkey> '{"commitment":"confirmed"}' --json
carbium das getAssetsByOwner ownerAddress=<pubkey> limit=10
carbium quote So11111111111111111111111111111111111111112 EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v 100000000
carbium ws tail slot --count 3
carbium usage
```

`login` mints a read-only account key for the CLI (90 days), stores it with the first service key's value in
`~/.config/carbium/credentials.json` (mode 600; `%APPDATA%\carbium` on Windows), and never keeps the session. Writes are
off until `carbium login --full`, `carbium config set writes true`, or `--allow-writes` for one run. A write with a
read-only key is refused after one read of the key's own access, before any change.

## Commands

Positional params to `rpc` are JSON values (`'{"encoding":"base64"}'`, `7`, `"text"`); `das` takes `key=value` pairs.
`--json` prints the service's answer as served; otherwise a plain table. Data goes to stdout, status and errors to
stderr. `--help` on any command shows its flags.

Global options go before or after the command: `--json`, `-y`/`--yes`, `-q`/`--quiet`, `--no-input` (never prompt),
`--allow-writes` (write commands for this run), `--profile <name>` (for this run; `config use` sets the default),
`--endpoint`, `--dashboard`, `--dca-url`, `--tokens-url`, `--stream-url <url>` (the Carbon Stream host; by default the
services host name on port 9443, or `config set streamUrl`), `--key-file <path>`, `--service-key <name>`, `-h`/`--help`,
`-v`/`--version`.

| Group | Commands | Key |
|---|---|---|
| sign-in | `login --key` / `--email` / `--wallet` (`--full`, `--accept-terms`), `logout`, `whoami` | |
| rpc | `rpc <method> [params...]` for 53 served methods (`rpc list`), `--params-json`, `--confirm-cost` | service |
| das | `das <method> key=value...` for the 10 DAS methods (`das list`) | service |
| quote plane | `quote <src> <dst> <amount>`, `swap build <quote_id> <pubkey> [--out file]`, `prices <mint...>`, `health` | service (quote scope) |
| tails | `ws tail account\|program\|logs\|signature\|slot\|root\|slotsUpdates\|block [arg] --count`, `stream tail --accounts\|--owners\|--tx-include\|--slots\|--blocks-meta\|--blocks\|--entry`, `stream slot\|block-height\|latest-blockhash\|blockhash-valid\|version\|ping\|replay-info` | service |
| test | `test [--ws]`, `doctor`, `endpoints` | service |
| keys | `keys list`, `keys save <name>`, `keys create`, `keys rotate`, `keys revoke`, `keys delete`, `keys rename`, `keys scope`, `keys caps`, `keys allowlist`, `keys limits` | account (writes for changes) |
| webhooks | `webhooks list\|get\|deliveries`, `webhooks create --key-id --url --address... --secret-file`, `update <id> [--url] [--address...] [--name] [--tx-status] [--key-id] [--auth-header-env VAR\|--clear-auth-header]`, `pause`, `resume`, `test`, `rotate --secret-file`, `delete` | account (writes for changes) |
| account | `usage [--daily\|--hourly\|--latency\|--load]`, `balance`, `account`, `account invoices\|payments\|crypto-intent`, `modules`, `modules enable <module>`, `plans` | account |
| dca | `dca quote\|positions\|history\|position\|health`, `dca build open\|update\|withdraw\|close [--tx-out file]` | none |
| tokens | `tokens lookup\|search\|batch\|image` | none |
| local | `config list\|get\|set\|reset\|profiles\|use`, `completion bash\|zsh\|fish` | |

New service keys and webhook secrets are stored in the profile or written to a new 0600 file you name
(`--save-as`, `--secret-file`), never printed. A new `--url` with no header flag clears a webhook's Authorization header, so
`webhooks update` refuses it when the webhook has one. `swap build` and `dca build ...` return one unsigned transaction as
base64 for your own wallet to sign and send; the CLI never sends. `sendTransaction` and the DCA send route are not
offered. Expensive shapes (`getProgramAccounts` without filters, token scans without a mint, `getTransactionsForAddress`
walks, a full `getBlock`, `getMultipleAccounts` over 100 keys at 10 credits a key) stop with their cost unless you pass `--confirm-cost`.

Destructive commands (`revoke`, `rotate`, `delete`) ask for confirmation on a terminal and need `-y` otherwise.
Exit codes: 0 ok, 1 service error, 2 usage, 3 no key or refused, 4 credits or rate limit, 5 confirmation needed, 130
interrupted. Keys come from `--key-file`, the environment (`CARBIUM_KEY`, `CARBIUM_ACCOUNT_KEY`) or the stored
profile; a key typed on the command line is refused.

`stream tail` and the `stream` calls need the native Yellowstone client beside the CLI (`npm install -g
@triton-one/yellowstone-grpc`, from npm, for linux-x64 and darwin only) and a plan with Carbon Stream. A standalone
binary has no Carbon Stream. On FREE use `ws tail`. The stream client uses the system's CA certificates, not the ones
Node bundles, so on a slim image such as `node:24-slim` install the `ca-certificates` package or set `SSL_CERT_FILE` to
a CA bundle.

## Completion

Use the line for your shell only.

```sh
eval "$(carbium completion bash)" # bash: in ~/.bashrc
autoload -Uz compinit && compinit; eval "$(carbium completion zsh)" # zsh: in ~/.zshrc
mkdir -p ~/.config/fish/completions && carbium completion fish > ~/.config/fish/completions/carbium.fish # fish: run once
```

MIT. Issues: https://github.com/carbium-sh/carbium-js/issues.
