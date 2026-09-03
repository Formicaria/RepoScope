import { UserModel } from '../models/user'
import { charge } from './billing'
import { logger } from '../utils/logger'

export const UserService = {
  list: () => UserModel.all(),
  create: async (data: { name: string }) => {
    logger.info('creating user')
    await charge(data)
    return UserModel.insert(data)
  },
}
