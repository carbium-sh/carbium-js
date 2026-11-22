import { randomBytes } from 'node:crypto'
import { chmodSync, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'

export interface StoredAccountKey {
  value: string
  prefix: string
  access: 'full' | 'read' | 'unknown'
  apiKeyId?: number
  expiresAt?: string | null
  madeByCli?: boolean
}
export interface StoredServiceKey {
  value: string
  prefix: string
  keyId?: number
  scope?: string[]
}
export interface Profile {
  endpoint?: string
  dashboard?: string
  dcaUrl?: string
  tokensUrl?: string
  /** The Carbon Stream host; by default the endpoint's host name on port 9443. */
  streamUrl?: string
  /** Writes are off until login --full or config set writes true. */
  writes?: boolean
  accountKey?: StoredAccountKey
  serviceKeys?: Record<string, StoredServiceKey>
  defaultServiceKey?: string
}
export interface Credentials {
  version: 1
  profile: string
  profiles: Record<string, Profile>
}

export const KEY_PREFIX_LEN = 11

export function configDir(env: Record<string, string | undefined>): string {
  if (env['CARBIUM_CONFIG_DIR']) return env['CARBIUM_CONFIG_DIR']
  if (env['XDG_CONFIG_HOME']) return join(env['XDG_CONFIG_HOME'], 'carbium')
  if (platform() === 'win32' && env['APPDATA']) return join(env['APPDATA'], 'carbium')
  return join(env['HOME'] ?? homedir(), '.config', 'carbium')
}

/** The credentials file: 0600 in a 0700 directory, written atomically; keys as plain text, as the docs' own script does. */
export class Store {
  readonly dir: string
  readonly file: string
  #data: Credentials
  #warn: (line: string) => void

  constructor(env: Record<string, string | undefined>, warn: (line: string) => void = () => undefined) {
    this.dir = configDir(env)
    this.file = join(this.dir, 'credentials.json')
    this.#warn = warn
    this.#data = this.#load()
  }

  #load(): Credentials {
    const empty: Credentials = { version: 1, profile: 'default', profiles: {} }
    if (!existsSync(this.file)) return empty
    if (platform() !== 'win32') {
      const mode = statSync(this.file).mode & 0o777
      if (mode & 0o077) {
        chmodSync(this.file, 0o600)
        this.#warn(`${this.file} was readable by others (mode ${mode.toString(8)}); set back to 600`)
      }
    }
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Credentials
      return parsed.version === 1 && parsed.profiles ? parsed : empty
    } catch {
      this.#warn(`${this.file} is not readable JSON; starting empty`)
      return empty
    }
  }

  save(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    if (platform() !== 'win32') chmodSync(this.dir, 0o700)
    const tmp = `${this.file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
    let made = false
    try {
      const fd = openSync(tmp, 'wx', 0o600)
      made = true
      try {
        writeFileSync(fd, JSON.stringify(this.#data, null, 2) + '\n')
      } finally {
        closeSync(fd)
      }
      renameSync(tmp, this.file)
    } catch (e) {
      if (made) rmSync(tmp, { force: true }) // the temp file this call made, never another
      throw e
    }
  }

  get profileName(): string {
    return this.#data.profile
  }
  set profileName(name: string) {
    this.#data.profile = name
  }
  get profileNames(): string[] {
    return Object.keys(this.#data.profiles)
  }
  profile(name: string): Profile {
    return (this.#data.profiles[name] ??= {})
  }
  deleteProfile(name: string): void {
    delete this.#data.profiles[name]
  }
  /** Every secret value held, for the output redactor. */
  secrets(): string[] {
    const out: string[] = []
    for (const p of Object.values(this.#data.profiles)) {
      if (p.accountKey) out.push(p.accountKey.value)
      for (const k of Object.values(p.serviceKeys ?? {})) out.push(k.value)
    }
    return out
  }
}

/** A new 0600 file for a secret, made before the call that returns the secret: write() fills it, discard() removes it again. */
export function reserveSecretFile(path: string): { write(value: string): void; discard(): void } {
  const fd = openSync(path, 'wx', 0o600)
  const made = fstatSync(fd)
  let open = true
  const close = (): void => {
    if (open) closeSync(fd)
    open = false
  }
  return {
    write: (value) => {
      try {
        writeFileSync(fd, value + '\n')
      } finally {
        close()
      }
    },
    discard: () => {
      close()
      const now = lstatSync(path, { throwIfNoEntry: false })
      // only the empty file this run made, never one put in its place since
      if (now?.isFile() && now.ino === made.ino && now.dev === made.dev && now.size === 0) unlinkSync(path)
    },
  }
}

