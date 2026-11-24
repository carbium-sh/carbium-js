import { CliError, EXIT, allCommands, register, type Command } from '../main.ts'
import { checkOff, latest } from '../update.ts'
import { VERSION } from '../version.ts'

const CONFIG_KEYS = ['endpoint', 'dashboard', 'dcaUrl', 'tokensUrl', 'streamUrl', 'writes', 'defaultServiceKey'] as const
type ConfigKey = (typeof CONFIG_KEYS)[number]

function completionScript(shell: string): string {
  const cmds = allCommands()
  const words = (depth: number, prefix: string[]): string[] => [...new Set(cmds.filter((c) => c.path.length > depth && c.path.slice(0, depth).join(' ') === prefix.join(' ')).map((c) => c.path[depth] as string))]
  const top = words(0, [])
  const opts = (c: Command): string[] => ['--json', '--yes', '--quiet', '--no-input', '--allow-writes', '--profile', '--endpoint', '--dashboard', '--dca-url', '--tokens-url', '--stream-url', '--key-file', '--service-key', '--help', '--version', ...Object.keys(c.options ?? {}).map((o) => `--${o}`)]
  if (shell === 'bash') {
    const cases = top.map((t) => `      ${t}) COMPREPLY=($(compgen -W "${words(1, [t]).join(' ')}" -- "$cur"));;`).join('\n')
    return `# bash completion for carbium: eval "$(carbium completion bash)"\n_carbium() {\n  local cur prev\n  cur="\${COMP_WORDS[COMP_CWORD]}"\n  if [[ "$cur" == -* ]]; then COMPREPLY=($(compgen -W "${[...new Set(cmds.flatMap(opts))].join(' ')}" -- "$cur")); return; fi\n  case $COMP_CWORD in\n    1) COMPREPLY=($(compgen -W "${top.join(' ')}" -- "$cur"));;\n    2) case "\${COMP_WORDS[1]}" in\n${cases}\n    esac;;\n  esac\n}\ncomplete -F _carbium carbium\n`
  }
  if (shell === 'zsh') {
    return `#compdef carbium\n# zsh completion for carbium: autoload -Uz compinit && compinit; eval "$(carbium completion zsh)"\n_carbium() {\n  local -a top\n  top=(${top.join(' ')})\n  if (( CURRENT == 2 )); then _describe 'command' top; return; fi\n  case $words[2] in\n${top.map((t) => `    ${t}) local -a sub; sub=(${words(1, [t]).join(' ')}); (( CURRENT == 3 )) && _describe 'subcommand' sub;;`).join('\n')}\n  esac\n  _arguments ${[...new Set(cmds.flatMap(opts))].map((o) => `'${o}'`).join(' ')}\n}\ncompdef _carbium carbium\n`
  }
  if (shell === 'fish') {
    const lines = [`# fish completion for carbium: mkdir -p ~/.config/fish/completions && carbium completion fish > ~/.config/fish/completions/carbium.fish`, `complete -c carbium -f`]
    for (const t of top) lines.push(`complete -c carbium -n '__fish_use_subcommand' -a ${t} -d '${(cmds.find((c) => c.path.join(' ') === t)?.summary ?? `${words(1, [t]).length} commands`).replace(/'/g, '')}'`)
    for (const t of top) for (const s of words(1, [t])) lines.push(`complete -c carbium -n '__fish_seen_subcommand_from ${t}' -a ${s} -d '${(cmds.find((c) => c.path.join(' ') === `${t} ${s}`)?.summary ?? '').replace(/'/g, '')}'`)
    for (const o of new Set(cmds.flatMap(opts))) lines.push(`complete -c carbium -l ${o.slice(2)}`)
    return lines.join('\n') + '\n'
  }
  throw new CliError(EXIT.usage, `unknown shell ${shell}: bash, zsh or fish`)
}

