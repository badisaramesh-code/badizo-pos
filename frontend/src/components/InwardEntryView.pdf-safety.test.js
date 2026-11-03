import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf';
import { renderPdfPages } from './InwardEntryView';
jest.mock('pdfjs-dist/legacy/build/pdf', () => ({ GlobalWorkerOptions: {}, getDocument: jest.fn() }));
jest.mock('pdfjs-dist/legacy/build/pdf.worker.min.js', () => 'test-worker.js');

test('PDF invoice imports disable dynamic code evaluation', async () => {
  const data = new ArrayBuffer(4);
  pdfjsLib.getDocument.mockReturnValue({ promise: Promise.resolve({ numPages: 0 }) });
  expect(await renderPdfPages({ arrayBuffer: async () => data })).toEqual({ pages: [], text: '' });
  expect(pdfjsLib.getDocument).toHaveBeenCalledWith({ data, isEvalSupported: false });
});
