import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import ClawhiveLoginGate from './ClawhiveLoginGate'
import { installFetchAuth, isLoggedIn } from './clawhiveAuth'

installFetchAuth()

function Root() {
  const [ready, setReady] = useState(false)
  const [authed, setAuthed] = useState(false)
  useEffect(() => {
    setAuthed(isLoggedIn())
    setReady(true)
  }, [])
  if (!ready) return null
  if (!authed) return <ClawhiveLoginGate onSuccess={() => setAuthed(true)} />
  return <App />
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
