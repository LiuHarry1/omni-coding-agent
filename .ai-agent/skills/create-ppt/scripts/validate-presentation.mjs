#!/usr/bin/env node

import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { loadRuntimePackage } from './lib/runtime-deps.mjs'

const JSZip = loadRuntimePackage('jszip')

function parseArgs(argv) {
  if (!argv[0]) {
    throw new Error(
      'Usage: node validate-presentation.mjs <deck.pptx> [--manifest <qa.json>] [--report <report.json>]',
    )
  }
  const valueAfter = flag => {
    const index = argv.indexOf(flag)
    return index >= 0 ? argv[index + 1] : undefined
  }
  const deck = path.resolve(argv[0])
  return {
    deck,
    manifest: path.resolve(valueAfter('--manifest') ?? `${deck}.qa.json`),
    report: path.resolve(valueAfter('--report') ?? `${deck}.validation.json`),
  }
}

function decodeXmlText(value) {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&')
}

function resolveRelationshipTarget(relsPath, target) {
  if (/^[a-z]+:/i.test(target)) return null
  if (target.startsWith('/')) {
    return path.posix.normalize(target).replace(/^\/+/, '')
  }
  if (relsPath === '_rels/.rels') {
    return path.posix.normalize(target).replace(/^\/+/, '')
  }
  const sourcePart = relsPath
    .replace('/_rels/', '/')
    .replace(/\.rels$/, '')
  const base = path.posix.dirname(sourcePart)
  return path.posix.normalize(path.posix.join(base, target)).replace(/^\/+/, '')
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const report = {
    schemaVersion: 1,
    file: args.deck,
    checkedAt: new Date().toISOString(),
    slides: 0,
    warnings: [],
    errors: [],
  }
  const stat = await fs.stat(args.deck)
  if (stat.size < 10_000) report.errors.push('PPTX is unexpectedly small')
  const buffer = await fs.readFile(args.deck)
  let zip
  try {
    zip = await JSZip.loadAsync(buffer, { checkCRC32: true })
  } catch (error) {
    report.errors.push(`Invalid ZIP package: ${error.message}`)
  }
  if (zip) {
    const names = Object.keys(zip.files)
    for (const required of ['[Content_Types].xml', 'ppt/presentation.xml']) {
      if (!zip.file(required)) report.errors.push(`Missing required package part: ${required}`)
    }
    const slideNames = names
      .filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .sort((left, right) => {
        const leftNumber = Number(left.match(/(\d+)\.xml$/)?.[1] ?? 0)
        const rightNumber = Number(right.match(/(\d+)\.xml$/)?.[1] ?? 0)
        return leftNumber - rightNumber
      })
    report.slides = slideNames.length
    if (!report.slides) report.errors.push('Presentation contains no slides')

    const leftovers = /\b(?:lorem|ipsum|todo|tbd)\b|x{3,}|\[(?:insert|placeholder)[^\]]*\]/i
    for (const slideName of slideNames) {
      const xml = await zip.file(slideName).async('string')
      const text = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)]
        .map(match => decodeXmlText(match[1]))
        .join(' ')
      if (leftovers.test(text)) {
        report.errors.push(`${slideName} contains placeholder text`)
      }
      if (!text.trim()) report.warnings.push(`${slideName} contains no visible text`)
    }

    const relationshipFiles = names.filter(name => name.endsWith('.rels'))
    for (const relsPath of relationshipFiles) {
      const xml = await zip.file(relsPath).async('string')
      for (const match of xml.matchAll(/<Relationship\b([^>]*)\/>/g)) {
        const attrs = Object.fromEntries(
          [...match[1].matchAll(/([\w:]+)="([^"]*)"/g)].map(entry => [
            entry[1],
            entry[2],
          ]),
        )
        if (attrs.TargetMode === 'External') continue
        const target = resolveRelationshipTarget(relsPath, attrs.Target ?? '')
        if (target && !zip.file(target)) {
          report.errors.push(`${relsPath} points to missing part ${target}`)
        }
      }
    }
  }

  try {
    const manifest = JSON.parse(await fs.readFile(args.manifest, 'utf8'))
    if (manifest.slides?.length !== report.slides) {
      report.errors.push(
        `QA manifest has ${manifest.slides?.length ?? 0} slides; PPTX has ${report.slides}`,
      )
    }
    report.warnings.push(...(manifest.warnings ?? []))
    report.errors.push(...(manifest.errors ?? []))
  } catch (error) {
    report.warnings.push(`QA manifest unavailable: ${error.message}`)
  }

  await fs.writeFile(args.report, `${JSON.stringify(report, null, 2)}\n`)
  if (report.errors.length) {
    throw new Error(`Presentation validation failed:\n- ${report.errors.join('\n- ')}`)
  }
  console.log(
    JSON.stringify({
      success: true,
      file: args.deck,
      slides: report.slides,
      warnings: report.warnings.length,
      report: args.report,
    }),
  )
}

main().catch(error => {
  console.error(error.stack || error.message)
  process.exitCode = 1
})
