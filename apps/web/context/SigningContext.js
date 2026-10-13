import React, { createContext, useContext, useState, useCallback } from 'react'

// Holds the human-readable summary of the typed-data signature the app is currently asking
// the wallet to produce (crypto G.1). `begin` is called before the wallet prompt opens and
// `end` after it resolves or rejects, so the summary is visible *while* the prompt is open.
const SigningContext = createContext(null)

export function SigningProvider({ children }) {
  const [summary, setSummary] = useState(null)
  const begin = useCallback((s) => setSummary(s), [])
  const end = useCallback(() => setSummary(null), [])
  return <SigningContext.Provider value={{ summary, begin, end }}>{children}</SigningContext.Provider>
}

export function useSigning() {
  const context = useContext(SigningContext)
  if (!context) {
    throw new Error('useSigning must be used within SigningProvider')
  }
  return context
}
