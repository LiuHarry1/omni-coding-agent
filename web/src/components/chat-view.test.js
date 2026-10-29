import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'

const chatViewSource = fs.readFileSync(
  new URL('./ChatView.jsx', import.meta.url),
  'utf-8',
)
const inputAreaSource = fs.readFileSync(
  new URL('./InputArea.jsx', import.meta.url),
  'utf-8',
)

describe('chat loading presentation', () => {
  it('does not lazy-suspend the transcript row renderer', () => {
    expect(chatViewSource).toContain(
      "import TranscriptRow from './transcript/TranscriptRow.jsx'",
    )
    expect(chatViewSource).not.toContain('fallback={null}')
    expect(chatViewSource).not.toContain('lazy(()')
  })

  it('renders an explicit loading state instead of an empty transcript', () => {
    expect(chatViewSource).toContain("role='status'")
    expect(chatViewSource).toContain('Loading conversation…')
  })

  it('disables submission while hydration is in progress', () => {
    expect(inputAreaSource).toContain(
      'const sessionLoading = useChatStore(s => s.sessionLoading)',
    )
    expect(inputAreaSource).toMatch(/disabled=\{\s*sessionLoading \|\|/)
  })
})
