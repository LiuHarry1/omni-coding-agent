import { describe, expect, it } from 'vitest'

globalThis.localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
}

const { truncateShellText } = await import('./BashCard.jsx')

describe('truncateShellText', () => {
  it('keeps the latest lines of long output', () => {
    const text = Array.from({ length: 12 }, (_, i) => `tick ${i + 1}`).join(
      '\n',
    )
    expect(truncateShellText(`${text}\n`)).toEqual({
      preview: 'tick 8\ntick 9\ntick 10\ntick 11\ntick 12',
      truncated: true,
    })
  })

  it('leaves short output untouched', () => {
    expect(truncateShellText('ok\n')).toEqual({
      preview: 'ok',
      truncated: false,
    })
  })
})
