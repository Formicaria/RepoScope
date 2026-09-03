import { Pool } from 'pg'

const pool = new Pool()
export const UserModel = {
  all: () => pool.query('select * from users'),
  insert: (data: { name: string }) => pool.query('insert into users values ($1)', [data.name]),
}
