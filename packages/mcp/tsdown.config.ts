import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { index: 'src/index.ts', bin: 'src/bin.ts' },
  format: ['esm'],
  dts: true,
  fixedExtension: true,
  target: 'node22',
  platform: 'node',
  clean: true,
})
