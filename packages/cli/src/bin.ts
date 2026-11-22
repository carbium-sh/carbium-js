#!/usr/bin/env node
import { main } from './main.ts'

// A closed pipe (carbium ... | head) ends the run quietly instead of a stack trace.
for (const stream of [process.stdout, process.stderr]) stream.on('error', (e: NodeJS.ErrnoException) => process.exit(e.code === 'EPIPE' ? 0 : 1))

process.exitCode = await main(process.argv.slice(2))
