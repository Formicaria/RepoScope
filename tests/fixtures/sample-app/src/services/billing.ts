import Stripe from 'stripe'
import { UserService } from './userService'

const stripe = new Stripe('sk_test_placeholder')
export async function charge(data: { name: string }) {
  void UserService
  return stripe.charges.create({ amount: 100 })
}
