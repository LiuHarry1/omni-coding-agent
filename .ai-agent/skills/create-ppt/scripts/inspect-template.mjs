#!/usr/bin/env node

import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { loadRuntimePackage } from './lib/runtime-deps.mjs'

const JSZip = loadRuntimePackage('jszip')

function decodeXml(value) {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
}

function attrs(source) {
  return Object.fromEntries(
    [...source.matchAll(/([\w:]+)="([^"]*)"/g)].map(match => [
      match[1],
      decodeXml(match[2]),
    ]),
  )
}

function numericSuffix(name) {
  return Number(name.match(/(\d+)\.xml$/)?.[1] ?? 0)
}

async function main() {
  const skillDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const input = path.resolve(
    process.argv[2] ?? path.join(skillDir, 'assets', 'corporate-template.pptx'),
  )
  const output = path.resolve(
    process.argv[3] ?? path.join(skillDir, 'references', 'template-inventory.json'),
  )
  const buffer = await fs.readFile(input)
  const zip = await JSZip.loadAsync(buffer)
  const presentation = await zip.file('ppt/presentation.xml')?.async('string')
  const theme = await zip.file('ppt/theme/theme1.xml')?.async('string')
  if (!presentation || !theme) throw new Error('Template is missing presentation or theme XML')

  const sizeMatch = presentation.match(/<p:sldSz\b([^>]*)\/>/)
  const size = attrs(sizeMatch?.[1] ?? '')
  const colors = {}
  for (const match of theme.matchAll(
    /<a:(dk1|lt1|dk2|lt2|accent[1-6]|hlink|folHlink)>\s*<a:(?:srgbClr|sysClr)\b([^>]*)\/?>/g,
  )) {
    const values = attrs(match[2])
    colors[match[1]] = values.val ?? values.lastClr ?? ''
  }
  const fonts = {
    majorLatin: theme.match(/<a:majorFont>[\s\S]*?<a:latin\b[^>]*typeface="([^"]*)"/)?.[1] ?? '',
    majorEastAsian:
      theme.match(/<a:majorFont>[\s\S]*?<a:ea\b[^>]*typeface="([^"]*)"/)?.[1] ?? '',
    minorLatin: theme.match(/<a:minorFont>[\s\S]*?<a:latin\b[^>]*typeface="([^"]*)"/)?.[1] ?? '',
    minorEastAsian:
      theme.match(/<a:minorFont>[\s\S]*?<a:ea\b[^>]*typeface="([^"]*)"/)?.[1] ?? '',
  }

  const layoutNames = Object.keys(zip.files)
    .filter(name => /^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(name))
    .sort((left, right) => numericSuffix(left) - numericSuffix(right))
  const layouts = []
  for (const name of layoutNames) {
    const xml = await zip.file(name).async('string')
    const cSldName = xml.match(/<p:cSld\b[^>]*name="([^"]*)"/)?.[1] ?? ''
    const placeholders = [...xml.matchAll(/<p:ph\b([^>]*)\/>/g)].map(match => {
      const values = attrs(match[1])
      return {
        type: values.type ?? 'body',
        idx: Number(values.idx ?? 0),
      }
    })
    layouts.push({
      index: numericSuffix(name),
      name: cSldName,
      placeholders,
    })
  }

  const slideCount = Object.keys(zip.files).filter(name =>
    /^ppt\/slides\/slide\d+\.xml$/.test(name),
  ).length
  const inventory = {
    schemaVersion: 1,
    template: path.basename(input),
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    themeName: theme.match(/<a:theme\b[^>]*name="([^"]*)"/)?.[1] ?? '',
    slideSizeEmu: {
      width: Number(size.cx ?? 0),
      height: Number(size.cy ?? 0),
    },
    slideSizeInches: {
      width: Number(((Number(size.cx ?? 0) || 0) / 914400).toFixed(3)),
      height: Number(((Number(size.cy ?? 0) || 0) / 914400).toFixed(3)),
    },
    sourceSlides: slideCount,
    brandAssets: {
      coverBackground: 'ppt/media/image1.jpeg',
      sectionBackground: 'ppt/media/image4.jpeg',
    },
    colors,
    fonts,
    layouts,
  }
  await fs.mkdir(path.dirname(output), { recursive: true })
  await fs.writeFile(output, `${JSON.stringify(inventory, null, 2)}\n`)
  console.log(JSON.stringify({ success: true, output, layouts: layouts.length }))
}

main().catch(error => {
  console.error(error.stack || error.message)
  process.exitCode = 1
})
