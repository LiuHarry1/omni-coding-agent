/** Desktop (Electron) bridge exposed via preload. No-op on web. */
export function isDesktop() {
  return Boolean(globalThis.desktop?.isDesktop)
}

export async function pickWorkspaceDir() {
  if (!isDesktop()) return null
  return globalThis.desktop.pickWorkspace()
}

export async function factoryResetDesktop(confirmation) {
  if (!isDesktop()) throw new Error('Factory reset requires the desktop app')
  return globalThis.desktop.factoryReset(confirmation)
}
