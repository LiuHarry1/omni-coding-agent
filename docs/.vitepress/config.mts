import { defineConfig } from 'vitepress'
import { withMermaid } from 'vitepress-plugin-mermaid'

export default withMermaid(defineConfig({
  title: 'Coding Agent',
  description: 'Visual guides to Coding Agent usage, architecture, and extension points',
  lang: 'en-US',
  cleanUrls: true,
  lastUpdated: true,
  ignoreDeadLinks: true,
  srcExclude: ['to_be_delete/**'],
  themeConfig: {
    nav: [
      { text: 'Get started', link: '/readme/getting-started' },
      { text: 'Architecture', link: '/architecture/' },
      { text: 'Features', link: '/features/' },
    ],
    sidebar: {
      '/readme/': [
        {
          text: 'Get started',
          items: [
            { text: 'Quick start', link: '/readme/getting-started' },
            { text: 'Browser automation', link: '/readme/browser' },
            { text: 'Local development', link: '/readme/development' },
            { text: 'VS Code / Cursor', link: '/readme/integrations/vscode-acp' },
            { text: 'IntelliJ IDEA', link: '/readme/integrations/intellij-acp' },
          ],
        },
      ],
      '/architecture/': [
        {
          text: 'Core architecture',
          items: [
            { text: 'System overview', link: '/architecture/' },
            { text: 'Turn and agent loop', link: '/architecture/agent-loop' },
            { text: 'Tool system', link: '/architecture/tools' },
            { text: 'Memory and context', link: '/architecture/memory' },
            { text: 'Protocol and clients', link: '/architecture/protocol' },
            { text: 'Durable runs', link: '/architecture/durable-runs' },
            { text: 'Execution plane', link: '/architecture/execution' },
            { text: 'Extension system', link: '/architecture/extensions' },
            { text: 'Browser Automation', link: '/architecture/browser' },
          ],
        },
      ],
      '/features/': [
        {
          text: 'Feature guides',
          items: [
            { text: 'Feature overview', link: '/features/' },
            { text: 'Scheduled Tasks', link: '/features/scheduled-tasks' },
            { text: 'Permissions and HITL', link: '/features/permissions' },
            { text: 'Attachments and @ mentions', link: '/features/attachments' },
            { text: 'Primary Agents', link: '/features/primary-agents' },
            { text: 'Slash Commands', link: '/features/slash-commands' },
            { text: 'Background tasks', link: '/features/background-tasks' },
            { text: 'LSP', link: '/features/lsp' },
            { text: 'Large tool outputs', link: '/features/tool-storage' },
          ],
        },
      ],
    },
    socialLinks: [],
    search: { provider: 'local' },
    outline: { level: [2, 3], label: 'On this page' },
    docFooter: { prev: 'Previous', next: 'Next' },
    lastUpdated: { text: 'Last updated' },
    footer: {
      message: 'Coding Agent documentation',
      copyright: 'The repository implementation is the source of truth',
    },
  },
  markdown: {
    theme: { light: 'github-light', dark: 'github-dark' },
  },
  mermaid: {
    theme: 'default',
  },
}))
