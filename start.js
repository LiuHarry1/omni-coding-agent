import { readFileSync } from 'fs'
import { handleEarlyArgs } from './src/entrypoints/early-args.ts'

handleEarlyArgs({
  program: 'node start.js',
  readVersion: () =>
    JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
      .version,
})

await import('./src/entrypoints/cli.ts')
