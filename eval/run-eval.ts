// Retrieval eval: hit rate @1/@3/@5 and MRR over eval/qa-set.json.
// Usage: npm run eval            (real Ollama embeddings, writes docs/eval/)
//        npm run eval -- --mock  (hash embeddings, prints only; used in CI)
import path from 'node:path';
import { computeRetrievalMetrics, firstRelevantRank } from '../src/evalMetrics.js';
import { retrieve } from '../src/rag.js';
import { buildIndex, containsEvidence, environment, parseFlags, pct, readJson, ROOT, writeResult } from './common.js';
import { writeReport } from './report.js';

interface QaItem {
  id: string;
  question: string;
  expectedSource: string;
  evidence: string;
}

const K = 5;
const flags = parseFlags(process.argv.slice(2));
const { questions } = readJson<{ questions: QaItem[] }>(path.join(ROOT, 'eval', 'qa-set.json'));

const ctx = await buildIndex(flags);
process.stderr.write(
  `Indexed ${ctx.documentCount} documents into ${ctx.chunkCount} chunks with ${ctx.providers.embedder.model} in ${ctx.ingestMs} ms\n`,
);

const perQuestion = [];
const queryTimes: number[] = [];
for (const item of questions) {
  const started = performance.now();
  const results = await retrieve(item.question, { store: ctx.store, embedder: ctx.providers.embedder, topK: K });
  queryTimes.push(performance.now() - started);
  const chunkRank = firstRelevantRank(results, (r) => r.source === item.expectedSource && containsEvidence(r.text, item.evidence));
  const sourceRank = firstRelevantRank(results, (r) => r.source === item.expectedSource);
  perQuestion.push({
    id: item.id,
    question: item.question,
    expectedSource: item.expectedSource,
    chunkRank,
    sourceRank,
    top: results.map((r) => ({ source: r.source, chunkIndex: r.chunkIndex, heading: r.heading, page: r.page, score: Number(r.score.toFixed(4)) })),
  });
  process.stderr.write(`${item.id} chunk rank ${chunkRank ?? '-'}  source rank ${sourceRank ?? '-'}\n`);
}
ctx.store.close();

const chunkLevel = computeRetrievalMetrics(perQuestion.map((q) => q.chunkRank));
const sourceLevel = computeRetrievalMetrics(perQuestion.map((q) => q.sourceRank));
const sortedTimes = [...queryTimes].sort((a, b) => a - b);
const result = {
  kind: 'retrieval',
  ...environment(),
  embedProvider: ctx.providers.embedder.name,
  embedModel: ctx.providers.embedder.model,
  chunkSize: ctx.config.chunkSize,
  chunkOverlap: ctx.config.chunkOverlap,
  k: K,
  documents: ctx.documentCount,
  chunks: ctx.chunkCount,
  ingestMs: ctx.ingestMs,
  queryMedianMs: Math.round(sortedTimes[Math.floor(sortedTimes.length / 2)] ?? 0),
  chunkLevel,
  sourceLevel,
  perQuestion,
};

const line = (name: string, m: typeof chunkLevel) =>
  `${name.padEnd(13)} hit@1 ${pct(m.hitRateAt1)}  hit@3 ${pct(m.hitRateAt3)}  hit@5 ${pct(m.hitRateAt5)}  MRR ${m.mrr.toFixed(3)}`;
process.stdout.write(`\n${questions.length} questions, ${result.embedModel}, chunk ${result.chunkSize}/${result.chunkOverlap}\n`);
process.stdout.write(line('chunk-level', chunkLevel) + '\n' + line('source-level', sourceLevel) + '\n');

if (flags.write) {
  process.stdout.write(`Saved ${writeResult('retrieval.json', result)}\n`);
  process.stdout.write(`Updated ${writeReport()}\n`);
}
