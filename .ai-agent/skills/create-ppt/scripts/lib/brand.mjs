import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { COLORS, PAGE, fontFor } from './design.mjs'
import { loadRuntimePackage } from './runtime-deps.mjs'

const JSZip = loadRuntimePackage('jszip')

const moduleDir = path.dirname(fileURLToPath(import.meta.url))
export const DEFAULT_TEMPLATE_PATH = path.resolve(
  moduleDir,
  '..',
  '..',
  'assets',
  'corporate-template.pptx',
)

export async function loadAdvantestAssets(templatePath = DEFAULT_TEMPLATE_PATH) {
  const zip = await JSZip.loadAsync(await fs.readFile(templatePath))
  const imageData = async name => {
    const file = zip.file(`ppt/media/${name}`)
    if (!file) throw new Error(`Corporate template is missing ${name}`)
    const buffer = await file.async('nodebuffer')
    return `data:image/jpeg;base64,${buffer.toString('base64')}`
  }
  return {
    templatePath,
    coverBackground: await imageData('image1.jpeg'),
    sectionBackground: await imageData('image4.jpeg'),
  }
}

export function configureAdvantestPresentation(pptx, metadata) {
  const language = metadata.language ?? 'en'
  const fontFace = fontFor(language)
  pptx.layout = 'LAYOUT_WIDE'
  pptx.author = metadata.author || 'Advantest'
  pptx.company = 'Advantest'
  pptx.subject = metadata.objective || ''
  pptx.title = metadata.title
  pptx.lang = language
  pptx.theme = {
    headFontFace: fontFace,
    bodyFontFace: fontFace,
    lang: language,
  }
  pptx.defineSlideMaster({
    title: 'ADVANTEST_CONTENT',
    background: { color: COLORS.white },
    objects: [],
  })
  return { fontFace, page: PAGE }
}
