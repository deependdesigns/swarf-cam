import { createContext, useContext } from 'react'

export const AppStateContext = createContext(null)

export function useAppState() {
  const ctx = useContext(AppStateContext)
  if (!ctx) throw new Error('useAppState must be used inside AppStateContext.Provider')
  return ctx
}
