/**
 * Workspace HTML preview route (search2chart-style HTTP serve).
 * Run: npx tsx src/tests/test-workspace-preview.ts
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  createWorkspaceRouter,
  type WorkspaceRouterOptions,
} from '../server/workspace/router.js'
import {
  getPreviewBaseUrl,
  type RemotePreviewFs,
} from '../server/workspace/preview.js'

const SAMPLE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>t</title></head>
<body><p id="ok">search2chart-style preview</p></body></html>`
const SAMPLE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)
const SAMPLE_PDF = Buffer.from('%PDF-1.4\n% workspace preview fixture\n%%EOF\n')

function sampleChartHtml(): string {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>Chart</title></head>
<body>
<script>
const D={title:"Test",categories:["A","B"],seriesList:[{name:"S",data:[1,2]}],
palettes:{default:["#5470c6"]},defaultType:"bar",defaultPalette:"default",width:400,height:300};
document.body.textContent=D.title+" "+D.categories.join(",");
</script>
</body></html>`
}

async function withServer(
  root: string,
  fn: (base: string) => Promise<void>,
  options: Partial<WorkspaceRouterOptions> = {},
): Promise<void> {
  const router = createWorkspaceRouter({ ...options, root })
  const server = http.createServer(async (req, res) => {
    if (await router(req, res)) return
    res.writeHead(404).end('not found')
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const addr = server.address()
  assert(addr && typeof addr === 'object')
  const base = `http://127.0.0.1:${addr.port}`
  try {
    await fn(base)
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(err => (err ? reject(err) : resolve()))
    })
  }
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-preview-'))
  const chartPath = path.join(root, 'charts', 'sample.html')
  fs.mkdirSync(path.join(root, 'charts'), { recursive: true })
  fs.writeFileSync(chartPath, sampleChartHtml(), 'utf8')
  const imagePath = path.join(root, 'charts', 'sample.png')
  fs.writeFileSync(imagePath, SAMPLE_PNG)
  const pdfPath = path.join(root, 'charts', 'sample.pdf')
  fs.writeFileSync(pdfPath, SAMPLE_PDF)
  fs.writeFileSync(path.join(root, 'notes.txt'), 'not html', 'utf8')
  const remoteRoot = '/workspace/repo'
  const remoteHtml = Buffer.from(sampleChartHtml(), 'utf8')
  const remoteFiles = new Map<string, Buffer>([
    [`${remoteRoot}/charts/remote.html`, remoteHtml],
    [`${remoteRoot}/images/remote.png`, SAMPLE_PNG],
    [`${remoteRoot}/reports/remote.pdf`, SAMPLE_PDF],
    ['/workspace/outside.html', Buffer.from(SAMPLE_HTML, 'utf8')],
  ])
  const remotePort: RemotePreviewFs = {
    async realpath(filePath) {
      return path.posix.normalize(filePath)
    },
    async inspectPath(filePath) {
      if (filePath === `${remoteRoot}/charts/link.html`) {
        return { type: 'symlink' as const, size: 0 }
      }
      const body = remoteFiles.get(filePath)
      return body
        ? { type: 'file' as const, size: body.length }
        : { type: 'missing' as const, size: 0 }
    },
    async readHead(filePath, maxBytes) {
      return (remoteFiles.get(filePath) ?? Buffer.alloc(0)).subarray(
        0,
        maxBytes,
      )
    },
  }

  const prevUrl = process.env.AGENT_PUBLIC_URL
  process.env.AGENT_PUBLIC_URL = 'http://preview.example.com'
  try {
    assert.strictEqual(getPreviewBaseUrl(), 'http://preview.example.com')

    await withServer(
      root,
      async base => {
        const metaRes = await fetch(`${base}/workspace`)
        assert.strictEqual(metaRes.status, 200)
        const meta = (await metaRes.json()) as {
          workspace: string
          previewBaseUrl?: string
        }
        assert.strictEqual(meta.workspace, root)
        assert.strictEqual(meta.previewBaseUrl, 'http://preview.example.com')

        const okRes = await fetch(
          `${base}/workspace/preview?path=${encodeURIComponent(chartPath)}`,
        )
        assert.strictEqual(okRes.status, 200)
        assert.match(okRes.headers.get('content-type') || '', /text\/html/)
        assert.match(okRes.headers.get('content-disposition') || '', /inline/i)
        assert.equal(
          okRes.headers.get('content-security-policy'),
          'sandbox allow-scripts allow-downloads',
        )
        assert.equal(okRes.headers.get('x-content-type-options'), 'nosniff')
        const body = await okRes.text()
        assert.match(body, /Test/)

        const imageRes = await fetch(
          `${base}/workspace/preview?path=${encodeURIComponent(imagePath)}`,
        )
        assert.strictEqual(imageRes.status, 200)
        assert.equal(imageRes.headers.get('content-type'), 'image/png')
        assert.deepEqual(Buffer.from(await imageRes.arrayBuffer()), SAMPLE_PNG)

        const pdfRes = await fetch(
          `${base}/workspace/preview?path=${encodeURIComponent(pdfPath)}`,
        )
        assert.strictEqual(pdfRes.status, 200)
        assert.equal(pdfRes.headers.get('content-type'), 'application/pdf')
        assert.match(pdfRes.headers.get('content-disposition') || '', /inline/i)
        assert.deepEqual(Buffer.from(await pdfRes.arrayBuffer()), SAMPLE_PDF)

        const badExt = await fetch(
          `${base}/workspace/preview?path=${encodeURIComponent(path.join(root, 'notes.txt'))}`,
        )
        assert.strictEqual(badExt.status, 400)

        const outside = path.join(os.tmpdir(), `outside-${Date.now()}.html`)
        fs.writeFileSync(outside, SAMPLE_HTML, 'utf8')
        try {
          process.env.AUTH_ENABLED = 'true'
          const escapeRes = await fetch(
            `${base}/workspace/preview?path=${encodeURIComponent(outside)}`,
          )
          assert.strictEqual(escapeRes.status, 403)
        } finally {
          delete process.env.AUTH_ENABLED
          fs.unlinkSync(outside)
        }

        const remoteRes = await fetch(
          `${base}/workspace/preview?environmentId=${encodeURIComponent('cloud:owned')}&path=${encodeURIComponent(`${remoteRoot}/charts/remote.html`)}`,
        )
        assert.strictEqual(remoteRes.status, 200)
        assert.match(await remoteRes.text(), /Test/)

        const relativeRemoteRes = await fetch(
          `${base}/workspace/preview?environmentId=${encodeURIComponent('cloud:owned')}&path=${encodeURIComponent('charts/remote.html')}`,
        )
        assert.strictEqual(relativeRemoteRes.status, 200)

        const remoteImageRes = await fetch(
          `${base}/workspace/preview?environmentId=${encodeURIComponent('cloud:owned')}&path=${encodeURIComponent(`${remoteRoot}/images/remote.png`)}`,
        )
        assert.strictEqual(remoteImageRes.status, 200)
        assert.equal(remoteImageRes.headers.get('content-type'), 'image/png')
        assert.deepEqual(
          Buffer.from(await remoteImageRes.arrayBuffer()),
          SAMPLE_PNG,
        )

        const remotePdfRes = await fetch(
          `${base}/workspace/preview?environmentId=${encodeURIComponent('cloud:owned')}&path=${encodeURIComponent(`${remoteRoot}/reports/remote.pdf`)}`,
        )
        assert.strictEqual(remotePdfRes.status, 200)
        assert.equal(
          remotePdfRes.headers.get('content-type'),
          'application/pdf',
        )
        assert.match(
          remotePdfRes.headers.get('content-disposition') || '',
          /inline/i,
        )
        assert.deepEqual(
          Buffer.from(await remotePdfRes.arrayBuffer()),
          SAMPLE_PDF,
        )

        const remoteEscape = await fetch(
          `${base}/workspace/preview?environmentId=${encodeURIComponent('cloud:owned')}&path=${encodeURIComponent('/workspace/outside.html')}`,
        )
        assert.strictEqual(remoteEscape.status, 403)

        const remoteSymlink = await fetch(
          `${base}/workspace/preview?environmentId=${encodeURIComponent('cloud:owned')}&path=${encodeURIComponent(`${remoteRoot}/charts/link.html`)}`,
        )
        assert.strictEqual(remoteSymlink.status, 403)

        const otherEnvironment = await fetch(
          `${base}/workspace/preview?environmentId=${encodeURIComponent('cloud:other')}&path=${encodeURIComponent(`${remoteRoot}/charts/remote.html`)}`,
        )
        assert.strictEqual(otherEnvironment.status, 404)
      },
      {
        resolveRemotePreview: async (_req, environmentId) =>
          environmentId === 'cloud:owned'
            ? { port: remotePort, workspaceRoot: remoteRoot }
            : null,
      },
    )

    console.log('workspace preview tests OK')
  } finally {
    if (prevUrl === undefined) delete process.env.AGENT_PUBLIC_URL
    else process.env.AGENT_PUBLIC_URL = prevUrl
    fs.rmSync(root, { recursive: true, force: true })
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
