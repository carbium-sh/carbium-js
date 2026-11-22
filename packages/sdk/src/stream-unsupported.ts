// The "./stream" entry for runtimes without Node: Carbon Stream needs the native @triton-one/yellowstone-grpc client.
import { CarbiumError } from './errors.ts'
export { buildRequest, classifyStreamError, DEFAULT_STREAM_ENDPOINT, type StreamFilters, type StreamAction, type StreamErrorInfo, type GrpcStatus } from './stream-core.ts'

export class CarbiumStream {
  static connect(): Promise<never> {
    return Promise.reject(new CarbiumError({ kind: 'stream', message: 'Carbon Stream needs Node 22+ and the @triton-one/yellowstone-grpc package (linux-x64, darwin); it is not available in this runtime' }))
  }
}
