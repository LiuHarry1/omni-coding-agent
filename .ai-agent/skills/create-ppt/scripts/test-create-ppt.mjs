#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'
import sharp from 'sharp'
import { normalizeSpec } from './lib/spec.mjs'
import { fitFontSize } from './lib/design.mjs'
import { getImageDimensions, imageSizingCrop } from './lib/media-layout.mjs'
import { inspectSlideObjects } from './lib/slide-qa.mjs'
import { fitText } from './lib/text-layout.mjs'

const scriptsDir = path.dirname(fileURLToPath(import.meta.url))
const skillDir = path.resolve(scriptsDir, '..')
const fixture = path.join(skillDir, 'tests', 'fixtures', 'zh-business.json')
const professionalFixture = path.join(
  skillDir,
  'tests',
  'fixtures',
  'professional-deck.mjs',
)

function run(script, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(scriptsDir, script), ...args], {
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
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
      else reject(new Error(`${script} exited ${code}\n${stderr || stdout}`))
    })
  })
}

function minimalPdf() {
  const stream = content =>
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 720 405] /Resources << /Font << /F1 7 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 720 405] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>',
    stream('BT /F1 24 Tf 72 220 Td (Mock Gotenberg render) Tj ET'),
    stream('BT /F1 24 Tf 72 220 Td (Second mock page) Tj ET'),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf))
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n`
  pdf += '0000000000 65535 f \n'
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`
  pdf += `startxref\n${xref}\n%%EOF\n`
  return Buffer.from(pdf)
}

async function withMockGotenberg(callback) {
  const pdf = minimalPdf()
  const server = http.createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/forms/libreoffice/convert') {
      response.writeHead(404).end()
      return
    }
    request.on('data', () => {})
    request.on('end', () => {
      response.writeHead(200, { 'Content-Type': 'application/pdf' })
      response.end(pdf)
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  try {
    await callback(`http://127.0.0.1:${address.port}`)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
}

async function main() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'create-ppt-test-'))
  try {
    const raw = JSON.parse(await fs.readFile(fixture, 'utf8'))
    const normalized = normalizeSpec(raw)
    assert.equal(normalized.slides.length, 9)
    assert.throws(
      () => normalizeSpec({ ...raw, unexpected: true }),
      /unknown field/,
    )
    assert.throws(
      () =>
        normalizeSpec({
          ...raw,
          slides: [{ ...raw.slides[0], title: 'x'.repeat(101) }],
        }),
      /at most 100/,
    )
    assert.equal(
      fitFontSize('Short readable text', 4, 1, { max: 20, min: 14 }).overflow,
      undefined,
    )
    const cjkFit = fitText('中英文混合文本 should wrap with real metrics', {
      width: 2.2,
      height: 1.2,
      fontFace: 'Microsoft YaHei',
      maxFontSize: 20,
      minFontSize: 14,
    })
    assert.equal(cjkFit.overflow, false)
    assert.ok(cjkFit.lineCount >= 1)
    const objectQa = inspectSlideObjects({
      _slideObjects: [
        {
          _type: 'text',
          text: [{ text: 'outside' }],
          options: { x: 13, y: 1, w: 1, h: 1, objectName: 'Outside text' },
        },
      ],
    })
    assert.match(objectQa.errors[0], /outside the slide boundary/)

    const deck = path.join(temp, 'sample.pptx')
    await run('create-presentation.mjs', [fixture, deck])
    await run('validate-presentation.mjs', [
      deck,
      '--manifest',
      `${deck}.qa.json`,
    ])
    const zip = await JSZip.loadAsync(await fs.readFile(deck))
    const slideCount = Object.keys(zip.files).filter(name =>
      /^ppt\/slides\/slide\d+\.xml$/.test(name),
    ).length
    assert.equal(slideCount, 10)
    assert.ok(zip.file('ppt/charts/chart1.xml'))

    const imagePath = path.join(temp, 'visual.png')
    await sharp({
      create: {
        width: 1200,
        height: 675,
        channels: 3,
        background: '#005777',
      },
    })
      .png()
      .toFile(imagePath)
    const imageSpec = {
      title: 'Editable image deck',
      subtitle: 'Image fitting test',
      author: 'Test',
      language: 'en',
      audience: 'Engineering team',
      objective: 'Verify image placement',
      slides: [
        {
          type: 'image',
          title: 'The image remains inside the content frame',
          takeaway: 'Aspect ratio is preserved.',
          source_path: imagePath,
          caption: 'Generated fixture',
          fit: 'contain',
        },
      ],
    }
    const imageSpecPath = path.join(temp, 'image-spec.json')
    const imageDeck = path.join(temp, 'image.pptx')
    await fs.writeFile(imageSpecPath, JSON.stringify(imageSpec))
    await run('create-presentation.mjs', [imageSpecPath, imageDeck])
    await run('validate-presentation.mjs', [
      imageDeck,
      '--manifest',
      `${imageDeck}.qa.json`,
    ])
    const dimensions = await getImageDimensions(imagePath)
    assert.equal(dimensions.aspectRatio, 16 / 9)
    const crop = await imageSizingCrop(imagePath, { x: 0, y: 0, w: 4, h: 3 })
    assert.equal(crop.sizing.type, 'cover')

    const professionalDeck = path.join(temp, 'professional.pptx')
    await run('run-professional-deck.mjs', [
      professionalFixture,
      professionalDeck,
    ])
    await run('validate-presentation.mjs', [
      professionalDeck,
      '--manifest',
      `${professionalDeck}.qa.json`,
    ])
    const professionalZip = await JSZip.loadAsync(
      await fs.readFile(professionalDeck),
    )
    assert.ok(professionalZip.file('ppt/charts/chart1.xml'))
    assert.ok(professionalZip.file('ppt/notesSlides/notesSlide1.xml'))
    const professionalQa = JSON.parse(
      await fs.readFile(`${professionalDeck}.qa.json`, 'utf8'),
    )
    assert.equal(professionalQa.errors.length, 0)
    assert.ok(
      professionalQa.slides.every(slide => slide.actualObjectCount > 0),
    )

    const inventoryPath = path.join(temp, 'inventory.json')
    await run('inspect-template.mjs', [
      path.join(skillDir, 'assets', 'corporate-template.pptx'),
      inventoryPath,
    ])
    const expectedInventory = JSON.parse(
      await fs.readFile(
        path.join(skillDir, 'references', 'template-inventory.json'),
        'utf8',
      ),
    )
    const inventory = JSON.parse(await fs.readFile(inventoryPath, 'utf8'))
    assert.equal(inventory.sha256, expectedInventory.sha256)
    assert.equal(inventory.layouts.length, 33)

    await withMockGotenberg(async url => {
      const renderDir = path.join(temp, 'rendered')
      await run('render-via-gotenberg.mjs', [imageDeck, renderDir], {
        env: { GOTENBERG_URL: url, GOTENBERG_TIMEOUT_SECONDS: '10' },
      })
      await fs.access(path.join(renderDir, 'montage.png'))
      const rendered = (await fs.readdir(renderDir)).filter(name =>
        /^slide-\d+\.png$/.test(name),
      )
      assert.equal(rendered.length, 2)
    })

    console.log('create-ppt tests passed')
  } finally {
    await fs.rm(temp, { recursive: true, force: true })
  }
}

main().catch(error => {
  console.error(error.stack || error.message)
  process.exitCode = 1
})
