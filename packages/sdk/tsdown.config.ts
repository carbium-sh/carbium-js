import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    webhooks: 'src/webhooks.ts',
    account: 'src/account.ts',
    dca: 'src/dca.ts',
    tokens: 'src/tokens.ts',
    stream: 'src/stream.ts',
    'stream-unsupported': 'src/stream-unsupported.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  fixedExtension: true,
  target: 'node22',
  platform: 'neutral',
  deps: { neverBundle: ['@triton-one/yellowstone-grpc', 'ws'] },
  clean: true,
})
