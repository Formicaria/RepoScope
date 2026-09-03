import express from 'express'
import { router } from './routes/users'
import { logger } from './utils/logger'

const app = express()
app.use('/api', router)
app.listen(process.env.PORT ?? 3000, () => logger.info('up'))
