import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'

const css = fs.readFileSync(
  new URL('./workspace-panel.css', import.meta.url),
  'utf-8',
)

describe('workspace panel tabs', () => {
  it('switches the selected underline without a delayed border transition', () => {
    const baseRule = css.match(/\.ws-panel-tab\s*\{([\s\S]*?)\}/)?.[1] ?? ''
    const activeRule =
      css.match(/\.ws-panel-tab--active\s*\{([\s\S]*?)\}/)?.[1] ?? ''

    expect(baseRule).not.toMatch(/transition:[^;]*border-color/)
    expect(activeRule).toContain('border-bottom-color: var(--accent)')
  })
})
