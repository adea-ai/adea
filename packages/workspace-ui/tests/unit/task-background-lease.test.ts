import { expect, test } from 'bun:test'
import {
  cancelTaskBackgroundLease,
  dropTaskBackgroundLease,
  hasTaskBackgroundLease,
  holdTaskBackgroundLease,
} from '../../src/task-background-lease'

test('the board cancels the lease a closing panel left behind, once', () => {
  let released = 0
  expect(hasTaskBackgroundLease()).toBe(false)
  holdTaskBackgroundLease(() => {
    released += 1
  })
  expect(hasTaskBackgroundLease()).toBe(true)
  cancelTaskBackgroundLease()
  expect(released).toBe(1)
  expect(hasTaskBackgroundLease()).toBe(false)
  cancelTaskBackgroundLease()
  expect(released).toBe(1)
})

const first = () => {}
const second = () => {}

test('dropping a lease only clears it while it is still the active one', () => {
  holdTaskBackgroundLease(first)
  holdTaskBackgroundLease(second)
  dropTaskBackgroundLease(first)
  expect(hasTaskBackgroundLease()).toBe(true)
  dropTaskBackgroundLease(second)
  expect(hasTaskBackgroundLease()).toBe(false)
})
