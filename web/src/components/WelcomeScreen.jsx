import { useChatStore } from '../stores/chat-store.js'
import BaizeLogo from './BaizeLogo.jsx'
import { APP_NAME, APP_TAGLINE } from '../lib/brand.js'

function WelcomeIcon({ name }) {
  let content
  switch (name) {
    case 'explore':
      content = (
        <>
          <circle cx='10.5' cy='10.5' r='6.5' />
          <path d='m16 16 4.5 4.5' />
        </>
      )
      break
    case 'bug':
      content = (
        <>
          <rect x='7.5' y='7' width='9' height='12' rx='4.5' />
          <path d='M12 3v4M8.5 5.5l2 2M15.5 5.5l-2 2M3 11h4.5M16.5 11H21M3 16h4.5M16.5 16H21' />
        </>
      )
      break
    case 'improve':
      content = (
        <>
          <path d='m4 20 4.5-1 10-10a2.1 2.1 0 0 0-3-3l-10 10L4 20Z' />
          <path d='m13.5 7.5 3 3M5.5 15.5l3 3M7 4v3M5.5 5.5h3M18 16v4M16 18h4' />
        </>
      )
      break
    case 'snake':
      content = (
        <>
          <path d='M5 6h9a4 4 0 0 1 0 8H9a3 3 0 0 0 0 6h8' />
          <circle cx='18.5' cy='6' r='1.5' />
          <path d='M20 6h2' />
        </>
      )
      break
    case 'flappy':
      content = (
        <>
          <path d='M3 13c4-5 8-6 12-2l5-1-3 4c-1 4-5 6-9 5-3-.8-5-3-5-6Z' />
          <path d='M8 12c2 0 4 1 5 3M15 11h.01' />
        </>
      )
      break
    case 'tetris':
      content = (
        <>
          <rect x='4' y='4' width='6' height='6' rx='1' />
          <rect x='10' y='4' width='6' height='6' rx='1' />
          <rect x='10' y='10' width='6' height='6' rx='1' />
          <rect x='16' y='10' width='4' height='6' rx='1' />
          <rect x='10' y='16' width='6' height='4' rx='1' />
        </>
      )
      break
    case 'pong':
      content = (
        <>
          <rect x='3' y='6' width='3' height='12' rx='1.5' />
          <rect x='18' y='4' width='3' height='12' rx='1.5' />
          <circle cx='12' cy='12' r='2' />
          <path d='M9 12H7M17 10h-2' />
        </>
      )
      break
    case 'grid':
      content = (
        <>
          <rect x='4' y='4' width='7' height='7' rx='1.5' />
          <rect x='13' y='4' width='7' height='7' rx='1.5' />
          <rect x='4' y='13' width='7' height='7' rx='1.5' />
          <rect x='13' y='13' width='7' height='7' rx='1.5' />
        </>
      )
      break
    default:
      content = (
        <>
          <path d='M21 15a3 3 0 0 1-3 3H9l-5 3v-6a3 3 0 0 1-1-2V7a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3v8Z' />
          <path d='M8 11h.01M12 11h.01M16 11h.01' />
        </>
      )
  }

  return (
    <svg
      width='18'
      height='18'
      viewBox='0 0 24 24'
      fill='none'
      stroke='currentColor'
      strokeWidth='1.8'
      strokeLinecap='round'
      strokeLinejoin='round'
      aria-hidden='true'
    >
      {content}
    </svg>
  )
}

const TOOL_HINTS = [
  {
    icon: 'explore',
    label: 'Explore project',
    prompt:
      "Read the current directory structure, find the main entry points, and give me a brief summary of this project's architecture",
  },
  {
    icon: 'bug',
    label: 'Fix a bug',
    prompt:
      "I'm getting an error in my code. Let me describe it — help me find the root cause and fix it",
  },
  {
    icon: 'improve',
    label: 'Improve code',
    prompt:
      'Read the main source files in this project and suggest refactoring improvements for better readability and maintainability',
  },
]

const PROJECT_HINTS = [
  {
    icon: 'snake',
    label: 'Snake',
    prompt:
      'Create a Snake game using a single HTML file with embedded CSS and JavaScript. Include: canvas-based rendering, arrow key controls, score display, speed increase per 5 points, game over screen with restart button, and a modern dark-themed UI. Make it immediately playable by opening the HTML file.',
  },
  {
    icon: 'flappy',
    label: 'Flappy Bird',
    prompt:
      'Create a Flappy Bird clone using a single HTML file with embedded CSS and JavaScript. Include: canvas rendering, click/space to flap, randomly generated pipes, score counter, gravity physics, collision detection, game over with restart, and pixel-art style visuals. Make it immediately playable.',
  },
  {
    icon: 'tetris',
    label: 'Tetris',
    prompt:
      'Create a Tetris game in a single HTML file with embedded CSS and JavaScript. Include: all 7 tetromino shapes with colors, rotation, soft/hard drop, line clearing with animation, score and level system, next piece preview, and keyboard controls (arrows + up to rotate). Modern neon-style dark UI.',
  },
  {
    icon: 'pong',
    label: 'Pong',
    prompt:
      'Create a Pong game using a single HTML file with embedded CSS and JavaScript. Include: canvas-based rendering, two paddles (W/S vs arrow keys), ball physics with angle-based bounces, score tracking to 10, serve after each point, and a retro arcade dark UI. Make it immediately playable by opening the HTML file.',
  },
  {
    icon: 'grid',
    label: '2048',
    prompt:
      'Create a 2048 puzzle game using a single HTML file with embedded CSS and JavaScript. Include: 4x4 grid, arrow key controls, tile merge animation, score and best score (localStorage), win at 2048 with continue option, and game over detection. Clean modern UI with colored tiles.',
  },
  {
    icon: 'chat',
    label: 'Chatbot',
    prompt:
      "Create a chatbot web app using a single HTML file with embedded CSS and JavaScript. Connect to an OpenAI-compatible API at base URL http://localhost:4141/v1 with apiKey 'dummy' and model 'gpt-4'. Include: chat message history, user input with send button, Enter to send, loading indicator while waiting, markdown rendering for assistant replies, and clear error messages on API failure. Make it immediately usable by opening the HTML file.",
  },
]

export default function WelcomeScreen() {
  const sendMessage = useChatStore(s => s.sendMessage)

  return (
    <div className='welcome'>
      <BaizeLogo size='lg' />
      <h2 className='welcome-title'>{APP_NAME}</h2>
      <p className='welcome-subtitle'>{APP_TAGLINE}</p>
      <p className='welcome-desc'>
        Build in the cloud and preview complete projects in your browser.
      </p>

      <div className='hint-section'>
        <span className='hint-section-label'>Work with your code</span>
        <div className='hint-grid hint-grid--3col'>
          {TOOL_HINTS.map((h, i) => (
            <button
              key={i}
              className='hint-card hint-card--compact'
              onClick={() => sendMessage(h.prompt)}
            >
              <span className='hint-icon'>
                <WelcomeIcon name={h.icon} />
              </span>
              <span className='hint-label'>{h.label}</span>
            </button>
          ))}
        </div>
      </div>

      <div className='hint-section'>
        <span className='hint-section-label'>Start from a template</span>
        <div className='hint-grid hint-grid--3col'>
          {PROJECT_HINTS.map((h, i) => (
            <button
              key={i}
              className='hint-card hint-card--compact'
              onClick={() => sendMessage(h.prompt)}
            >
              <span className='hint-icon'>
                <WelcomeIcon name={h.icon} />
              </span>
              <span className='hint-label'>{h.label}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
