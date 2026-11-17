// Answer spot check: asks the chat model ~8 questions through the full RAG
// pipeline, one at a time, and checks the answer with keywords and citations.
// Usage: npm run eval:faithfulness [-- --mock]
import path from 'node:path';
import { containsAllKeywordGroups } from '../src/evalMetrics.js';
import { answerQuestion } from '../src/rag.js';
import type { Citation } from '../src/citations.js';
import { buildIndex, environment, parseFlags, pct, readJson, ROOT, writeResult } from './common.js';
import { writeReport } from './report.js';

interface SpotItem {
  id: string;
  question: string;
  expectedSource: string;
  keywords: string[][];
}

const flags = parseFlags(process.argv.slice(2));
const { questions } = readJson<{ questions: SpotItem[] }>(path.join(ROOT, 'eval', 'faithfulness-set.json'));
const ctx = await buildIndex(flags);
const model = ctx.providers.chat.defaultModel;
process.stderr.write(`Indexed ${ctx.chunkCount} chunks; asking ${questions.length} questions with ${model}\n`);

const perQuestion = [];
for (const item of questions) {
  let citations: Citation[] = [];
  let answer = '';
  let cited: number[] = [];
  let generationMs = 0;
  let error: string | undefined;
  try {
    for await (const event of answerQuestion(item.question, {
      store: ctx.store,
      embedder: ctx.providers.embedder,
      chat: ctx.providers.chat,
      topK: ctx.config.topK,
    })) {
      if (event.type === 'sources') citations = event.citations;
      if (event.type === 'done') ({ answer, cited, generationMs } = event);
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  const factOk = !error && containsAllKeywordGroups(answer, item.keywords);
  const citedSources = cited.map((n) => citations[n - 1]!.source);
  const citationOk = citedSources.includes(item.expectedSource);
  perQuestion.push({ id: item.id, question: item.question, answer, cited, citedSources, factOk, citationOk, generationMs, error });
  process.stderr.write(`${item.id} fact ${factOk ? 'ok' : 'MISS'}  citation ${citationOk ? 'ok' : 'MISS'}  ${(generationMs / 1000).toFixed(1)} s\n`);
}
ctx.store.close();

const n = perQuestion.length;
const times = perQuestion.map((q) => q.generationMs).sort((a, b) => a - b);
const result = {
  kind: 'faithfulness',
  ...environment(),
  chatProvider: ctx.providers.chat.name,
  chatModel: model,
  embedModel: ctx.providers.embedder.model,
  topK: ctx.config.topK,
  questions: n,
  factRate: perQuestion.filter((q) => q.factOk).length / n,
  citationRate: perQuestion.filter((q) => q.citationOk).length / n,
  bothRate: perQuestion.filter((q) => q.factOk && q.citationOk).length / n,
  generationMedianMs: times[Math.floor(n / 2)] ?? 0,
  generationMaxMs: times.at(-1) ?? 0,
  perQuestion,
};
process.stdout.write(
  `\nfacts ${pct(result.factRate)}  citations ${pct(result.citationRate)}  both ${pct(result.bothRate)}  median generation ${(result.generationMedianMs / 1000).toFixed(1)} s\n`,
);
if (flags.write) {
  process.stdout.write(`Saved ${writeResult('faithfulness.json', result)}\n`);
  process.stdout.write(`Updated ${writeReport()}\n`);
}
