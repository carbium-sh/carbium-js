import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { GlobalFlags, Io } from './main.ts'
import { VERSION } from './version.ts'

/** Either variable, set to anything, turns the version check off. */
export const checkOff = (env: Io['env']): boolean => Boolean(env['CARBIUM_NO_UPDATE_NOTIFIER'] || env['NO_UPDATE_NOTIFIER'])

/** npm's latest carbium as a plain x.y.z, or undefined when the registry gave no such answer. One keyless read; nothing of the user is sent. */
export async function latest(f: typeof fetch, signal: AbortSignal): Promise<string | undefined> {
  try {
    const v = ((await (await f('https://registry.npmjs.org/-/package/carbium/dist-tags', { signal })).json()) as { latest?: unknown }).latest
    return typeof v === 'string' && /^\d+\.\d+\.\d+$/.test(v) ? v : undefined
  } catch {
    return undefined
  }
}

/**
 * Called at a command's first HTTP call. Starts the check when one is due: on a terminal, at most once a day, never in CI, with --json or --quiet, or turned off.
 * The returned function ends it as the command ends: it gives the read up to a second and a half, then prints one stderr
 * line if npm has a newer version. The day is stamped before the read, so a registry that does not answer costs one wait a day.
 */
export function updateCheck(io: Io, flags: GlobalFlags, dir: string): () => Promise<void> {
  const stamp = join(dir, 'update-check')
  const none = async (): Promise<void> => undefined
  if (flags.json || flags.quiet || !io.stdoutIsTTY || !io.stderrIsTTY || io.env['CI'] || checkOff(io.env)) return none
  try {
    const age = Date.now() - Number(readFileSync(stamp, 'utf8'))
    if (age >= 0 && age < 86_400_000) return none // a stamp from the future or one that is no number counts as due
  } catch {
    // no stamp yet: a check is due
  }
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeFileSync(stamp, `${Date.now()}\n`)
  } catch {
    return none // nowhere to keep the day, so no check
  }
  const ac = new AbortController()
  const read = latest(io.fetch ?? fetch, ac.signal)
  return async () => {
    const timer = setTimeout(() => ac.abort(), 1500)
    const found = await read
    clearTimeout(timer)
    if (found && found.localeCompare(VERSION, undefined, { numeric: true }) > 0) io.stderr(`carbium ${found} is out (this is ${VERSION}). To update: https://github.com/carbium-sh/carbium-js/tree/main/packages/cli#update (CARBIUM_NO_UPDATE_NOTIFIER=1 turns this line off)\n`)
  }
}
