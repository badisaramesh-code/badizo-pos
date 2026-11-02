import axios from 'axios';
import { checkout, fetchInvoiceDetails } from './client';

jest.mock('axios', () => ({ create: jest.fn(() => ({
  post: jest.fn(), get: jest.fn(),
  interceptors: { request: { use: jest.fn() }, response: { use: jest.fn() } }
})) }));
const api = axios.create.mock.results[0].value;
beforeEach(() => { api.post.mockReset(); api.get.mockReset(); });

test('retries a timed-out checkout with exactly the same request ID and payload', async () => {
  const payload = { checkout_request_id: 'checkout-test-123', items: [{ barcode: '1', quantity: 1 }] };
  api.post.mockRejectedValueOnce({ code: 'ECONNABORTED' }).mockResolvedValueOnce({ data: { invoice_no: 'SAVED' } });
  expect(await checkout(payload)).toEqual({ invoice_no: 'SAVED' });
  expect(api.post).toHaveBeenCalledTimes(2);
  expect(api.post.mock.calls[0][1]).toBe(payload);
  expect(api.post.mock.calls[1][1]).toBe(payload);
});

test('never automatically retries an uncertain checkout without an idempotency ID', async () => {
  const error = { code: 'ECONNABORTED' };
  api.post.mockRejectedValue(error);
  await expect(checkout({ items: [] })).rejects.toBe(error);
  expect(api.post).toHaveBeenCalledTimes(1);
});

test('does not retry a confirmed price rejection', async () => {
  const error = { response: { status: 409, data: { code: 'PRICE_CHANGED' } } };
  api.post.mockRejectedValue(error);
  await expect(checkout({ checkout_request_id: 'checkout-test-123' })).rejects.toBe(error);
  expect(api.post).toHaveBeenCalledTimes(1);
});

test('recovery lookup opts out of global GET retries, ordinary history retains retries', async () => {
  api.get.mockResolvedValue({ data: {} });
  await fetchInvoiceDetails('', { checkoutRequestId: 'checkout-test-123', timeoutMs: 8000, noRetry: true });
  expect(api.get.mock.calls[0][1]).toMatchObject({ timeout: 8000, __badizoNoRetry: true, params: { checkout_request_id: 'checkout-test-123' } });
  await fetchInvoiceDetails('INVOICE1');
  expect(api.get.mock.calls[1][1].__badizoNoRetry).toBe(false);
});
