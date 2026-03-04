import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Authenticator } from '@aws-amplify/ui-react'
import { configureAuth } from './auth/config'
import './i18n/config' // Initialize i18n before rendering
import './index.css'
import App from './App.tsx'

configureAuth().then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <Authenticator.Provider>
        <App />
      </Authenticator.Provider>
    </StrictMode>,
  )
})
