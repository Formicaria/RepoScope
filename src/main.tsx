import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { desktop } from './lib/desktop'
import App from './App'
import './index.css'

// Marks the document so the desktop-only chrome rules in index.css apply. Absent in a
// browser, where the app must not behave as though it owns the window.
if (desktop()) {
  document.documentElement.dataset.desktop = 'true'
  void desktop()
    ?.info()
    .then((info) => {
      // Only Windows overlays the window controls on top of the header, so only Windows
      // needs space reserved for them. macOS insets the traffic lights on the left, and
      // Linux keeps its native decorations.
      if (info.platform === 'win32') {
        document.documentElement.dataset.titlebarInset = 'true'
      }
    })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
