import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import { ensureAuth } from './lib/auth.js'
import { APP_NAME } from './lib/brand.js'
import hljsDarkUrl from 'highlight.js/styles/github-dark.min.css?url'
import hljsLightUrl from 'highlight.js/styles/github.min.css?url'
import '@fontsource-variable/inter'
import './styles/index.css'

document.title = APP_NAME

function installHighlightTheme(id, href, disabled) {
  const link = document.createElement('link')
  link.id = id
  link.rel = 'stylesheet'
  link.href = href
  link.disabled = disabled
  document.head.appendChild(link)
}

const initialTheme =
  localStorage.getItem('coding_agent_theme') === 'light' ? 'light' : 'dark'
installHighlightTheme('hljs-dark', hljsDarkUrl, initialTheme === 'light')
installHighlightTheme('hljs-light', hljsLightUrl, initialTheme === 'dark')

// When auth is enabled and there's no valid token, ensureAuth() redirects to
// the SSO login and returns false — we skip rendering to avoid a UI flash.
if (ensureAuth()) {
  createRoot(document.getElementById('root')).render(<App />)
}
