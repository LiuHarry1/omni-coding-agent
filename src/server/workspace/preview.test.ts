import { afterEach, describe, expect, it, vi } from 'vitest'
import { convertOfficePreviewToPdf } from './preview.js'

describe('PPTX workspace preview conversion', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.GOTENBERG_URL
    delete process.env.GOTENBERG_TIMEOUT_SECONDS
  })

  it('sends the deck to Gotenberg and returns the converted PDF', async () => {
    process.env.GOTENBERG_URL = 'http://gotenberg.test/'
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46])
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe(
        'http://gotenberg.test/forms/libreoffice/convert',
      )
      expect(init?.method).toBe('POST')
      expect(init?.body).toBeInstanceOf(FormData)
      const file = (init?.body as FormData).get('files')
      expect(file).toBeInstanceOf(File)
      expect((file as File).name).toBe('deck.pptx')
      return new Response(pdf, {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      convertOfficePreviewToPdf(Buffer.from('pptx'), 'deck.pptx'),
    ).resolves.toEqual(Buffer.from(pdf))
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('rejects a non-PDF conversion response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return new Response('bad gateway body', {
          status: 502,
          headers: { 'content-type': 'text/plain' },
        })
      }),
    )

    await expect(
      convertOfficePreviewToPdf(Buffer.from('pptx'), 'deck.pptx'),
    ).rejects.toThrow('HTTP 502: bad gateway body')
  })
})
