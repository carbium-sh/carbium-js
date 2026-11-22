# carbium-js

Carbium's JavaScript and TypeScript packages for Solana on [services.carbium.sh](https://carbium.sh):

| Package | What it is |
|---|---|
| [`@carbium/sdk`](packages/sdk) | Typed client for RPC, DAS, WebSocket subscriptions, Carbon Stream (Yellowstone gRPC), quote and swap, the account API, webhook signature checks, the DCA API and the token API |
| [`carbium`](packages/cli) | The command line: sign in, service keys, RPC and DAS by method name, quotes and unsigned swap builds, prices, WebSocket and Carbon Stream tails, webhooks, usage, DCA and token lookups |
| [`@carbium/mcp`](packages/mcp) | An MCP server for Claude Code, Cursor, VS Code, Codex and any MCP client: RPC reads, DAS, quotes, prices, unsigned swap and DCA builds, token lookups, Carbium's docs and the account API |

Docs: https://carbium.sh/docs. The machine-readable guide is https://carbium.sh/skill.md.

Install them from npm:

```sh
npm install @carbium/sdk      # the SDK, also on JSR: deno add jsr:@carbium/sdk
npm install -g carbium        # the command line; binaries, Homebrew and Scoop: https://carbium.sh/sdk/cli
npx -y @carbium/mcp           # the MCP server, started by your MCP client: https://carbium.sh/sdk/mcp
```

Each package has its own version and its own releases. Nothing here holds a private key, signs or sends: swap and DCA
builds return an unsigned transaction for your own wallet.

## Development

```sh
pnpm install
pnpm build
pnpm test
```

`pnpm install` sets `core.hooksPath` to `hooks`, whose pre-push hook runs `scripts/leak-check.sh` on every pushed ref.
Versions are bumped and releases cut by the maintainers only; a GitHub release tagged `sdk-vX.Y.Z`, `cli-vX.Y.Z` or
`mcp-vX.Y.Z` publishes that package.

MIT.
