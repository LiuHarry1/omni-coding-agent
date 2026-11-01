import * as fs from 'node:fs'
import { describe, expect, it } from 'vitest'

function read(relativePath) {
  return fs.readFileSync(new URL(relativePath, import.meta.url), 'utf-8')
}

const baseCss = read('./base.css')
const chatCss = read('./chat.css')
const headerCss = read('./header.css')
const inputCss = read('./input.css')
const sessionCss = read('./session-switcher.css')
const welcomeSource = read('../components/WelcomeScreen.jsx')

describe('core UI polish', () => {
  it('bundles Inter with Chinese system fallbacks', () => {
    expect(baseCss).toContain("'Inter Variable'")
    expect(baseCss).toContain("'PingFang SC'")
    expect(baseCss).toContain("'Microsoft YaHei'")
  })

  it('right-aligns compact user messages', () => {
    expect(chatCss).toMatch(
      /\.msg-user\s*\{[\s\S]*width:\s*fit-content;[\s\S]*margin-left:\s*auto;/,
    )
  })

  it('uses neutral disabled and count states', () => {
    expect(inputCss).toMatch(
      /\.composer-btn--send:disabled\s*\{[\s\S]*background:\s*var\(--bg-tertiary\);[\s\S]*opacity:\s*1;/,
    )
    expect(sessionCss).toMatch(
      /\.session-icon-count\s*\{[\s\S]*background:\s*var\(--bg-tertiary\);[\s\S]*color:\s*var\(--text-secondary\);/,
    )
  })

  it('uses sans text for workspace names and SVG welcome icons', () => {
    expect(headerCss).toMatch(
      /\.workspace-chip\s*\{[\s\S]*font-family:\s*var\(--font-sans\);/,
    )
    expect(welcomeSource).toContain('function WelcomeIcon')
    expect(welcomeSource).not.toMatch(
      /\\u\{(?:1F50D|1F41B|1F4DD|1F40D|1F3AE|1F3B2|1F3D3|1F522|1F4AC)\}/,
    )
  })
})
