/**
 * Smoke: composer attachments (pdf / csv / text / binary) reach the model via
 * the same Read-style machinery `@mentions` use.
 * Run: npx tsx src/tests/test-chat-attachments.ts
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  classifyAttachment,
  attachmentMediaType,
  assertAttachmentSize,
} from '../constants/attachment-types.js'
import { BINARY_EXTENSIONS } from '../constants/files.js'
import {
  registerSessionLocation,
  clearSessionLocationCache,
  getSessionDataDir,
} from '../core/session-paths.js'
import {
  saveChatAttachment,
  parseChatUploadRef,
  getChatUploadsDir,
  resolveChatAttachmentAbsPath,
} from '../utils/chat-uploads.js'
import { toModelFilePath } from '../utils/attachments/attachment-to-messages.js'
import { resolveChatAttachments } from '../utils/attachments/from-chat-upload.js'
import {
  createShellAttachmentStager,
  environmentUploadsDir,
} from '../utils/attachments/stage-for-shell.js'
import { ShellFsPort } from '../execution/shell-fs.js'
import { getAppDirName } from '../utils/app-dir.js'
import { FILE_READ_TOOL_NAME } from '../constants/tool_names.js'
import {
  summarizeDelimitedFile,
  splitDelimitedLine,
} from '../utils/attachments/tabular-summary.js'
import { expandAttachmentMessagesForAPI } from '../utils/messages.js'
import { sessionToUIMessages } from '../server/session-ui.js'
import { attachmentKind as clientAttachmentKind } from '../../web/src/lib/composer-attachments.js'
import { messagesToBubbles } from '../../web/src/lib/bubbles/messages-to-bubbles.js'
import type { IProvider } from '../core/llm/types.js'
import type { Message } from '../core/types.js'
import { buildUserMessage } from '../core/query/helpers.js'

const SESSION_ID = '11111111-2222-3333-4444-555555555555'
const agentHome = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-att-'))

function stubProvider(caps: Partial<IProvider>): IProvider {
  return {
    chatModel: () => {
      throw new Error('no model in test')
    },
    streamTextExtras: () => ({}),
    defaultModelId: () => 'test',
    describe: () => 'test',
    ...caps,
  } as IProvider
}

/** Flatten prelude messages (incl. attachment wrappers) to searchable text. */
function renderedText(messages: Message[]): string {
  return JSON.stringify(expandAttachmentMessagesForAPI(messages))
}

