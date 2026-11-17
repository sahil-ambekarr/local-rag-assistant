import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { documentTypeFor, loadDocument, UnsupportedDocumentError } from '../src/loaders.js';

const samples = path.resolve(import.meta.dirname, '..', 'sample-docs');

describe('loadDocument', () => {
  it('extracts one section per PDF page with page numbers', async () => {
    const doc = await loadDocument('security-handbook.pdf', fs.readFileSync(path.join(samples, 'security-handbook.pdf')));
    expect(doc.type).toBe('pdf');
    expect(doc.sections.map((s) => s.page)).toEqual([1, 2, 3]);
    expect(doc.sections[1]!.text).toContain('Report Phishing button');
  });

  it('splits Markdown by headings and strips a BOM', async () => {
    const doc = await loadDocument('a.md', Buffer.from('﻿# Title\nBody'));
    expect(doc.sections).toEqual([{ heading: 'Title', text: 'Body' }]);
  });

  it('keeps plain text as one section', async () => {
    const doc = await loadDocument('a.txt', Buffer.from('  hello  '));
    expect(doc.sections).toEqual([{ text: 'hello' }]);
  });

  it('rejects empty files, unreadable PDFs and unknown types', async () => {
    await expect(loadDocument('a.txt', Buffer.from('   '))).rejects.toThrow(/no extractable text/);
    await expect(loadDocument('a.pdf', Buffer.from('not a pdf'))).rejects.toBeInstanceOf(UnsupportedDocumentError);
    expect(() => documentTypeFor('a.docx')).toThrow(UnsupportedDocumentError);
    expect(documentTypeFor('A.MARKDOWN')).toBe('markdown');
  });
});

describe('unwrapPdfLines', () => {
  it('re-joins hard-wrapped lines but keeps sentence-ending line breaks', async () => {
    const { unwrapPdfLines } = await import('../src/loaders.js');
    expect(unwrapPdfLines('Use the Report\nPhishing button.\nNext  \r\n\r\nline')).toBe('Use the Report Phishing button.\nNext line');
  });
});
