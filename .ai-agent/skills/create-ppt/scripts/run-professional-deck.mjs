#!/usr/bin/env node

import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { buildProfessionalDeck } from './lib/professional-runtime.mjs'

function usage() {
  throw new Error(
    'Usage: node run-professional-deck.mjs <deck.mjs> <output.pptx> [--qa <manifest.json>]',
  )
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv.length < 2) usage()
  const sourcePath = path.resolve(argv[0])
  const outputPath = path.resolve(argv[1])
  const qaIndex = argv.indexOf('--qa')
  const qaPath =
    qaIndex >= 0 && argv[qaIndex + 1]
      ? path.resolve(argv[qaIndex + 1])
      : `${outputPath}.qa.json`
  const source = await import(`${pathToFileURL(sourcePath).href}?v=${Date.now()}`)
  const result = await buildProfessionalDeck({
    metadata: source.metadata,
    build: source.default,
    outputPath,
    qaPath,
  })
  console.log(JSON.stringify(result))
}

main().catch(error => {
  console.error(error.stack || error.message)
  process.exitCode = 1
})
