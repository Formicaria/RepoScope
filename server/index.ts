import { createApp } from './app.js'

const PORT = Number(process.env.PORT ?? 8787)

createApp().listen(PORT, () => {
  console.log(`reposcope api listening on http://localhost:${PORT}`)
})