/** Smallest structurally valid one-page PDF (passes the %PDF- header gate). */
function minimalPdf(): Buffer {
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>\nendobj\n',
  ]
  let body = '%PDF-1.4\n'
  const offsets: number[] = []
  for (const obj of objects) {
    offsets.push(body.length)
    body += obj
  }
  const xrefStart = body.length
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const off of offsets) {
    body += `${String(off).padStart(10, '0')} 00000 n \n`
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`
  return Buffer.from(body, 'latin1')
}

registerSessionLocation(SESSION_ID, { projectKey: 'test-project', agentHome })

try {
  // ── classification ────────────────────────────────────
  assert.equal(classifyAttachment('a.png'), 'image')
  assert.equal(classifyAttachment('a.PDF'), 'pdf')
  assert.equal(classifyAttachment('data.csv'), 'text')
  assert.equal(classifyAttachment('Makefile'), 'text')
  assert.equal(classifyAttachment('report.docx'), 'binary')
  assert.equal(classifyAttachment('archive.zip'), 'binary')
  // Formats the browser labels `image/*` but the ImagePart pipeline cannot
  // encode must not be stored under an image extension.
  assert.equal(classifyAttachment('scan.bmp', 'image/bmp'), 'binary')
  assert.equal(classifyAttachment('photo.heic', 'image/heic'), 'binary')
  assert.equal(classifyAttachment('logo.svg', 'image/svg+xml'), 'text')
  assert.equal(classifyAttachment('logo.svg'), 'text')
  const specialized = new Set([
    '.png',
    '.jpg',
    '.jpeg',
    '.gif',
    '.webp',
    '.pdf',
  ])
  for (const ext of BINARY_EXTENSIONS) {
    if (specialized.has(ext)) continue
    const name = `attachment${ext}`
    assert.equal(
      clientAttachmentKind({ name, type: '' }),
      'binary',
      `${name} must match server binary classification`,
    )
  }
  // Browsers mislabel csv as ms-excel; the extension must win.
  assert.equal(
    attachmentMediaType('sales.csv', 'application/vnd.ms-excel'),
    'text/csv',
  )
  assert.throws(() => assertAttachmentSize('image', 64 * 1024 * 1024))
  console.log('[ok] classification + limits')

  // ── delimited parsing ─────────────────────────────────
  assert.deepEqual(splitDelimitedLine('a,"b,c",d', ','), ['a', 'b,c', 'd'])
  assert.deepEqual(splitDelimitedLine('a,"say ""hi""",c', ','), [
    'a',
    'say "hi"',
    'c',
  ])

  // ── save + claim-check round trip ─────────────────────
  const csvRows = ['id,name,amount,created_at']
  for (let i = 1; i <= 500; i++) {
    csvRows.push(
      `${i},cust-${i},${(i * 1.5).toFixed(2)},2026-01-${(i % 28) + 1}`,
    )
  }
  const csv = await saveChatAttachment(
    SESSION_ID,
    Buffer.from(csvRows.join('\n'), 'utf-8'),
    { originalName: '季度 报表.csv', mediaType: 'application/vnd.ms-excel' },
  )
  assert.equal(csv.kind, 'text')
  assert.equal(csv.mediaType, 'text/csv')
  assert.equal(csv.originalName, '季度 报表.csv')
  assert.ok(fs.existsSync(csv.absPath), 'bytes must land on disk')
  assert.ok(
    parseChatUploadRef(csv.url),
    'sanitized name must survive the URL allowlist',
  )
  console.log('[ok] unicode filename sanitized into a valid upload ref')

  const summary = summarizeDelimitedFile(csv.absPath)
  assert.ok(summary)
  assert.equal(summary.rowCount, 500)
  assert.deepEqual(
    summary.columns.map(c => c.name),
    ['id', 'name', 'amount', 'created_at'],
  )
  assert.equal(summary.columns[0]!.type, 'integer')
  assert.equal(summary.columns[1]!.type, 'string')
  assert.equal(summary.columns[2]!.type, 'number')

  // A short, untruncated file must keep its last row: dropping it left every
  // column typed `empty` for the header+1-row reports users actually attach.
  const tiny = await saveChatAttachment(
    SESSION_ID,
    Buffer.from('name,amount\nhotel,123\n', 'utf-8'),
    { originalName: 'tiny.csv' },
  )
  const tinySummary = summarizeDelimitedFile(tiny.absPath)
  assert.ok(tinySummary)
  assert.equal(tinySummary.rowCount, 1)
  assert.equal(tinySummary.sampledRows, 1)
  assert.equal(tinySummary.columns[0]!.type, 'string')
  assert.equal(tinySummary.columns[0]!.sample, 'hotel')
  assert.equal(tinySummary.columns[1]!.type, 'integer')

  // Last line without a trailing newline still counts as a row.
  const noEol = await saveChatAttachment(
    SESSION_ID,
    Buffer.from('name,amount\nhotel,123\ntaxi,45', 'utf-8'),
    { originalName: 'no-eol.csv' },
  )
  const noEolSummary = summarizeDelimitedFile(noEol.absPath)
  assert.ok(noEolSummary)
  assert.equal(noEolSummary.rowCount, 2)
  assert.equal(noEolSummary.sampledRows, 2)
  console.log('[ok] csv shape summary')

  const txt = await saveChatAttachment(
    SESSION_ID,
    Buffer.from('hello\nworld\n', 'utf-8'),
    { originalName: 'notes.md' },
  )
  const docx = await saveChatAttachment(
    SESSION_ID,
    Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01, 0x02]),
    { originalName: 'spec.docx' },
  )
  // A .txt holding binary must be caught by the content sniff, not trusted.
  const fakeText = await saveChatAttachment(
    SESSION_ID,
    Buffer.from([0x00, 0x01, 0x02, 0x00, 0x03, 0x04, 0x00]),
    { originalName: 'payload.txt' },
  )

  // ── dispatch ──────────────────────────────────────────
  const provider = stubProvider({
    supportsNativePdf: () => false,
    supportsImageInput: () => true,
  })
  await assert.rejects(
    () =>
      resolveChatAttachments(
        Array.from({ length: 11 }, () => ({
          url: csv.url,
          filename: csv.originalName,
          mediaType: csv.mediaType,
        })),
        { sessionId: SESSION_ID, provider },
      ),
    /Too many attachments/,
  )
  const resolved = await resolveChatAttachments(
    [
      { url: csv.url, filename: csv.originalName, mediaType: csv.mediaType },
      { url: txt.url, filename: txt.originalName, mediaType: txt.mediaType },
      { url: docx.url, filename: docx.originalName, mediaType: docx.mediaType },
      {
        url: fakeText.url,
        filename: fakeText.originalName,
        mediaType: fakeText.mediaType,
      },
      { url: '/sessions/other/uploads/nope.csv', filename: 'nope.csv' },
    ],
    { sessionId: SESSION_ID, provider },
  )

  assert.equal(resolved.imageRefs.length, 0)
  assert.equal(
    resolved.preludeMessages.length,
    4,
    'one message per readable attachment',
  )
  assert.deepEqual(
    resolved.files.map(file => file.name),
    ['季度 报表.csv', 'notes.md', 'spec.docx', 'payload.txt'],
  )
  assert.ok(
    resolved.warnings.some(w => w.includes('nope.csv')),
    'a ref outside this session must warn, not throw',
  )

  const text = renderedText(resolved.preludeMessages)
  assert.ok(text.includes('季度 报表.csv'), 'csv keeps its original name')
  assert.ok(text.includes('500 data rows'), 'csv summary reaches the model')
  assert.ok(text.includes('id,name,amount'), 'csv preview reaches the model')
  assert.ok(text.includes('hello'), 'text attachment content reaches the model')
  assert.ok(
    text.includes('spec.docx') && text.includes('Bash'),
    'office files are handed to the shell, not inlined',
  )
  assert.ok(
    !text.includes('\\u0000'),
    'binary bytes must never be inlined as text',
  )
  assert.ok(
    text.includes('payload.txt') && text.includes('Bash'),
    'mislabelled .txt is downgraded to a binary note',
  )
  const ui = sessionToUIMessages([
    { role: 'user', content: 'inspect these files', files: resolved.files },
  ]) as Array<{ type: string; files?: unknown[] }>
  assert.equal(ui[0]?.files?.length, 4, 'session UI must preserve file chips')

  const expandedSkillMessage = buildUserMessage(
    'Base directory for this skill: /tmp/demo\n\nFull private skill body',
    undefined,
    false,
    undefined,
    '/demo-skill do the task',
  )
  const skillUi = sessionToUIMessages([expandedSkillMessage]) as Array<{
    type: string
    content?: string
  }>
  assert.equal(
    skillUi[0]?.content,
    '/demo-skill do the task',
    'session reload must show the original slash invocation, not expanded skill body',
  )
  const legacySkillUi = sessionToUIMessages([
    {
      role: 'user',
      content:
        'Base directory for this skill: /workspace/.ai-agent/skills/demo-skill\n\nPrivate body\n\n---\n\nUser request: do the task',
    },
  ]) as Array<{ type: string; content?: string }>
  assert.equal(
    legacySkillUi[0]?.content,
    '/demo-skill do the task',
    'legacy expanded skill turns should recover a compact slash invocation',
  )
  const bubbles = messagesToBubbles(ui)
  const restored = bubbles.bubblesById[bubbles.bubbleOrder[0]!] as {
    files?: unknown[]
  }
  assert.equal(
    restored.files?.length,
    4,
    'bubble hydration must restore file chips',
  )
  console.log('[ok] dispatch: csv / text / office / mislabelled binary')

  // ── vision gate ───────────────────────────────────────
  const png = await saveChatAttachment(
    SESSION_ID,
    Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489',
      'hex',
    ),
    { originalName: 'shot.png' },
  )
  const withVision = await resolveChatAttachments(
    [{ url: png.url, filename: 'shot.png', mediaType: 'image/png' }],
    { sessionId: SESSION_ID, provider },
  )
  assert.deepEqual(withVision.imageRefs, [png.url])
  assert.equal(withVision.preludeMessages.length, 0)

  const noVision = await resolveChatAttachments(
    [{ url: png.url, filename: 'shot.png', mediaType: 'image/png' }],
    {
      sessionId: SESSION_ID,
      provider: stubProvider({
        supportsNativePdf: () => false,
        supportsImageInput: () => false,
      }),
    },
  )
  assert.equal(noVision.imageRefs.length, 0, 'text-only model gets no images')
  assert.ok(noVision.warnings.some(w => w.includes('shot.png')))
  assert.ok(
    renderedText(noVision.preludeMessages).includes('cannot see images'),
  )
  console.log('[ok] vision capability gate')

  // ── pdf ───────────────────────────────────────────────
  const pdf = await saveChatAttachment(SESSION_ID, minimalPdf(), {
    originalName: 'invoice.pdf',
  })
  assert.equal(pdf.kind, 'pdf')

  const nativePdf = await resolveChatAttachments(
    [{ url: pdf.url, filename: 'invoice.pdf', mediaType: 'application/pdf' }],
    {
      sessionId: SESSION_ID,
      provider: stubProvider({
        supportsNativePdf: () => true,
        supportsImageInput: () => true,
      }),
    },
  )
  const filePart = nativePdf.preludeMessages
    .flatMap(m => (Array.isArray((m as any).content) ? (m as any).content : []))
    .find((p: { type?: string }) => p.type === 'file')
  assert.ok(filePart, 'native-PDF providers get a document part')
  assert.equal(filePart.mediaType, 'application/pdf')
  assert.ok(
    typeof filePart.data === 'string' && filePart.data.startsWith('file://'),
    'document bytes stay on disk as a claim-check ref',
  )
  const nativeText = renderedText(nativePdf.preludeMessages)
  const pdfDisk = toModelFilePath(pdf.absPath)
  assert.ok(
    nativeText.includes(pdfDisk),
    'synthetic Read file_path must be the on-disk hash path',
  )
  assert.ok(
    !nativeText.includes(`uploads/${pdf.originalName}`),
    'original filename must not be presented as an uploads path',
  )

  const cjk = await saveChatAttachment(SESSION_ID, minimalPdf(), {
    originalName: '中国移不动.pdf',
  })
  const cjkResolved = await resolveChatAttachments(
    [
      {
        url: cjk.url,
        filename: cjk.originalName,
        mediaType: 'application/pdf',
      },
    ],
    {
      sessionId: SESSION_ID,
      provider: stubProvider({
        supportsNativePdf: () => true,
        supportsImageInput: () => true,
      }),
    },
  )
  const cjkText = renderedText(cjkResolved.preludeMessages)
  const cjkDisk = toModelFilePath(cjk.absPath)
  assert.ok(
    cjkText.includes(cjkDisk),
    'CJK display name still maps to hash path',
  )
  assert.ok(cjkText.includes(cjk.fileName), 'saved hash name is in the prelude')
  assert.ok(
    !cjkText.includes('uploads/中国移不动.pdf'),
    'CJK original name must not be presented as an uploads path',
  )

  const uploadsDir = getChatUploadsDir(SESSION_ID)
  assert.ok(
    uploadsDir.split(path.sep).includes('uploads'),
    'new uploads root is named uploads',
  )
  assert.ok(
    !uploadsDir.split(path.sep).includes('projects'),
    'uploads must not live under projects/',
  )
  assert.ok(
    cjk.absPath.startsWith(uploadsDir),
    'new writes land in the session uploads dir',
  )

  const legacyName = 'bbbbbbbbbbbb-old.pdf'
  const legacyDir = path.join(getSessionDataDir(SESSION_ID), 'uploads')
  fs.mkdirSync(legacyDir, { recursive: true })
  fs.writeFileSync(path.join(legacyDir, legacyName), minimalPdf())
  const legacyAbs = resolveChatAttachmentAbsPath(
    `/sessions/${SESSION_ID}/uploads/${legacyName}`,
    SESSION_ID,
  )
  assert.ok(
    legacyAbs &&
      legacyAbs.replace(/\\/g, '/').endsWith(`uploads/${legacyName}`),
    'readers fall back to the pre-move session-data uploads dir',
  )

  // Non-native providers rasterize; without poppler they fall back to the
  // text layer, and failing that to a note. All three are acceptable here —
  // what must not happen is a thrown turn.
  const fallbackPdf = await resolveChatAttachments(
    [{ url: pdf.url, filename: 'invoice.pdf', mediaType: 'application/pdf' }],
    { sessionId: SESSION_ID, provider },
  )
  assert.ok(fallbackPdf.preludeMessages.length >= 1)
  assert.ok(renderedText(fallbackPdf.preludeMessages).includes('invoice.pdf'))
  console.log('[ok] pdf: native document part + non-native fallback')

  // ── SSH / cloud: copy into the environment where the shell runs ──
  assert.equal(createShellAttachmentStager(undefined, SESSION_ID), undefined)
  assert.equal(
    createShellAttachmentStager(
      { environmentId: 'local', cwd: agentHome },
      SESSION_ID,
    ),
    undefined,
    'local turns share the host disk and need no copy',
  )
  const appDir = getAppDirName()
  assert.equal(
    environmentUploadsDir('cloud:e8068665c61c6cfe', SESSION_ID),
    `/workspace/${appDir}/uploads/${SESSION_ID}`,
    'cloud uploads must live on the persistent volume',
  )
  assert.equal(
    environmentUploadsDir('ssh:dev', SESSION_ID),
    `~/${appDir}/uploads/${SESSION_ID}`,
  )

  const remoteRoot = `/home/dev/${appDir}/uploads/${SESSION_ID}`
  const written = new Map<string, Buffer>()
  const modes = new Set<number | undefined>()
  const made: string[] = []
  const scripts: string[] = []
  const fakePort = Object.assign(Object.create(ShellFsPort.prototype), {
    mkdir: async (dir: string) => {
      made.push(dir)
    },
    run: async (script: string) => {
      scripts.push(script)
      return { stdout: Buffer.alloc(0), stderr: '', code: 0 }
    },
    realpath: async () => remoteRoot,
    writeFileAtomic: async (
      dest: string,
      data: NodeJS.ReadableStream,
      opts: { mode?: number } = {},
    ) => {
      const chunks: Buffer[] = []
      for await (const chunk of data) chunks.push(Buffer.from(chunk))
      written.set(dest, Buffer.concat(chunks))
      modes.add(opts.mode)
    },
  }) as ShellFsPort
  let opened = 0
  const sshStager = createShellAttachmentStager(
    { environmentId: 'ssh:dev', cwd: '/home/dev/repo' },
    SESSION_ID,
    {
      openFs: async () => {
        opened++
        return fakePort
      },
    },
  )
  assert.ok(sshStager)

  const remote = await resolveChatAttachments(
    [
      { url: docx.url, filename: docx.originalName, mediaType: docx.mediaType },
      { url: csv.url, filename: csv.originalName, mediaType: csv.mediaType },
    ],
    { sessionId: SESSION_ID, provider, stageForShell: sshStager },
  )
  assert.equal(opened, 1, 'one connection + mkdir per turn, not per file')
  assert.deepEqual(made, [`~/${appDir}/uploads/${SESSION_ID}`])
  assert.deepEqual(
    scripts,
    [`chmod 700 "$HOME"/'${appDir}/uploads/${SESSION_ID}'`],
    'the per-session uploads dir is private to the remote user',
  )
  assert.deepEqual(
    [...modes],
    [0o600],
    'staged copies are readable only by the remote user',
  )
  const remoteDocx = `${remoteRoot}/${docx.fileName}`
  const remoteCsv = `${remoteRoot}/${csv.fileName}`
  assert.deepEqual(
    written.get(remoteDocx),
    fs.readFileSync(docx.absPath),
    'bytes reach the remote copy unchanged',
  )
  assert.ok(written.has(remoteCsv), 'text attachments are copied too')
  const remoteText = renderedText(remote.preludeMessages)
  assert.ok(
    remoteText.includes(`The file is saved at ${remoteDocx}`),
    'binary attachment points the shell at the remote copy',
  )
  assert.ok(
    !remoteText.includes(
      `The file is saved at ${toModelFilePath(docx.absPath)}`,
    ),
    'binary attachment must not point the shell at the host path',
  )
  assert.ok(
    remoteText.includes(`Full file on disk: ${remoteCsv}`),
    'tabular summary points processing at the remote copy',
  )
  assert.ok(
    remoteText.includes(
      `Use ${toModelFilePath(csv.absPath)} only with ${FILE_READ_TOOL_NAME}`,
    ),
    'Read keeps the host path, which it can serve in every environment',
  )

  const failing = await resolveChatAttachments(
    [{ url: docx.url, filename: docx.originalName, mediaType: docx.mediaType }],
    {
      sessionId: SESSION_ID,
      provider,
      stageForShell: async () => {
        throw new Error('container is not running')
      },
    },
  )
  const failingText = renderedText(failing.preludeMessages)
  assert.ok(failingText.includes('could not be copied into the workspace'))
  assert.ok(failingText.includes('container is not running'))
  assert.ok(
    failing.warnings.some(w => w.includes('copy into the workspace failed')),
  )
  console.log('[ok] ssh/cloud: attachments copied where the shell runs')
} finally {
  clearSessionLocationCache()
  fs.rmSync(agentHome, { recursive: true, force: true })
}

console.log('[PASS] chat attachments')
