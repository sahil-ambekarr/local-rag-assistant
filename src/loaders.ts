import path from 'node:path';
import { parseMarkdownSections, type Section } from './chunker.js';

export type DocumentType = 'markdown' | 'text' | 'pdf';

export const SUPPORTED_EXTENSIONS = ['.md', '.markdown', '.txt', '.pdf'] as const;

export class UnsupportedDocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedDocumentError';
  }
}

export interface LoadedDocument {
  type: DocumentType;
  sections: Section[];
}

export function documentTypeFor(filename: string): DocumentType {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.md' || ext === '.markdown') return 'markdown';
  if (ext === '.txt') return 'text';
  if (ext === '.pdf') return 'pdf';
  throw new UnsupportedDocumentError(
    `Unsupported file type "${ext || filename}". Supported: ${SUPPORTED_EXTENSIONS.join(', ')}`,
  );
}

async function loadPdfPages(data: Buffer): Promise<Section[]> {
  // Imported lazily: pdf.js is heavy and only needed when a PDF is ingested.
  const { extractText, getDocumentProxy } = await import('unpdf');
  let pages: string[];
  try {
    const pdf = await getDocumentProxy(new Uint8Array(data));
    ({ text: pages } = await extractText(pdf, { mergePages: false }));
  } catch (err) {
    throw new UnsupportedDocumentError(`Could not read PDF: ${err instanceof Error ? err.message : String(err)}`);
  }
  return pages
    .map((text, i) => ({ text: text.trim(), page: i + 1 }))
    .filter((section) => section.text.length > 0);
}

/** Turns raw file bytes into sections ready for chunking. */
export async function loadDocument(filename: string, data: Buffer): Promise<LoadedDocument> {
  const type = documentTypeFor(filename);
  let sections: Section[];
  if (type === 'pdf') {
    sections = await loadPdfPages(data);
  } else {
    const text = data.toString('utf8').replace(/^﻿/, '');
    sections = type === 'markdown' ? parseMarkdownSections(text) : text.trim() ? [{ text: text.trim() }] : [];
  }
  if (sections.length === 0) {
    // Scanned PDFs land here: there is no OCR step.
    throw new UnsupportedDocumentError(`"${filename}" contains no extractable text`);
  }
  return { type, sections };
}
