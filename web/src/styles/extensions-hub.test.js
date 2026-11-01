import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'

const hubCss = fs.readFileSync(
  new URL('./extensions-hub.css', import.meta.url),
  'utf-8',
)
const editorCss = fs.readFileSync(
  new URL('./extensions-editor.css', import.meta.url),
  'utf-8',
)
const marketplaceCss = fs.readFileSync(
  new URL('./extensions-marketplace.css', import.meta.url),
  'utf-8',
)

describe('extensions hub responsive layout', () => {
  it('uses sidebar navigation on wide screens and scrollable tabs on mobile', () => {
    expect(hubCss).toMatch(
      /\.extensions-hub__layout\s*\{[\s\S]*grid-template-columns:\s*200px/,
    )
    expect(hubCss).toMatch(
      /@media \(max-width: 720px\)[\s\S]*\.extensions-nav__list\s*\{[\s\S]*flex-direction:\s*row/,
    )
    expect(hubCss).toMatch(
      /@media \(max-width: 720px\)[\s\S]*\.extensions-nav\s*\{[\s\S]*overflow-x:\s*auto/,
    )
  })

  it('keeps resource editors split on desktop and stacked on mobile', () => {
    expect(editorCss).toMatch(
      /\.extensions-master-detail\s*\{[\s\S]*grid-template-columns:\s*270px/,
    )
    expect(editorCss).toMatch(
      /@media \(max-width: 720px\)[\s\S]*\.extensions-master-detail\s*\{[\s\S]*flex-direction:\s*column/,
    )
  })

  it('uses responsive Marketplace skeleton cards while loading', () => {
    expect(marketplaceCss).toMatch(
      /\.ws-marketplace-skeleton\s*\{[\s\S]*grid-template-columns:\s*repeat\(2/,
    )
    expect(marketplaceCss).toMatch(
      /@media \(max-width: 720px\)[\s\S]*\.ws-marketplace-skeleton\s*\{[\s\S]*grid-template-columns:\s*1fr/,
    )
    expect(marketplaceCss).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*animation:\s*none/,
    )
  })
})
