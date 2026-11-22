import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { bin: 'src/bin.ts', main: 'src/main.ts' },
  format: ['esm'],
  dts: true,
  fixedExtension: true,
  target: 'node22',
  platform: 'node',
  deps: { neverBundle: ['@noble/hashes'] },
  clean: true,
})
