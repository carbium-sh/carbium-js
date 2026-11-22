import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface Seen {
  at: number
  body: string
  headers: IncomingMessage['headers']
  url: string
  method: string
}

export interface Reply {
  status: number
  headers?: Record<string, string>
  body: unknown
  /** Answer after this many ms (a slow door). */
  delayMs?: number
}

/** A planted HTTP server answering a scripted sequence (the last reply repeats) and recording every request. */
export class PlantedServer {
  readonly seen: Seen[] = []
  readonly #server: Server
  #url = ''
  #script: Array<Reply | ((req: Seen) => Reply)>

  constructor(script: Array<Reply | ((req: Seen) => Reply)>) {
    this.#script = script
    this.#server = createServer((req, res) => {
      let body = ''
      req.on('data', (c: Buffer) => (body += c))
      req.on('end', () => {
        const rec: Seen = { at: Date.now(), body, headers: req.headers, url: req.url ?? '', method: req.method ?? '' }
        this.seen.push(rec)
        const next = this.#script.length > 1 ? (this.#script.shift() as Reply | ((r: Seen) => Reply)) : this.#script[0]
        const reply = typeof next === 'function' ? next(rec) : (next as Reply)
        const text = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body)
        const n = this.seen.length
        setTimeout(() => {
          if (res.destroyed) return
          res.writeHead(reply.status, { 'content-type': 'application/json', 'x-request-id': `rid-${n}`, ...reply.headers })
          res.end(text)
        }, reply.delayMs ?? 0)
      })
    })
  }

  async start(): Promise<string> {
    await new Promise<void>((r) => this.#server.listen(0, '127.0.0.1', r))
    this.#url = `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`
    return this.#url
  }

  get url(): string {
    return this.#url
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => this.#server.close(() => r()))
  }

  /** Milliseconds between request i and request i+1. */
  gap(i: number): number {
    const a = this.seen[i]
    const b = this.seen[i + 1]
    if (!a || !b) throw new Error(`no request pair at ${i}`)
    return b.at - a.at
  }
}

export const rpcOk = (result: unknown): Reply => ({ status: 200, body: { jsonrpc: '2.0', id: 1, result } })
export const rpcErr = (status: number, code: number, message: string, data?: unknown, headers?: Record<string, string>): Reply => ({
  status,
  ...(headers ? { headers } : {}),
  body: { jsonrpc: '2.0', id: 1, error: data === undefined ? { code, message } : { code, message, data } },
})
