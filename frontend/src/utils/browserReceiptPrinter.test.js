import { printOnLocalReceiptPrinter } from './browserReceiptPrinter';
import html2canvas from 'html2canvas';

jest.mock('html2canvas', () => jest.fn());

const originalFetch = global.fetch;
const originalTimeout = AbortSignal.timeout;

beforeEach(() => {
  localStorage.setItem('badizo-direct-receipt-printing', '1');
  global.fetch = jest.fn();
  AbortSignal.timeout = () => new AbortController().signal;
});

afterEach(() => {
  localStorage.clear();
  global.fetch = originalFetch;
  AbortSignal.timeout = originalTimeout;
  jest.clearAllMocks();
});

test('paired helper offline before submission allows browser print', async () => {
  global.fetch.mockRejectedValueOnce(new TypeError('Helper offline'));
  expect(await printOnLocalReceiptPrinter(document.body)).toBe('');
  expect(global.fetch).toHaveBeenCalledTimes(1);
  expect(html2canvas).not.toHaveBeenCalled();
});

test('lost acknowledgement after submission does not trigger a second print', async () => {
  global.fetch.mockResolvedValueOnce({
    ok: true, json: async () => ({ service: 'badizo-receipt', printer: 'Counter' })
  }).mockRejectedValueOnce(new TypeError('Connection lost'));
  html2canvas.mockResolvedValue({ toBlob: callback => callback(new Blob(['receipt'])) });
  await expect(printOnLocalReceiptPrinter(document.body)).rejects.toThrow('Connection lost');
  expect(global.fetch).toHaveBeenCalledTimes(2);
  expect(global.fetch.mock.calls[1][1].method).toBe('POST');
});
