import { useCallback, useEffect, useMemo, useState } from 'react'
import { useCapabilitiesStore } from '../../stores/capabilities-store.js'
import { useWorkspaceContextStore } from '../../stores/workspace-context-store.js'
import MarkdownResourcesSection from './MarkdownResourcesSection.jsx'
import MarketplaceSection from './MarketplaceSection.jsx'
import McpSection from './McpSection.jsx'
import ModalShell from './ModalShell.jsx'
import SectionNavigation from './SectionNavigation.jsx'
import SkillsSection from './SkillsSection.jsx'
import { LspSection, PluginsSection } from './StatusSections.jsx'
import {
  AgentsIcon,
  CommandsIcon,
  HubIcon,
  LspIcon,
  MarketplaceIcon,
  McpIcon,
  PluginsIcon,
  RulesIcon,
  SkillsIcon,
} from './icons.jsx'
import {
  createScopedExtensionConfigClient,
  enabledExtensionSections,
  enabledMcpTransports,
  extensionDisabledReason,
  extensionRuntimeLabel,
  extensionScopeOptions,
  isConfigExtensionSection,
} from './extensions-capabilities.js'

function AgentsSection(props) {
  return <MarkdownResourcesSection {...props} type='agents' />
}

function RulesSection(props) {
  return <MarkdownResourcesSection {...props} type='rules' />
}

function CommandsSection(props) {
  return <MarkdownResourcesSection {...props} type='commands' />
}

export const DEFAULT_EXTENSION_SECTIONS = [
  {
    id: 'skills',
    label: 'Skills',
    icon: SkillsIcon,
    component: SkillsSection,
  },
  {
    id: 'agents',
    label: 'Agents',
    icon: AgentsIcon,
    component: AgentsSection,
  },
  {
    id: 'rules',
    label: 'Rules',
    icon: RulesIcon,
    component: RulesSection,
  },
  {
    id: 'commands',
    label: 'Commands',
    icon: CommandsIcon,
    component: CommandsSection,
  },
  {
    id: 'mcp',
    label: 'MCP',
    icon: McpIcon,
    component: McpSection,
  },
  {
    id: 'lsp',
    label: 'LSP',
    icon: LspIcon,
    component: LspSection,
  },
  {
    id: 'marketplace',
    label: 'Marketplace',
    icon: MarketplaceIcon,
    component: MarketplaceSection,
  },
  {
    id: 'plugins',
    label: 'Plugins',
    icon: PluginsIcon,
    component: PluginsSection,
  },
]

