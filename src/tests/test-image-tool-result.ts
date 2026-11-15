/**
 * Smoke test: image blocks inside tool_result.
 * Run: npx tsx src/tests/test-image-tool-result.ts
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { tool } from 'ai'
import { z } from 'zod'
import {
  buildToolMessage,
  executeOneTool,
  type ExecutedToolResult,
} from '../services/tools/tool_execution.js'
import type {
  ImagePart,
  Message,
  ToolContext,
  ToolDefinition,
  ToolResultPart,
  UserMessage,
} from '../core/types.js'
import type { IProvider } from '../services/llm/types.js'
import { buildImageBlock } from '../utils/tool-result-content.js'
import {
  compressImageBufferWithTokenLimit,
  estimateImageTokens,
  toolResultImageBlockFromBuffer,
} from '../utils/image/resize-buffer.js'
import { estimateMessageTokens } from '../services/compact/tokens.js'
import { projectMessagesForApi } from '../core/agent/messageSanitize.js'
import {
  READ_IMAGE_MAX_HEIGHT,
  READ_IMAGE_MAX_WIDTH,
  READ_IMAGE_TOKEN_BUDGET,
} from '../constants/api_limits.js'
import { readImageFile } from '../utils/read/read-image.js'
import { SCREENSHOT_TOKEN_BUDGET } from '../browser/limits.js'

/** 1x1 transparent PNG. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

function makeScreenshotDef(isError: boolean): ToolDefinition {
  return {
    name: 'Screenshot',
    description: 'test screenshot tool',
    mapToolResultToToolResultBlockParam(output, toolUseID) {
      const o = output as { note: string }
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: [
          { type: 'text', text: o.note },
          buildImageBlock(PNG_BASE64, 'image/png'),
        ],
        ...(isError ? { is_error: true } : {}),
      }
    },
    create() {
      return tool({
        description: 'test screenshot tool',
        inputSchema: z.object({}),
        execute: async () => ({ data: { note: 'shot taken' } }),
      })
    },
  }
}

async function execute(def: ToolDefinition): Promise<ExecutedToolResult[]> {
  const result = await executeOneTool(
    { toolCallId: 'c1', toolName: 'Screenshot', input: {} },
    { Screenshot: def.create('/tmp', {} as unknown as ToolContext) },
    { toolResult: () => {} } as never,
    undefined,
    name => (name === 'Screenshot' ? def : undefined),
  )
  return [result]
}

async function testImageResultReachesModel() {
  const results = await execute(makeScreenshotDef(false))
  const [result] = results
  assert.ok(result)
  assert.equal(result.result, 'shot taken\n[image]')
  assert.equal(result.resultBlocks?.length, 2)

  const msg = buildToolMessage(results)
  const output = msg.content[0]!.output
  assert.equal(output.type, 'content')
  assert.deepEqual(output.type === 'content' ? output.value : [], [
    { type: 'text', text: 'shot taken' },
    { type: 'image-data', data: PNG_BASE64, mediaType: 'image/png' },
  ])
  console.log('ok image blocks reach the model as content output')
}

async function testErrorResultDropsImage() {
  const results = await execute(makeScreenshotDef(true))
  const [result] = results
  assert.ok(result)
  assert.equal(result.isError, true)
  assert.equal(result.resultBlocks, undefined)
  assert.equal(result.result, 'shot taken')

  const msg = buildToolMessage(results)
  assert.equal(msg.content[0]!.output.type, 'text')
  console.log('ok is_error results are text-only')
}

async function testTokenEstimateSkipsBase64() {
  const results = await execute(makeScreenshotDef(false))
  const tokens = estimateMessageTokens(buildToolMessage(results))
  // Flat per-image cost, not ceil(base64.length / 4).
  assert.ok(tokens > 1000 && tokens < 2000, `unexpected estimate: ${tokens}`)
  console.log('ok token estimation uses flat image cost')
}

async function testResizePipeline() {
  const block = await toolResultImageBlockFromBuffer(
    Buffer.from(PNG_BASE64, 'base64'),
    'image/png',
  )
  assert.equal(block.type, 'image')
  assert.equal(block.source.type, 'base64')
  assert.ok(block.source.data.length > 0)
  console.log(`ok resize pipeline (${block.source.media_type})`)
}

async function testStrictImageBudget() {
  const width = 2200
  const height = 1400
  const pixels = Buffer.allocUnsafe(width * height * 3)
  // Deterministic high-entropy image: difficult enough to force both lossy
  // encoding and progressive downscaling.
  for (let i = 0; i < pixels.length; i++) {
    pixels[i] = (i * 31 + Math.floor(i / 97) * 17) & 0xff
  }
  const input = await sharp(pixels, {
    raw: { width, height, channels: 3 },
  })
    .png()
    .toBuffer()

  const maxTokens = 1500
  const block = await toolResultImageBlockFromBuffer(input, 'image/png', {
    maxTokens,
    maxWidth: 1280,
    maxHeight: 1280,
    strictBudget: true,
  })
  assert.ok(
    estimateImageTokens(block.source.data) <= maxTokens,
    'strict image budget must never return an oversized original',
  )
  const metadata = await sharp(
    Buffer.from(block.source.data, 'base64'),
  ).metadata()
  assert.ok((metadata.width ?? Infinity) <= 1280)
  assert.ok((metadata.height ?? Infinity) <= 1280)
  console.log(
    `ok strict image budget (${estimateImageTokens(block.source.data)} tokens, ${metadata.width}x${metadata.height})`,
  )
}

async function noiseJpeg(width: number, height: number, quality = 90) {
  const pixels = Buffer.allocUnsafe(width * height * 3)
  for (let i = 0; i < pixels.length; i++) {
    pixels[i] = (i * 31 + Math.floor(i / 97) * 17) & 0xff
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } })
    .jpeg({ quality })
    .toBuffer()
}

async function testTallReceiptFitsReadBudget() {
  // Width-only downscale left 240×18000 水单 JPEGs above the 25k-token cap.
  const input = await noiseJpeg(240, 18_000)
  const result = await compressImageBufferWithTokenLimit(
    input,
    READ_IMAGE_TOKEN_BUDGET,
    'image/jpeg',
    { strict: true },
  )
  const meta = await sharp(result.buffer).metadata()
  assert.ok(
    result.buffer.length <= 150_000,
    `tall receipt still ${result.buffer.length} bytes`,
  )
  const tokens = estimateImageTokens(result.buffer.toString('base64'))
  assert.ok(
    tokens <= READ_IMAGE_TOKEN_BUDGET,
    `tall receipt still ${tokens} tokens`,
  )
  console.log(
    `ok tall receipt budget (${result.buffer.length} bytes, ${meta.width}x${meta.height})`,
  )
}

async function testReadImageFileHotelFolio() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-img-'))
  const abs = path.join(dir, 'hotel.jpg')
  fs.writeFileSync(abs, await noiseJpeg(3024, 4032, 95))
  const output = await readImageFile(abs, '酒店水单.jpg')
  assert.equal(output.type, 'image')
  assert.ok(output.file.base64.length > 0)
  assert.ok(
    estimateImageTokens(output.file.base64) <= READ_IMAGE_TOKEN_BUDGET,
    `Read image still ${estimateImageTokens(output.file.base64)} tokens`,
  )
  const meta = await sharp(Buffer.from(output.file.base64, 'base64')).metadata()
  assert.ok((meta.width ?? Infinity) <= READ_IMAGE_MAX_WIDTH)
  assert.ok((meta.height ?? Infinity) <= READ_IMAGE_MAX_HEIGHT)
  console.log(
    `ok Read 酒店水单.jpg (${estimateImageTokens(output.file.base64)} tokens, ${meta.width}x${meta.height})`,
  )
}

async function testJsFallbackWithoutSharp() {
  const prev = process.env.BAIZE_DISABLE_SHARP
  process.env.BAIZE_DISABLE_SHARP = '1'
  try {
    const input = await noiseJpeg(240, 18_000)
    const result = await compressImageBufferWithTokenLimit(
      input,
      READ_IMAGE_TOKEN_BUDGET,
      'image/jpeg',
      { strict: true },
    )
    assert.ok(
      result.buffer.length <= 150_000,
      `JS fallback still ${result.buffer.length} bytes`,
    )
    console.log(`ok JS fallback without sharp (${result.buffer.length} bytes)`)

    const pngPixels = Buffer.allocUnsafe(1280 * 800 * 3)
    for (let i = 0; i < pngPixels.length; i++) {
      pngPixels[i] = (i * 31 + Math.floor(i / 97) * 17) & 0xff
    }
    const pngInput = await sharp(pngPixels, {
      raw: { width: 1280, height: 800, channels: 3 },
    })
      .png()
      .toBuffer()
    const pngResult = await compressImageBufferWithTokenLimit(
      pngInput,
      SCREENSHOT_TOKEN_BUDGET,
      'image/png',
      { strict: true },
    )
    const pngMaxBytes = Math.floor(
      Math.floor(SCREENSHOT_TOKEN_BUDGET / 0.125) * 0.75,
    )
    assert.ok(
      pngResult.buffer.length <= pngMaxBytes,
      `JS PNG fallback still ${pngResult.buffer.length} bytes`,
    )
    assert.equal(pngResult.mediaType, 'image/jpeg')
    console.log(
      `ok JS PNG fallback without sharp (${pngResult.buffer.length} bytes)`,
    )
  } finally {
    if (prev === undefined) delete process.env.BAIZE_DISABLE_SHARP
    else process.env.BAIZE_DISABLE_SHARP = prev
  }
}

async function testCompressionFailureFallsBackToOriginal() {
  const prev = process.env.BAIZE_DISABLE_SHARP
  process.env.BAIZE_DISABLE_SHARP = '1'
  try {
    const raw = Buffer.concat([
      Buffer.from('NOTANIMAGE'),
      Buffer.alloc(80_000, 1),
    ])
    const block = await toolResultImageBlockFromBuffer(raw, 'image/webp', {
      maxTokens: SCREENSHOT_TOKEN_BUDGET,
      strictBudget: true,
    })
    assert.equal(block.source.data, raw.toString('base64'))
    assert.equal(block.source.media_type, 'image/webp')
    console.log('ok compression failure falls back to original')
  } finally {
    if (prev === undefined) delete process.env.BAIZE_DISABLE_SHARP
    else process.env.BAIZE_DISABLE_SHARP = prev
  }
}

function fakeProvider(supportsContentBlocks: boolean): IProvider {
  return {
    chatModel: () => ({}) as never,
    streamTextExtras: () => ({}),
    defaultModelId: () => 'test',
    describe: () => 'test',
    supportsToolResultContentBlocks: () => supportsContentBlocks,
  }
}

async function projectedMessages(provider: IProvider): Promise<Message[]> {
  const results = await execute(makeScreenshotDef(false))
  return projectMessagesForApi([buildToolMessage(results) as Message], provider)
}

async function testMultimodalProviderKeepsBlocks() {
  const projected = await projectedMessages(fakeProvider(true))
  assert.equal(projected.length, 1)
  const part = (projected[0] as { content: ToolResultPart[] }).content[0]!
  assert.equal(part.output.type, 'content')
  console.log('ok multimodal provider keeps content blocks')
}

async function testChatCompletionsProviderRelocatesImage() {
  const projected = await projectedMessages(fakeProvider(false))
  assert.equal(projected.length, 2)

  const part = (projected[0] as { content: ToolResultPart[] }).content[0]!
  assert.equal(part.output.type, 'text')
  assert.equal(
    part.output.type === 'text' ? part.output.value : '',
    'shot taken\n[image]',
  )

  const relocated = projected[1] as UserMessage
  assert.equal(relocated.role, 'user')
  assert.equal(relocated.isMeta, true)
  const image = (relocated.content as ImagePart[]).find(p => p.type === 'image')
  assert.ok(image, 'expected a relocated image part')
  assert.equal(image.mediaType, 'image/png')
  assert.ok(Buffer.isBuffer(image.image))
  console.log('ok chat-completions provider relocates image to user message')
}

async function main() {
  await testImageResultReachesModel()
  await testErrorResultDropsImage()
  await testTokenEstimateSkipsBase64()
  await testResizePipeline()
  await testStrictImageBudget()
  await testTallReceiptFitsReadBudget()
  await testReadImageFileHotelFolio()
  await testJsFallbackWithoutSharp()
  await testCompressionFailureFallsBackToOriginal()
  await testMultimodalProviderKeepsBlocks()
  await testChatCompletionsProviderRelocatesImage()
  console.log('\nall image tool_result tests passed')
}

void main().catch(err => {
  console.error(err)
  process.exit(1)
})
