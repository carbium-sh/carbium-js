// The few ws types the CLI test servers use; the package ships none.
declare module 'ws' {
  import type { IncomingMessage } from 'node:http'
  export class WebSocket {
    send(data: string): void
    close(code?: number, reason?: string): void
    on(event: 'message', listener: (data: Buffer) => void): this
  }
  export class WebSocketServer {
    constructor(options: { port: number; host: string; handleProtocols?: (protocols: Set<string>) => string | false }, callback?: () => void)
    on(event: 'connection', listener: (socket: WebSocket, req: IncomingMessage) => void): this
    address(): { port: number }
    readonly clients: Set<WebSocket>
    close(callback?: () => void): void
  }
}
