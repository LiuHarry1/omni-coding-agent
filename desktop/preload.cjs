const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('desktop', {
  isDesktop: true,
  pickWorkspace: () => ipcRenderer.invoke('pick-workspace'),
  getAgentUrl: () => ipcRenderer.invoke('get-agent-url'),
  factoryReset: confirmation =>
    ipcRenderer.invoke('factory-reset', confirmation),
})
