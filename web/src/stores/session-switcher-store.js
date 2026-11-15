import { create } from 'zustand'

/**
 * Whether the header's session list is open. It lives here rather than in the
 * switcher because the home page opens it too ("View all").
 */
export const useSessionSwitcherStore = create(set => ({
  open: false,
  setOpen: open => set({ open: Boolean(open) }),
}))
