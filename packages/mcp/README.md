# @carbium/mcp

An MCP server for Carbium's Solana services on [services.carbium.sh](https://carbium.sh), for Claude Code, Claude
Desktop, Cursor, VS Code, Codex and any MCP client. It runs on `@carbium/sdk`: Solana JSON-RPC reads by method name,
DAS, swap quotes and prices, unsigned swap and DCA transactions, token metadata, Carbium's own documentation, and the
account API (usage, keys, webhooks). Read-only by design: no tool holds a key, signs, sends or moves funds; swap and DCA
tools return one unsigned transaction for the user's own wallet. Every answer is wrapped as untrusted data, and keys
never appear in any output.

```sh
npx -y @carbium/mcp
```

It runs on Node 22.12 or later. `npx -y @carbium/mcp` takes the newest version at each start; a container runs the tag
it names, so change the tag to update. Each version's notes are at https://github.com/carbium-sh/carbium-js/releases.

## Add it to your client

The key goes in the server's environment, never in a URL. Without any key five tools work: the three on the
public hosts, and `carbium_swap` and the public methods of `carbium_rpc` at 30 calls a minute per IP address. Each client
reads its own file and its own variable syntax.

Claude Code, from the command line:

```sh
claude mcp add carbium --env CARBIUM_KEY="$CARBIUM_KEY" -- npx -y @carbium/mcp
```

Claude Code, a shared `.mcp.json` at the project root, reading `${CARBIUM_KEY}` from your environment:

```json
{
  "mcpServers": {
    "carbium": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@carbium/mcp"],
      "env": { "CARBIUM_KEY": "${CARBIUM_KEY}" }
    }
  }
}
```

Claude Desktop, `claude_desktop_config.json` (in `~/Library/Application Support/Claude/` on macOS,
`%APPDATA%\Claude\` on Windows, `~/.config/Claude/` on Linux). This file expands no variables, so the key is written
in it:

```json
{
  "mcpServers": {
    "carbium": {
      "command": "npx",
      "args": ["-y", "@carbium/mcp"],
      "env": { "CARBIUM_KEY": "your c_serv_ key" }
    }
  }
}
```

Cursor, `~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project), where a variable is written `${env:NAME}`:

```json
{
  "mcpServers": {
    "carbium": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@carbium/mcp"],
      "env": { "CARBIUM_KEY": "${env:CARBIUM_KEY}" }
    }
  }
}
```

VS Code with Copilot, `.mcp.json` at the workspace root or `~/.copilot/mcp-config.json`:

```json
{
  "mcpServers": {
    "carbium": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@carbium/mcp"],
      "env": { "CARBIUM_KEY": "${CARBIUM_KEY}" },
      "tools": ["*"]
    }
  }
}
```

An existing `.vscode/mcp.json`, the format of VS Code's deprecated Local harness, takes the same entry under a
top-level `servers` key, with the variable written `${env:CARBIUM_KEY}`.

Codex, `~/.codex/config.toml`, where `env_vars` forwards the variable from your environment:

```toml
[mcp_servers.carbium]
command = "npx"
args = ["-y", "@carbium/mcp"]
env_vars = ["CARBIUM_KEY"]
```

In a container (ghcr.io), for clients that run one: `-i`, never `-t`; add `-e CARBIUM_ACCOUNT_KEY` for the account
tools. It runs as a non-root user and works with `--read-only`.

```json
{
  "mcpServers": {
    "carbium": {
      "command": "docker",
      "args": ["run", "-i", "--rm", "-e", "CARBIUM_KEY", "ghcr.io/carbium-sh/carbium-mcp:0.1.1"],
      "env": { "CARBIUM_KEY": "${CARBIUM_KEY}" }
    }
  }
}
```

| Variable | What it is | Tools it enables |
|---|---|---|
| none | | `carbium_docs_search`, `carbium_tokens`, `carbium_dca`; `carbium_swap` and the public methods of `carbium_rpc`, at 30 calls a minute per IP address |
| `CARBIUM_KEY` | a service key (`c_serv_…`) from the carbium.sh dashboard | every method of `carbium_rpc`, `carbium_das`, `carbium_swap` at your plan's limits |
| `CARBIUM_ACCOUNT_KEY` | an account API key (`c_acct_…`) | `carbium_account` |
| `CARBIUM_MCP_ALLOW_WRITES=1` | with an account key of full access | `carbium_account_write` |

## Tools

| Tool | What it does | Key |
|---|---|---|
| `carbium_docs_search` | searches carbium.sh/skill.md and llms.txt: methods, limits, errors, retry rules | none |
| `carbium_tokens` | token names, symbols, decimals, logos and volume: lookup, search, batch, image_url | none |
| `carbium_dca` | DCA reads (quote, positions, history, position, health) and unsigned builds (open, update, withdraw, close) | none |
| `carbium_rpc` | any served Solana JSON-RPC read method with positional params; `sendTransaction` is not offered | service; none for `getHealth`, `getVersion`, `getSlot`, `getBlockHeight`, `getEpochInfo`, `getLatestBlockhash`, `isBlockhashValid`, `getGenesisHash` |
| `carbium_das` | the ten DAS methods with one params object (Helius field names) | service |
| `carbium_swap` | quote, prices, health, and `build`: one unsigned swap transaction for `user_pubkey` | none, or service (quote scope) |
| `carbium_account` | whoami, overview, balance, keys_list, usage (daily, per key, load, hourly, latency), webhooks, modules, invoices, payments, crypto_intent, activity | account |
| `carbium_account_write` | webhook pause, resume and test; key caps, limits, scope and allowlist; enable a free module plan | account, full access, writes on |

Costly shapes state their cost and need `confirm_cost: true`: `getProgramAccounts` without filters,
`getMultipleAccounts` over 100 keys (10 credits per key), `getTokenAccountsByOwner` or `ByDelegate` without a mint
(up to 100,005 credits), `getTransactionsForAddress` walks, and a full `getBlock`. The gate refuses; it never
rewrites a call. Lists are cut to `limit` (default 20, at most 100) and every answer to 60,000 characters.

### What the model sees

Every data answer starts with a fixed note that the strings inside come from the chain or third parties and are data,
not instructions, followed by the JSON inside `<carbium-data>` tags. `structuredContent` carries the same data with a
short untrusted-data note, and over 60,000 characters only that note and a hint to narrow the call. Hidden characters
are stripped from every string before keys are redacted, and free-text fields (names, symbols, descriptions, URIs,
memos, log lines) are capped. Failures come back as `isError`
results with the service's kind, code, reason, request id and one hint. Keys, account keys and webhook secrets are
redacted from every byte that leaves the server, errors included.

### A capped key for an agent

Give an agent its own service key and cap it from the CLI or the dashboard, so a runaway loop costs little. The CLI
needs a full-access sign-in, and refuses a write without `--allow-writes`:

```sh
carbium login --email you@example.com --full
carbium keys create --name mcp-agent --scope rpc,quote --save-as agent --allow-writes
carbium keys caps <id> --set write_send=deny --set compute=deny --set gpa=1 --set scan=1 --set range=1 --set bounded_disk=2 --allow-writes
carbium keys limits <id> --max-connections 2 --max-inflight 2 --allow-writes
```

Token scans cannot be capped per key: the account's credits are the ceiling, so an agent belongs on its own account or
one with a small balance.

## Hosted later

The same tools will run at carbium.sh/mcp over streamable HTTP with the key as a request header. That route is a
separate release; this package is stdio only.

MIT. Issues: https://github.com/carbium-sh/carbium-js/issues.
