#!/usr/bin/env node

import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { loadRuntimePackage } from './lib/runtime-deps.mjs'

const JSZip = loadRuntimePackage('jszip')
const sharp = loadRuntimePackage('sharp')
const DEFAULT_URL = 'http://10.150.10.210:8030'
const DEFAULT_TIMEOUT_SECONDS = 60
const DEFAULT_MAX_FILE_MB = 20

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => {
      stdout += chunk
    })
    child.stderr.on('data', chunk => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(`${command} exited ${code}: ${stderr || stdout}`))
    })
  })
}

function slideNumber(file) {
  return Number(path.basename(file).match(/(\d+)\.png$/)?.[1] ?? 0)
}

function escapeXml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

async function createMontage(slides, output) {
  const columns = Math.min(4, Math.max(1, slides.length))
  const cellWidth = 480
  const imageHeight = 270
  const labelHeight = 34
  const gap = 18
  const rows = Math.ceil(slides.length / columns)
  const width = columns * cellWidth + (columns + 1) * gap
  const height = rows * (imageHeight + labelHeight) + (rows + 1) * gap
  const composites = []
  for (const [index, slidePath] of slides.entries()) {
    const column = index % columns
    const row = Math.floor(index / columns)
    const left = gap + column * (cellWidth + gap)
    const top = gap + row * (imageHeight + labelHeight + gap)
    const image = await sharp(slidePath)
      .resize(cellWidth, imageHeight, {
        fit: 'contain',
        background: '#FFFFFF',
      })
      .png()
      .toBuffer()
    composites.push({ input: image, left, top })
    const label = `Slide ${index + 1}`
    const svg = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${cellWidth}" height="${labelHeight}">
        <rect width="100%" height="100%" fill="#F3F7F8"/>
        <text x="12" y="23" font-family="Arial, sans-serif" font-size="16" fill="#3F3F3F">${escapeXml(label)}</text>
      </svg>`,
    )
    composites.push({ input: svg, left, top: top + imageHeight })
  }
  await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: '#D7DEE2',
    },
  })
    .composite(composites)
    .png()
    .toFile(output)
}

async function main() {
  const input = process.argv[2]
  const outputArg = process.argv[3]
  if (!input || !outputArg) {
    throw new Error(
      'Usage: node render-via-gotenberg.mjs <deck.pptx> <output-directory>',
    )
  }
  const deck = path.resolve(input)
  const outputDir = path.resolve(outputArg)
  const timeoutSeconds = Number(
    process.env.GOTENBERG_TIMEOUT_SECONDS ?? DEFAULT_TIMEOUT_SECONDS,
  )
  const maxFileMb = Number(
    process.env.GOTENBERG_MAX_FILE_MB ?? DEFAULT_MAX_FILE_MB,
  )
  const baseUrl = (process.env.GOTENBERG_URL ?? DEFAULT_URL).replace(/\/+$/, '')
  const endpoint = `${baseUrl}/forms/libreoffice/convert`
  const stat = await fs.stat(deck)
  if (stat.size > maxFileMb * 1024 * 1024) {
    throw new Error(`PPTX exceeds the ${maxFileMb} MB Gotenberg limit`)
  }
  await fs.mkdir(outputDir, { recursive: true })
  const existing = await fs.readdir(outputDir)
  await Promise.all(
    existing
      .filter(name => /^slide-\d+\.png$/.test(name) || ['deck.pdf', 'montage.png'].includes(name))
      .map(name => fs.rm(path.join(outputDir, name), { force: true })),
  )

  const data = await fs.readFile(deck)
  const pptx = await JSZip.loadAsync(data)
  const expectedSlides = Object.keys(pptx.files).filter(name =>
    /^ppt\/slides\/slide\d+\.xml$/.test(name),
  ).length
  const form = new FormData()
  form.append(
    'files',
    new Blob([data], {
      type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    }),
    path.basename(deck),
  )
  const response = await fetch(endpoint, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(timeoutSeconds * 1000),
  })
  if (!response.ok) {
    const body = await response.text()
    throw new Error(
      `Gotenberg returned ${response.status}: ${body.slice(0, 500)}`,
    )
  }
  const pdf = Buffer.from(await response.arrayBuffer())
  const contentType = response.headers.get('content-type') ?? ''
  if (!pdf.subarray(0, 4).equals(Buffer.from('%PDF'))) {
    throw new Error(`Gotenberg returned non-PDF content (${contentType || 'unknown type'})`)
  }
  const pdfPath = path.join(outputDir, 'deck.pdf')
  await fs.writeFile(pdfPath, pdf)
  const prefix = path.join(outputDir, 'slide')
  await run('pdftoppm', ['-png', '-r', '150', pdfPath, prefix])
  const slides = (await fs.readdir(outputDir))
    .filter(name => /^slide-\d+\.png$/.test(name))
    .map(name => path.join(outputDir, name))
    .sort((left, right) => slideNumber(left) - slideNumber(right))
  if (!slides.length) throw new Error('pdftoppm produced no slide images')
  if (slides.length !== expectedSlides) {
    throw new Error(
      `Rendered ${slides.length} pages; PPTX contains ${expectedSlides} slides`,
    )
  }
  const montage = path.join(outputDir, 'montage.png')
  await createMontage(slides, montage)
  console.log(
    JSON.stringify({
      success: true,
      endpoint,
      pdf: pdfPath,
      slides,
      montage,
    }),
  )
}

main().catch(error => {
  console.error(error.stack || error.message)
  process.exitCode = 1
})
