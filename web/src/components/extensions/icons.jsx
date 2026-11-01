function Icon({ children, ...props }) {
  return (
    <svg
      width='17'
      height='17'
      viewBox='0 0 24 24'
      fill='none'
      stroke='currentColor'
      strokeWidth='1.8'
      strokeLinecap='round'
      strokeLinejoin='round'
      {...props}
    >
      {children}
    </svg>
  )
}

export function HubIcon(props) {
  return (
    <Icon {...props}>
      <rect x='3' y='3' width='7' height='7' rx='2' />
      <rect x='14' y='3' width='7' height='7' rx='2' />
      <rect x='3' y='14' width='7' height='7' rx='2' />
      <path d='M17.5 14v7M14 17.5h7' />
    </Icon>
  )
}

export function SkillsIcon(props) {
  return (
    <Icon {...props}>
      <path d='M12 2a7 7 0 0 0-4 12.7V18h8v-3.3A7 7 0 0 0 12 2Z' />
      <path d='M9 22h6M9 18h6' />
      <path d='m9.5 10 1.5 1.5 3.5-4' />
    </Icon>
  )
}

export function AgentsIcon(props) {
  return (
    <Icon {...props}>
      <rect x='4' y='7' width='16' height='13' rx='3' />
      <path d='M12 3v4M8 12h.01M16 12h.01M8 17h8' />
    </Icon>
  )
}

export function RulesIcon(props) {
  return (
    <Icon {...props}>
      <path d='M9 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-4' />
      <path d='m9 15 2 2 8-9M9 7h6M7 7h.01' />
    </Icon>
  )
}

export function CommandsIcon(props) {
  return (
    <Icon {...props}>
      <rect x='3' y='4' width='18' height='16' rx='2' />
      <path d='m7 9 3 3-3 3M13 15h4' />
    </Icon>
  )
}

export function PluginsIcon(props) {
  return (
    <Icon {...props}>
      <path d='M8 3v4M16 3v4M5 7h14v3a7 7 0 0 1-7 7v4M9 21h6' />
    </Icon>
  )
}

export function McpIcon(props) {
  return (
    <Icon {...props}>
      <circle cx='6' cy='6' r='3' />
      <circle cx='18' cy='6' r='3' />
      <circle cx='12' cy='18' r='3' />
      <path d='m8.6 7.5 2.2 7.5M15.4 7.5 13.2 15M9 6h6' />
    </Icon>
  )
}

export function LspIcon(props) {
  return (
    <Icon {...props}>
      <path d='m8 9-4 3 4 3M16 9l4 3-4 3M14 5l-4 14' />
    </Icon>
  )
}

export function MarketplaceIcon(props) {
  return (
    <Icon {...props}>
      <path d='M3 9 4.5 4h15L21 9' />
      <path d='M5 13v7h14v-7M9 20v-6h6v6' />
      <path d='M3 9a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0' />
    </Icon>
  )
}

export function LockIcon(props) {
  return (
    <Icon {...props}>
      <rect x='5' y='10' width='14' height='11' rx='2' />
      <path d='M8 10V7a4 4 0 0 1 8 0v3M12 14v3' />
    </Icon>
  )
}
