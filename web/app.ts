import { escapeHtml, linkCitations, SseParser } from './sse.js';

interface Citation {
  n: number;
  label: string;
  score: number;
  text: string;
}

interface DocumentRecord {
  id: number;
  source: string;
  chunkCount: number;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const statusEl = $<HTMLSpanElement>('status');
const modelSelect = $<HTMLSelectElement>('model');
const uploadForm = $<HTMLFormElement>('upload-form');
const filesInput = $<HTMLInputElement>('files');
const uploadStatus = $<HTMLParagraphElement>('upload-status');
const docList = $<HTMLUListElement>('doc-list');
const askForm = $<HTMLFormElement>('ask-form');
const questionInput = $<HTMLTextAreaElement>('question');
const askButton = $<HTMLButtonElement>('ask-button');
const resultEl = $<HTMLDivElement>('result');
const questionEcho = $<HTMLParagraphElement>('question-echo');
const answerEl = $<HTMLDivElement>('answer');
const timingEl = $<HTMLParagraphElement>('timing');
const sourcesEl = $<HTMLOListElement>('sources');

let citations: Citation[] = [];

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = res.status === 204 ? {} : await res.json();
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  return body as T;
}

async function loadHealth(): Promise<void> {
  try {
    const h = await getJson<{ provider: string; embeddingModel: string; chunks: number }>('/api/health');
    statusEl.textContent = `${h.provider} chat · ${h.embeddingModel} embeddings · ${h.chunks} chunks`;
  } catch (err) {
    statusEl.textContent = `API unreachable: ${(err as Error).message}`;
  }
}

async function loadModels(): Promise<void> {
  const data = await getJson<{ defaultModel: string; models: string[]; warning?: string }>('/api/models');
  const saved = localStorageGet('model');
  modelSelect.innerHTML = data.models.map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join('');
  modelSelect.value = saved && data.models.includes(saved) ? saved : data.defaultModel;
  if (data.warning) modelSelect.title = data.warning;
}

function localStorageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

async function loadDocuments(): Promise<void> {
  const { documents } = await getJson<{ documents: DocumentRecord[] }>('/api/documents');
  docList.innerHTML = documents.length
    ? documents
        .map(
          (d) => `<li><span class="name">${escapeHtml(d.source)}</span>
            <span class="meta">${d.chunkCount} chunks</span>
            <button type="button" data-delete="${d.id}" title="Remove ${escapeHtml(d.source)}">remove</button></li>`,
        )
        .join('')
    : '<li class="muted">No documents yet. Upload a .md, .txt or .pdf file.</li>';
}

uploadForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const files = [...(filesInput.files ?? [])];
  if (files.length === 0) return;
  uploadStatus.classList.remove('error');
  // One file at a time: embedding runs on a shared CPU-only Ollama.
  for (const [i, file] of files.entries()) {
    uploadStatus.textContent = `Ingesting ${file.name} (${i + 1}/${files.length})...`;
    try {
      const r = await getJson<{ skipped: boolean; ms: number; document: DocumentRecord }>(
        `/api/documents?filename=${encodeURIComponent(file.name)}`,
        { method: 'POST', body: file, headers: { 'content-type': 'application/octet-stream' } },
      );
      uploadStatus.textContent = r.skipped
        ? `${file.name} unchanged, skipped.`
        : `${file.name}: ${r.document.chunkCount} chunks in ${(r.ms / 1000).toFixed(1)} s.`;
    } catch (err) {
      uploadStatus.textContent = `${file.name}: ${(err as Error).message}`;
      uploadStatus.classList.add('error');
    }
    await loadDocuments();
  }
  filesInput.value = '';
  await loadHealth();
});

docList.addEventListener('click', async (e) => {
  const id = (e.target as HTMLElement).dataset.delete;
  if (!id) return;
  await getJson(`/api/documents/${id}`, { method: 'DELETE' });
  await Promise.all([loadDocuments(), loadHealth()]);
});

modelSelect.addEventListener('change', () => {
  try {
    localStorage.setItem('model', modelSelect.value);
  } catch {
    // Private mode: the choice just is not remembered.
  }
});

function renderSources(cited: number[] = []): void {
  sourcesEl.innerHTML = citations
    .map(
      (c) => `<li id="source-${c.n}" class="${cited.includes(c.n) ? 'cited' : ''}">
        <details><summary><span class="label">[${c.n}] ${escapeHtml(c.label)}</span>
        <span class="score">score ${c.score.toFixed(3)}</span></summary>
        <p class="excerpt">${escapeHtml(c.text)}</p></details></li>`,
    )
    .join('');
}

answerEl.addEventListener('click', (e) => {
  const n = (e.target as HTMLElement).dataset.n;
  if (!n) return;
  const item = document.getElementById(`source-${n}`);
  if (!item) return;
  item.querySelector('details')?.setAttribute('open', '');
  item.scrollIntoView({ behavior: 'smooth', block: 'center' });
  item.classList.add('flash');
  setTimeout(() => item.classList.remove('flash'), 1200);
});

askForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const question = questionInput.value.trim();
  if (!question) return;

  askButton.disabled = true;
  resultEl.hidden = false;
  questionEcho.textContent = question;
  answerEl.textContent = '';
  answerEl.classList.add('streaming');
  timingEl.textContent = 'Retrieving...';
  citations = [];
  renderSources();

  let answer = '';
  try {
    const res = await fetch('/api/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question, model: modelSelect.value }),
    });
    if (!res.ok || !res.body) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `HTTP ${res.status}`);
    }
    const parser = new SseParser();
    const decoder = new TextDecoder();
    const reader = res.body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const msg of parser.push(decoder.decode(value, { stream: true }))) {
        const data = JSON.parse(msg.data);
        if (msg.event === 'sources') {
          citations = data.citations as Citation[];
          renderSources();
          timingEl.textContent = `Generating with ${modelSelect.value}...`;
        } else if (msg.event === 'token') {
          answer += data.text as string;
          answerEl.innerHTML = linkCitations(answer, citations.length);
        } else if (msg.event === 'done') {
          renderSources(data.cited as number[]);
          timingEl.textContent = `${data.model} · retrieval ${data.retrievalMs} ms · generation ${(data.generationMs / 1000).toFixed(1)} s`;
        } else if (msg.event === 'error') {
          throw new Error(data.message as string);
        }
      }
    }
  } catch (err) {
    timingEl.textContent = `Error: ${(err as Error).message}`;
    timingEl.classList.add('error');
  } finally {
    answerEl.classList.remove('streaming');
    askButton.disabled = false;
  }
});

questionInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    askForm.requestSubmit();
  }
});

void Promise.all([loadHealth(), loadModels(), loadDocuments()]);
