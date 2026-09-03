import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import ClawhiveLoginGate from './ClawhiveLoginGate'
import { installFetchAuth, isLoggedIn } from './clawhiveAuth'
import '@brand/index.css'
import './extractor-season.css'
import './styles.css'
import './extractor-theme.css'

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
  return <App onLogout={() => setAuthed(false)} />
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
