import fs from 'node:fs/promises'
import path from 'node:path'
import { configureAdvantestPresentation, loadAdvantestAssets } from './brand.mjs'
import { loadRuntimePackage } from './runtime-deps.mjs'
import {
  ACCENTS,
  COLORS,
  GRID,
  PAGE,
  addNotes,
  addSlideTitle,
  addSource,
  addTrackedShape,
  addTrackedText,
  createQa,
  recordBox,
  slideContext,
} from './design.mjs'
import {
  getImageDimensions,
  imageSizing,
  imageSizingContain,
  imageSizingCrop,
  svgToDataUri,
} from './media-layout.mjs'
import { appendSlideObjectQa, safeOuterShadow } from './slide-qa.mjs'
import { fitText, measureTextBlock, measureTextWidth } from './text-layout.mjs'

const pptxgen = loadRuntimePackage('pptxgenjs')

function assertMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') throw new Error('deck.mjs must export metadata')
  if (!String(metadata.title ?? '').trim()) throw new Error('metadata.title is required')
}

function addBackground(slide, context, pptx, color = COLORS.white) {
  addTrackedShape(
    slide,
    context,
    'background',
    pptx.ShapeType.rect,
    { x: 0, y: 0, w: PAGE.width, h: PAGE.height },
    {
      fill: { color },
      line: { color, transparency: 100 },
      qa: { role: 'background' },
    },
  )
}

function addWordmark(slide, context, fontFace) {
  addTrackedText(
    slide,
    context,
    'wordmark',
    'ADVANTEST.',
    { x: 0.28, y: 7.14, w: 1.25, h: 0.18 },
    {
      fontFace,
      fontSize: 7.5,
      bold: true,
      italic: true,
      color: COLORS.magenta,
      valign: 'top',
      qa: { role: 'decoration' },
    },
  )
}

export async function buildProfessionalDeck({
  metadata,
  build,
  outputPath,
  qaPath = `${outputPath}.qa.json`,
  templatePath,
}) {
  assertMetadata(metadata)
  if (typeof build !== 'function') throw new Error('deck.mjs default export must be a build function')
  const specLike = { title: metadata.title }
  const qa = createQa(specLike)
  const pptx = new pptxgen()
  const { fontFace } = configureAdvantestPresentation(pptx, metadata)
  const brand = await loadAdvantestAssets(templatePath)
  let active = null

  function finalizeActive() {
    if (!active || active.finalized) return
    appendSlideObjectQa(active.slide, active.context, { page: PAGE })
    active.finalized = true
  }

  function newSlide(options = {}) {
    finalizeActive()
    const type = options.type ?? 'content'
    const title = String(options.title ?? '').trim()
    if (!title) throw new Error('Every professional slide requires a title')
    const slide =
      type === 'content' ? pptx.addSlide('ADVANTEST_CONTENT') : pptx.addSlide()
    const context = slideContext(qa, type, title)
    if (options.backgroundData) {
      slide.addImage({
        data: options.backgroundData,
        x: 0,
        y: 0,
        w: PAGE.width,
        h: PAGE.height,
      })
      recordBox(context, 'background-image', {
        x: 0,
        y: 0,
        w: PAGE.width,
        h: PAGE.height,
      }, { role: 'background' })
    } else {
      addBackground(slide, context, pptx, options.background ?? COLORS.white)
    }
    if (options.chrome !== false) {
      addWordmark(slide, context, fontFace)
      addSlideTitle(slide, context, title, fontFace)
      addSource(slide, context, options.source, fontFace)
    }
    if (options.takeaway || options.notes) {
      addNotes(slide, {
        takeaway: options.takeaway,
        speaker_notes: options.notes,
      })
    }
    active = { slide, context, finalized: false }
    return active
  }

  const api = {
    pptx,
    brand,
    colors: COLORS,
    accents: ACCENTS,
    grid: GRID,
    page: PAGE,
    fontFace,
    shapeType: pptx.ShapeType,
    chartType: pptx.ChartType,
    fitText,
    measureTextBlock,
    measureTextWidth,
    getImageDimensions,
    imageSizing,
    imageSizingContain,
    imageSizingCrop,
    svgToDataUri,
    safeOuterShadow,
    newSlide,
    cover(options = {}) {
      return newSlide({
        ...options,
        type: 'cover',
        title: options.title ?? metadata.title,
        backgroundData: options.backgroundData ?? brand.coverBackground,
        chrome: false,
      })
    },
    section(options = {}) {
      return newSlide({
        ...options,
        type: 'section',
        backgroundData: options.backgroundData ?? brand.sectionBackground,
        chrome: false,
      })
    },
    text(name, text, box, options = {}) {
      if (!active) throw new Error('Call newSlide(), cover(), or section() before text()')
      addTrackedText(active.slide, active.context, name, text, box, {
        fontFace,
        ...options,
      })
      return active.slide
    },
    shape(name, type, box, options = {}) {
      if (!active) throw new Error('Call newSlide() before shape()')
      addTrackedShape(active.slide, active.context, name, type, box, options)
      return active.slide
    },
    async image(name, source, box, options = {}) {
      if (!active) throw new Error('Call newSlide() before image()')
      const sizing = await imageSizing(source, box, options.fit ?? 'contain')
      const sourceOption = String(source).startsWith('data:')
        ? { data: source }
        : { path: source }
      active.slide.addImage({ ...sourceOption, ...sizing, ...options.pptx })
      recordBox(active.context, name, box, options.qa)
      return active.slide
    },
    chart(name, type, data, box, options = {}) {
      if (!active) throw new Error('Call newSlide() before chart()')
      active.slide.addChart(type, data, { ...box, ...options })
      recordBox(active.context, name, box, options.qa)
      return active.slide
    },
    table(name, rows, box, options = {}) {
      if (!active) throw new Error('Call newSlide() before table()')
      active.slide.addTable(rows, { ...box, ...options })
      recordBox(active.context, name, box, options.qa)
      return active.slide
    },
    notes(takeaway, notes) {
      if (!active) throw new Error('Call newSlide() before notes()')
      addNotes(active.slide, { takeaway, speaker_notes: notes })
    },
  }

  await build(api)
  finalizeActive()
  if (!qa.slides.length) throw new Error('Professional deck did not create any slides')
  for (const slide of qa.slides) {
    qa.warnings.push(...slide.warnings.map(message => `slide ${slide.index}: ${message}`))
    qa.errors.push(...slide.errors.map(message => `slide ${slide.index}: ${message}`))
  }
  await fs.mkdir(path.dirname(qaPath), { recursive: true })
  await fs.writeFile(qaPath, `${JSON.stringify(qa, null, 2)}\n`)
  if (qa.errors.length) throw new Error(`Layout QA failed:\n- ${qa.errors.join('\n- ')}`)
  await fs.mkdir(path.dirname(outputPath), { recursive: true })
  await pptx.writeFile({ fileName: outputPath, compression: true })
  return {
    success: true,
    file: outputPath,
    qa: qaPath,
    slides: qa.slides.length,
    warnings: qa.warnings.length,
  }
}
