import { shouldRecoverCheckout } from './checkoutRecovery';

test('reports the existing server price rejection without waiting for recovery', () => {
  expect(shouldRecoverCheckout({ response: { status: 500, data: {
    error: 'Rate updated for GIFFY DISH WASH GEL 1+1: current rate Rs.235.00. Remove this item and scan it again.'
  } } })).toBe(false);
});

test.each([400, 401, 403, 409])('does not recover a rejected checkout (%s)', (status) => {
  expect(shouldRecoverCheckout({ response: { status } })).toBe(false);
});

test.each([
  { code: 'ECONNABORTED' },
  { message: 'Network Error' },
  { response: { status: 408 } },
  { response: { status: 500 } },
  { response: { status: 503 } }
])('checks for a committed invoice when the result is uncertain', (error) => {
  expect(shouldRecoverCheckout(error)).toBe(true);
});