register([
  {
    path: ['config', 'list'], summary: 'show the profile settings (no secrets)', access: 'local',
    run: async (ctx) => {
      const p = ctx.profile
      return { profile: ctx.flags.profile, endpoint: p.endpoint ?? 'https://services.carbium.sh', dashboard: p.dashboard ?? 'https://carbium.sh', dcaUrl: p.dcaUrl ?? 'https://dex.carbium.io/api/dca', tokensUrl: p.tokensUrl ?? 'https://tokens.carbium.io', streamUrl: p.streamUrl ?? null, writes: Boolean(p.writes), accountKey: p.accountKey ? { prefix: p.accountKey.prefix, access: p.accountKey.access, expiresAt: p.accountKey.expiresAt ?? null } : null, serviceKeys: Object.entries(p.serviceKeys ?? {}).map(([name, k]) => ({ name, prefix: k.prefix, keyId: k.keyId ?? null, scope: k.scope ?? null })), defaultServiceKey: p.defaultServiceKey ?? null, file: ctx.store.file }
    },
  },
  {
    path: ['config', 'get'], summary: 'print one setting', usage: '<key>', access: 'local',
    run: async (ctx) => {
      const k = ctx.positionals[0] as ConfigKey | undefined
      if (!k || !CONFIG_KEYS.includes(k)) throw new CliError(EXIT.usage, `config key must be one of ${CONFIG_KEYS.join(', ')}`)
      return { [k]: (ctx.profile as Record<string, unknown>)[k] ?? null }
    },
  },
  {
    path: ['config', 'set'], summary: 'set endpoint, dashboard, dcaUrl, tokensUrl, streamUrl, writes (true|false) or defaultServiceKey', usage: '<key> <value>', access: 'local',
    run: async (ctx) => {
      const [k, val] = ctx.positionals as [ConfigKey | undefined, string | undefined]
      if (!k || !CONFIG_KEYS.includes(k) || val === undefined) throw new CliError(EXIT.usage, `usage: carbium config set <${CONFIG_KEYS.join('|')}> <value>`)
      if (k === 'writes') ctx.profile.writes = val === 'true'
      else if (k === 'defaultServiceKey') {
        if (!ctx.profile.serviceKeys?.[val]) throw new CliError(EXIT.usage, `no stored service key named ${val}`)
        ctx.profile.defaultServiceKey = val
      } else {
        if (!/^https?:\/\//.test(val)) throw new CliError(EXIT.usage, `${k} must be a URL`)
        if (/[?&](api[-_]?key|apiKey)=/i.test(val)) throw new CliError(EXIT.usage, 'never put a key in a URL')
        ;(ctx.profile as Record<string, unknown>)[k] = val
      }
      ctx.store.save()
      return { [k]: k === 'writes' ? ctx.profile.writes : val }
    },
  },
  {
    path: ['config', 'reset'], summary: 'remove one setting, or the whole profile with --all', usage: '[key]', access: 'local', options: { all: { type: 'boolean', help: 'delete every setting and key of this profile' } },
    run: async (ctx) => {
      if (ctx.bool('all')) {
        await ctx.confirm(`delete profile ${ctx.flags.profile} and its stored keys?`)
        ctx.store.deleteProfile(ctx.flags.profile)
      } else {
        const k = ctx.positionals[0] as ConfigKey | undefined
        if (!k || !CONFIG_KEYS.includes(k)) throw new CliError(EXIT.usage, `config key must be one of ${CONFIG_KEYS.join(', ')}`)
        delete (ctx.profile as Record<string, unknown>)[k]
      }
      ctx.store.save()
      return { ok: true }
    },
  },
  { path: ['config', 'profiles'], summary: 'list the stored profiles', access: 'local', run: async (ctx) => ctx.store.profileNames.map((name) => ({ name, current: name === ctx.store.profileName })) },
  {
    path: ['config', 'use'], summary: 'make a profile the default', usage: '<name>', access: 'local',
    run: async (ctx) => {
      const name = ctx.positionals[0]
      if (!name) throw new CliError(EXIT.usage, 'usage: carbium config use <name>')
      ctx.store.profile(name)
      ctx.store.profileName = name
      ctx.store.save()
      return { profile: name }
    },
  },
  { path: ['completion'], summary: 'print a shell completion script (bash, zsh or fish)', usage: '<shell>', access: 'local', run: async (ctx) => { ctx.out(completionScript(ctx.positionals[0] ?? '')); return undefined } },
  { path: ['endpoints'], summary: 'print the hosts this profile calls', access: 'local', run: async (ctx) => ({ rpc: ctx.endpoint(), websocket: ctx.endpoint().replace(/^http/, 'ws'), stream: ctx.streamUrl(), dashboard: ctx.dashboard(), dca: ctx.flags.dcaUrl ?? ctx.profile.dcaUrl ?? 'https://dex.carbium.io/api/dca', tokens: ctx.flags.tokensUrl ?? ctx.profile.tokensUrl ?? 'https://tokens.carbium.io' }) },
  {
    path: ['doctor'], summary: 'check the config and reach each host; shows which keys are present (prefixes only)', access: 'local',
    run: async (ctx) => {
      const report: Record<string, unknown> = { version: VERSION, ...(checkOff(ctx.io.env) ? {} : { latest: (await latest(ctx.io.fetch ?? fetch, AbortSignal.timeout(3000))) ?? null }), node: process.version, configFile: ctx.store.file, profile: ctx.flags.profile, writes: Boolean(ctx.profile.writes || ctx.flags.allowWrites) }
      let serviceKey: string | undefined
      try {
        serviceKey = ctx.serviceKey()
        report['serviceKey'] = serviceKey.slice(0, 11)
      } catch {
        report['serviceKey'] = null
      }
      try {
        const t0 = Date.now()
        const health = await ctx.carbium().rpc.getHealth()
        report['rpc'] = { ok: health === 'ok', ms: Date.now() - t0 }
      } catch (e) {
        report['rpc'] = { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
      try {
        ctx.accountKey()
        const me = await ctx.self()
        report['accountKey'] = { prefix: me.prefix.slice(0, 11), access: me.access, scopes: me.scopes, expiresAt: me.expires_at }
      } catch (e) {
        report['accountKey'] = e instanceof CliError ? null : { error: e instanceof Error ? e.message : String(e) }
      }
      try {
        report['tokens'] = { ok: (await ctx.tokens().lookup('So11111111111111111111111111111111111111112')) !== null }
      } catch (e) {
        report['tokens'] = { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
      try {
        const h = await ctx.dca().health()
        report['dca'] = { ok: h.ok }
      } catch (e) {
        report['dca'] = { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
      return report
    },
  },
])