export default function ExtensionsHub({
  open,
  onClose,
  sections = DEFAULT_EXTENSION_SECTIONS,
  initialSection = 'skills',
  manifest: manifestOverride,
  capabilitiesLoaded: capabilitiesLoadedOverride,
  workspaceContext,
  configClientFactory,
}) {
  const storeLoaded = useCapabilitiesStore(state => state.loaded)
  const storeManifest = useCapabilitiesStore(state => state.manifest)
  const storeHandle = useWorkspaceContextStore(state => state.handle)
  const storeWorkspaceLabel = useWorkspaceContextStore(
    state => state.label || state.cwd,
  )
  const manifest = manifestOverride || storeManifest
  const capabilitiesLoaded = capabilitiesLoadedOverride ?? storeLoaded
  const workspaceHandle = workspaceContext?.handle ?? storeHandle
  const workspaceLabel =
    workspaceContext?.label ??
    workspaceContext?.cwd ??
    storeWorkspaceLabel ??
    null
  const [activeId, setActiveId] = useState(initialSection)
  const [scope, setScope] = useState(manifest.extensions.scopes[0] || 'user')
  const [refreshToken, setRefreshToken] = useState(0)
  const [dirty, setDirty] = useState(false)

  const confirmDiscard = useCallback(() => {
    return (
      !dirty ||
      window.confirm(
        'You have unsaved extension changes. Discard them and continue?',
      )
    )
  }, [dirty])

  const closeHub = useCallback(() => {
    if (!confirmDiscard()) return
    setDirty(false)
    onClose?.()
  }, [confirmDiscard, onClose])

  const selectSection = useCallback(
    id => {
      if (id === activeId || !confirmDiscard()) return
      setDirty(false)
      setActiveId(id)
    },
    [activeId, confirmDiscard],
  )

  const selectScope = useCallback(
    nextScope => {
      if (nextScope === scope || !confirmDiscard()) return
      setDirty(false)
      setScope(nextScope)
    },
    [confirmDiscard, scope],
  )

  const availableSections = useMemo(
    () => enabledExtensionSections(sections, manifest),
    [manifest, sections],
  )
  const scopeOptions = useMemo(
    () => extensionScopeOptions(manifest, workspaceHandle),
    [manifest, workspaceHandle],
  )
  const scopedConfig = useMemo(
    () =>
      createScopedExtensionConfigClient(
        manifest,
        scope,
        workspaceHandle,
        configClientFactory,
      ),
    [configClientFactory, manifest, scope, workspaceHandle],
  )
  const transports = useMemo(() => enabledMcpTransports(manifest), [manifest])
  const active =
    availableSections.find(section => section.id === activeId) ||
    availableSections[0] ||
    null

  useEffect(() => {
    if (open && !availableSections.some(section => section.id === activeId)) {
      setDirty(false)
      setActiveId(availableSections[0]?.id || '')
    }
  }, [activeId, availableSections, open])

  useEffect(() => {
    if (!manifest.extensions.scopes.includes(scope)) {
      setDirty(false)
      setScope(manifest.extensions.scopes[0] || 'user')
    }
  }, [manifest, scope])

  useEffect(() => {
    if (!open) setDirty(false)
  }, [open])

  const subtitle = useMemo(() => {
    return workspaceLabel
      ? `Configure reusable AI tools for ${workspaceLabel}`
      : 'Configure reusable AI tools.'
  }, [workspaceLabel])

  const ActiveComponent = active?.component
  const configUnavailable =
    active && isConfigExtensionSection(active.id) && !scopedConfig.enabled
  const disabledReason = extensionDisabledReason(manifest)
  const noSectionsReason =
    disabledReason || 'No extension sections are enabled by the server.'

  return (
    <ModalShell
      open={open}
      onClose={closeHub}
      title={
        <span className='extensions-hub-title'>
          <HubIcon aria-hidden='true' />
          AI Extensions
        </span>
      }
      subtitle={subtitle}
      className='extensions-hub'
      size='hub'
      headerActions={
        <>
          {scopeOptions.length > 1 ? (
            <div
              className='extensions-scope-selector'
              role='group'
              aria-label='Extension configuration and Marketplace target scope'
              title='Applies to Skills, Agents, Rules, Commands, and Marketplace'
            >
              {scopeOptions.map(option => (
                <button
                  key={option.id}
                  type='button'
                  className={scope === option.id ? 'is-active' : ''}
                  disabled={!option.enabled}
                  title={option.reason || `${option.label} configuration scope`}
                  aria-pressed={scope === option.id}
                  onClick={() => selectScope(option.id)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          ) : (
            scopeOptions[0] && (
              <span
                className='extensions-scope-label'
                title={
                  scopeOptions[0].reason ||
                  `${scopeOptions[0].label} configuration scope`
                }
              >
                {scopeOptions[0].label} scope
              </span>
            )
          )}
          <span
            className='extensions-runtime-pill'
            title={`${extensionRuntimeLabel(manifest.profile)} runtime profile${
              disabledReason ? ` · ${disabledReason}` : ''
            }`}
          >
            <span aria-hidden='true' />
            {extensionRuntimeLabel(manifest.profile)}
          </span>
        </>
      }
    >
      {!capabilitiesLoaded ? (
        <div className='extensions-blank-state'>
          <span className='spinner' aria-hidden='true' />
          <p>Loading extension capabilities…</p>
        </div>
      ) : availableSections.length === 0 ? (
        <div className='extensions-blank-state'>
          <span className='extensions-blank-state__mark'>◇</span>
          <h3>AI Extensions are unavailable</h3>
          <p title={noSectionsReason}>{noSectionsReason}</p>
        </div>
      ) : (
        <div className='extensions-hub__layout'>
          <SectionNavigation
            sections={availableSections}
            activeId={active?.id}
            onSelect={selectSection}
          />
          {active && ActiveComponent && (
            <main
              id={`extensions-section-${active.id}`}
              className='extensions-hub__content thin-scrollbar'
              role='tabpanel'
              tabIndex={0}
              aria-labelledby={`extensions-tab-${active.id}`}
            >
              {configUnavailable ? (
                <div className='extensions-blank-state'>
                  <span className='extensions-blank-state__mark'>◇</span>
                  <h3>
                    {scope === 'workspace' ? 'Workspace' : 'User'} scope
                    unavailable
                  </h3>
                  <p title={scopedConfig.reason}>{scopedConfig.reason}</p>
                </div>
              ) : (
                <ActiveComponent
                  key={`${active.id}:${scope}:${
                    workspaceHandle?.environmentId || ''
                  }:${workspaceHandle?.cwd || ''}`}
                  workspace={workspaceHandle?.cwd}
                  workspaceHandle={workspaceHandle}
                  scope={scope}
                  configClient={scopedConfig.client}
                  capability={
                    active.id === 'mcp'
                      ? manifest.mcp
                      : active.id === 'marketplace'
                        ? manifest.marketplace
                        : manifest.extensions.sections[active.id]
                  }
                  transports={active.id === 'mcp' ? transports : undefined}
                  refreshToken={refreshToken}
                  onDirtyChange={setDirty}
                  onResourcesChanged={() => setRefreshToken(token => token + 1)}
                />
              )}
            </main>
          )}
        </div>
      )}
    </ModalShell>
  )
}
