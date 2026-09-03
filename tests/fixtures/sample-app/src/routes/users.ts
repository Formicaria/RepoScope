import { Router } from 'express'
import { UserService } from '../services/userService'

export const router = Router()
router.get('/users', async (_req, res) => res.json(await UserService.list()))
router.post('/users', async (req, res) => res.json(await UserService.create(req.body)))
