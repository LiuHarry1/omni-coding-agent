import { imageSizing } from './media-layout.mjs'
import { fitText, measureTextBlock } from './text-layout.mjs'

export { imageSizing } from './media-layout.mjs'

export const PAGE = { width: 13.333, height: 7.5 }
export const GRID = {
  left: 0.72,
  right: 0.72,
  top: 0.52,
  titleTop: 0.48,
  titleHeight: 0.7,
  contentTop: 1.48,
  contentBottom: 6.72,
  footerTop: 6.9,
}

export const COLORS = {
  teal: '005777',
  orange: 'FF7E00',
  purple: '651366',
  green: '25993F',
  cyan: '05A8B3',
  magenta: '8C003D',
  charcoal: '3F3F3F',
  muted: '707880',
  line: 'D7DEE2',
  pale: 'F3F7F8',
  offWhite: 'F8F8F8',
  white: 'FFFFFF',
}

export const ACCENTS = [
  COLORS.teal,
  COLORS.orange,
  COLORS.green,
  COLORS.purple,
  COLORS.magenta,
]

export function fontFor(language) {
  const lower = language.toLowerCase()
  if (lower.startsWith('zh')) return 'Microsoft YaHei'
  if (lower.startsWith('ja')) return 'Meiryo'
  return 'Arial'
}

export function estimateText(text, width, fontSize, options = {}) {
  const measured = measureTextBlock(text, {
    width,
    fontSize,
    fontFace: options.fontFace ?? 'Arial',
    margin: options.margin ?? 0.08,
    lineSpacing: options.lineSpacing ?? 1.2,
  })
  return { lines: measured.lineCount, height: measured.height }
}

export function fitFontSize(
  text,
  width,
  height,
  {
    max = 20,
    min = 14,
    margin = 0.08,
    lineSpacing = 1.2,
    fontFace = /[\u2E80-\u9FFF\uF900-\uFAFF\u3040-\u30FF]/u.test(String(text))
      ? 'Microsoft YaHei'
      : 'Arial',
  } = {},
) {
  const fitted = fitText(text, {
    width,
    height,
    maxFontSize: max,
    minFontSize: min,
    fontFace,
    margin,
    lineSpacing,
  })
  return { size: fitted.size, lines: fitted.lineCount, height: fitted.height, overflow: fitted.overflow || undefined }
}

export function createQa(spec) {
  return {
    schemaVersion: 1,
    deck: spec.title,
    generatedAt: new Date().toISOString(),
    slides: [],
    warnings: [],
    errors: [],
  }
}

export function slideContext(qa, type, title) {
  const result = {
    index: qa.slides.length + 1,
    type,
    title,
    boxes: [],
    warnings: [],
    errors: [],
  }
  qa.slides.push(result)
  return result
}

export function recordBox(context, name, box, options = {}) {
  const item = {
    name,
    x: Number(box.x.toFixed(3)),
    y: Number(box.y.toFixed(3)),
    w: Number(box.w.toFixed(3)),
    h: Number(box.h.toFixed(3)),
    role: options.role ?? 'content',
    collisionGroup: options.collisionGroup ?? null,
  }
  context.boxes.push(item)
  const epsilon = 0.001
  if (
    item.x < -epsilon ||
    item.y < -epsilon ||
    item.x + item.w > PAGE.width + epsilon ||
    item.y + item.h > PAGE.height + epsilon
  ) {
    context.errors.push(`${name} is outside the slide boundary`)
  }
  return item
}

export function checkCollisions(context) {
  const candidates = context.boxes.filter(
    box => box.role === 'flow' && box.collisionGroup,
  )
  for (let leftIndex = 0; leftIndex < candidates.length; leftIndex += 1) {
    const left = candidates[leftIndex]
    for (let rightIndex = leftIndex + 1; rightIndex < candidates.length; rightIndex += 1) {
      const right = candidates[rightIndex]
      if (left.collisionGroup !== right.collisionGroup) continue
      const overlapX =
        Math.min(left.x + left.w, right.x + right.w) - Math.max(left.x, right.x)
      const overlapY =
        Math.min(left.y + left.h, right.y + right.h) - Math.max(left.y, right.y)
      if (overlapX > 0.015 && overlapY > 0.015) {
        context.errors.push(`${left.name} overlaps ${right.name}`)
      }
    }
  }
}

export function addTrackedText(slide, context, name, text, box, options = {}) {
  slide.addText(text, {
    margin: 0,
    breakLine: false,
    valign: 'mid',
    ...box,
    ...options,
  })
  recordBox(context, name, box, options.qa)
}

export function addTrackedShape(
  slide,
  context,
  name,
  shapeType,
  box,
  options = {},
) {
  slide.addShape(shapeType, { ...box, ...options })
  recordBox(context, name, box, options.qa)
}

export function addSlideTitle(slide, context, title, fontFace) {
  const box = { x: GRID.left, y: GRID.titleTop, w: 11.9, h: GRID.titleHeight }
  const fitted = fitFontSize(title, box.w, box.h, {
    max: 27,
    min: 22,
    fontFace,
  })
  addTrackedText(slide, context, 'title', title, box, {
    fontFace,
    fontSize: fitted.size,
    bold: true,
    color: COLORS.charcoal,
    valign: 'top',
  })
  if (fitted.overflow) context.warnings.push('title may exceed two lines')
}

export function addSource(slide, context, source, fontFace) {
  if (!source) return
  addTrackedText(
    slide,
    context,
    'source',
    source,
    { x: GRID.left, y: GRID.footerTop, w: 11.9, h: 0.24 },
    {
      fontFace,
      fontSize: 8.5,
      color: COLORS.muted,
      valign: 'top',
    },
  )
}

export function addNotes(slide, item) {
  const notes = [item.takeaway, item.speaker_notes].filter(Boolean)
  if (notes.length) slide.addNotes(notes.join('\n\n'))
}

export function textRunsForBullets(bullets, options = {}) {
  const color = options.color ?? COLORS.charcoal
  const fontFace = options.fontFace ?? 'Arial'
  const fontSize = options.fontSize ?? 17
  return bullets.map((bullet, index) => ({
    text: bullet,
    options: {
      bullet: { indent: fontSize },
      hanging: Math.round(fontSize * 0.28),
      breakLine: index < bullets.length - 1,
      paraSpaceAfterPt: 9,
      color,
      fontFace,
      fontSize,
    },
  }))
}

