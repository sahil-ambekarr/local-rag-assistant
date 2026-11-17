export interface RetrievalMetrics {
  questions: number;
  hitRateAt1: number;
  hitRateAt3: number;
  hitRateAt5: number;
  mrr: number;
}

/**
 * Summarises retrieval quality from the 1-based rank of the first relevant
 * result per question (null when nothing relevant was in the retrieved list).
 *   hit rate@k = share of questions with a relevant result in the top k
 *   MRR        = mean of 1/rank, counting misses as 0
 */
export function computeRetrievalMetrics(ranks: (number | null)[]): RetrievalMetrics {
  const n = ranks.length;
  const hitRate = (k: number) => (n === 0 ? 0 : ranks.filter((r) => r !== null && r <= k).length / n);
  const mrr = n === 0 ? 0 : ranks.reduce<number>((sum, r) => sum + (r === null ? 0 : 1 / r), 0) / n;
  return { questions: n, hitRateAt1: hitRate(1), hitRateAt3: hitRate(3), hitRateAt5: hitRate(5), mrr };
}

/** 1-based position of the first item matching the predicate, or null. */
export function firstRelevantRank<T>(results: T[], isRelevant: (item: T) => boolean): number | null {
  const index = results.findIndex(isRelevant);
  return index === -1 ? null : index + 1;
}

/**
 * Keyword check used by the answer spot check. Every group must be satisfied;
 * a group is a list of alternatives, any one of which may appear
 * (case-insensitive, whitespace-normalised substring match).
 */
export function containsAllKeywordGroups(answer: string, groups: string[][]): boolean {
  const haystack = answer.toLowerCase().replace(/\s+/g, ' ');
  return groups.every((alternatives) => alternatives.some((alt) => haystack.includes(alt.toLowerCase())));
}
