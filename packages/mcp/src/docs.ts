/** A keyless search over carbium.sh/skill.md and llms.txt, fetched on first use and split by heading. */
export interface DocSection {
  source: string
  trail: string
  text: string
}

export interface DocsSearchResult {
  sections: Array<DocSection & { score: number; truncated?: true }>
  fetchedAt: string
  indexed: number
}

export const DEFAULT_DOCS_URLS: readonly string[] = ['https://carbium.sh/skill.md', 'https://carbium.sh/llms.txt']
const SECTION_MAX_CHARS = 4000
const REFRESH_MS = 6 * 60 * 60 * 1000

export class DocsIndex {
  readonly #urls: readonly string[]
  readonly #fetch: typeof fetch
  #sections: DocSection[] = []
  #fetchedAt = 0
  #loading: Promise<void> | undefined

  constructor(options: { urls?: readonly string[]; fetch?: typeof fetch } = {}) {
    this.#urls = options.urls ?? DEFAULT_DOCS_URLS
    this.#fetch = options.fetch ?? globalThis.fetch
  }

  async #load(): Promise<void> {
    const sections: DocSection[] = []
    for (const url of this.#urls) {
      const res = await this.#fetch(url, { signal: AbortSignal.timeout(10_000), headers: { accept: 'text/markdown, text/plain' } })
      if (!res.ok) throw new Error(`${url} answered ${res.status}`)
      const text = await res.text()
      const source = new URL(url).pathname.replace(/^\//, '')
      const trail: string[] = []
      let heading = source
      let buf: string[] = []
      const flush = (): void => {
        const body = buf.join('\n').trim()
        if (body) sections.push({ source, trail: [...trail, heading].filter((t, i, a) => a.indexOf(t) === i).join(' > '), text: body })
        buf = []
      }
      for (const line of text.split('\n')) {
        const m = /^(#{1,4})\s+(.*)$/.exec(line)
        if (m) {
          flush()
          const level = m[1]!.length
          trail.splice(level - 1)
          heading = m[2]!.trim()
          trail[level - 1] = heading
        } else buf.push(line)
      }
      flush()
    }
    this.#sections = sections
    this.#fetchedAt = Date.now()
  }

  async ensure(): Promise<void> {
    if (this.#sections.length && Date.now() - this.#fetchedAt < REFRESH_MS) return
    this.#loading ??= this.#load().finally(() => (this.#loading = undefined))
    await this.#loading
  }

  async search(query: string, limit = 3): Promise<DocsSearchResult> {
    await this.ensure()
    const terms = query.toLowerCase().split(/[^a-z0-9_.-]+/i).filter((t) => t.length > 1)
    const phrase = query.toLowerCase().trim()
    const exact = /^[A-Za-z][A-Za-z0-9_]{3,}$/.test(query.trim()) ? query.trim() : undefined
    const scored = this.#sections
      .map((s) => {
        const lower = s.text.toLowerCase()
        const trail = s.trail.toLowerCase()
        let score = 0
        for (const t of terms) {
          if (trail.includes(t)) score += 5
          const hits = lower.split(t).length - 1
          score += Math.min(5, hits)
        }
        if (phrase && lower.includes(phrase)) score += 5
        if (exact && (s.text.includes(exact) || s.trail.includes(exact))) score += 8
        return { s, score }
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, Math.min(6, limit)))
    return {
      sections: scored.map(({ s, score }) => {
        const over = s.text.length > SECTION_MAX_CHARS
        const text = over ? s.text.slice(0, s.text.lastIndexOf('\n', SECTION_MAX_CHARS) > 0 ? s.text.lastIndexOf('\n', SECTION_MAX_CHARS) : SECTION_MAX_CHARS) : s.text
        return { ...s, text, score, ...(over ? { truncated: true as const } : {}) }
      }),
      fetchedAt: new Date(this.#fetchedAt).toISOString(),
      indexed: this.#sections.length,
    }
  }
}
