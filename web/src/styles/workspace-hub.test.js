import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'

const css = fs.readFileSync(
  new URL('./workspace-hub.css', import.meta.url),
  'utf-8',
)

describe('workspace manager responsive layout', () => {
  it('uses a content-height manager with one bounded workspace list', () => {
    expect(css).toMatch(
      /\.workspace-manager-modal\s*\{[\s\S]*height:\s*auto;[\s\S]*max-height:/,
    )
    expect(css).toMatch(
      /\.workspace-manager__list\s*\{[\s\S]*flex-direction:\s*column;[\s\S]*overflow:\s*auto;[\s\S]*max-height:/,
    )
    expect(css).not.toMatch(/\.workspace-manager-row__details/)
  })

  it('keeps optional clone settings behind an advanced disclosure', () => {
    expect(css).toMatch(
      /\.workspace-create__advanced-fields\s*\{[\s\S]*display:\s*grid;/,
    )
  })
})
