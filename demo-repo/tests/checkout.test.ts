import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkout } from '../src/checkout.ts';

test('a valid checkout retains its user', () => {
  assert.deepEqual(checkout({ user: { id: 'user-1' } }), { status: 200, userId: 'user-1' });
});
test('an expired session with a user is rejected', () => {
  assert.equal(checkout({ expired: true, user: { id: 'user-1' } }).status, 401);
});
