# Interview guide: local-rag-assistant

Notes for explaining this project in an interview. Everything here refers to code in this repo.

## 1. How it works, in simple words

1. **Ingest.** You give it a PDF, Markdown or text file. `src/loaders.ts` turns the bytes into "sections": one per PDF page, one per Markdown heading, or one for a whole text file.
2. **Chunk.** `src/chunker.ts` cuts each section into pieces of at most `CHUNK_SIZE` characters (800 by default). It cuts at paragraph and sentence boundaries, and repeats the last sentence or two of one chunk at the start of the next (`CHUNK_OVERLAP`, 120 by default) so a fact on a boundary is not lost. A chunk never crosses a heading or a page, which keeps citations precise.
3. **Embed.** Each chunk, with the file name and heading path in front of it, is sent to Ollama's `nomic-embed-text` model, which returns a list of 768 numbers (a vector) that represents its meaning.
4. **Store.** `src/vectorStore.ts` saves the text and the vector (as a binary blob) in a SQLite file. Vectors are scaled to length 1 first, so later the cosine similarity is just a dot product.
5. **Ask.** The question is embedded the same way. The store scores every chunk against it (brute force, a simple loop) and returns the top k.
6. **Answer.** `src/rag.ts` numbers those chunks [1]..[k], puts them in the prompt with rules ("cite with [n]", "say you could not find it"), and streams the model's answer back. The server forwards each piece to the browser as a Server-Sent Event.
7. **Cite.** The browser turns every `[n]` in the answer into a button that opens source n, which shows the file, heading or page, chunk number and the passage itself.

Think of it like a SQL query where the `WHERE` clause is "most similar meaning" instead of an exact match, followed by a prompt that says "answer only from these rows".

## 2. Files to read first, in order

1. `src/rag.ts`: the whole question-to-answer flow in about 100 lines, including the prompt and the "nothing retrieved" guardrail.
2. `src/chunker.ts`: how documents are split; the overlap logic is the interesting part.
3. `src/vectorStore.ts`: the SQLite schema, vector blobs, and the brute-force search.
4. `src/server.ts`: the API, especially `POST /api/ask` (SSE streaming, client disconnect handling) and the upload validation.
5. `src/providers/` (`types.ts`, then `ollama.ts`, `mock.ts`, `claude.ts`, `index.ts`): one interface, three implementations, chosen by `LLM_PROVIDER`.
6. `web/app.ts` and `web/sse.ts`: how the browser reads a streamed POST response and links citations.
7. `eval/run-eval.ts` and `src/evalMetrics.ts`: how hit rate and MRR are measured.
8. `tests/server.test.ts`: shows the API contract end to end in mock mode.

## 3. Likely questions and honest answers

**Why brute-force search instead of a vector database or an index like HNSW?**
The sample corpus is 70 chunks. In the committed eval run the median query time was 99 ms (278 ms in an earlier run while Ollama was busier), and almost all of that is the call to Ollama to embed the question; scoring 70 vectors is a loop of 70 dot products. Even 50,000 chunks of 768 floats is only about 150 MB, which a linear scan can still handle for a single user (I have not benchmarked that size). An approximate index adds a dependency and recall loss that this scale does not need. The search is behind one method (`VectorStore.search`), so swapping in `sqlite-vec` or a dedicated vector DB later is a contained change.

**Why does the Claude provider still use Ollama for embeddings?**
The Claude API has no embeddings endpoint. Also, vectors from different models live in different spaces and cannot be compared, so the store records which model made its vectors and refuses to mix them (`EmbeddingMismatchError`). Keeping embeddings local means switching chat provider never forces a re-index, and documents are only sent out in the few passages that go into a prompt. The Claude provider is unit-tested with a stubbed HTTP layer only; it was not run against the live API.

**How do you stop the model from making things up?**
Three things, none of them perfect: the system prompt says to answer only from the numbered passages and to say when the answer is missing; if retrieval returns nothing the model is not called at all (`NO_CONTEXT_MESSAGE` in `rag.ts`); and `extractCitedNumbers` drops citation numbers that do not exist, because small models sometimes invent `[7]` when only four passages were given. The spot check in `eval/run-faithfulness.ts` measures how often the answer contains the expected fact and cites the right file. It is a keyword check, not a full faithfulness judge. On the shared CPU-only Ollama it did not finish all 8 questions within budget, so the README publishes no score for it.

**What do hit rate@k and MRR mean, and what did you get?**
Hit rate@k is the share of questions where a relevant chunk appears in the top k results. MRR (mean reciprocal rank) averages 1/rank of the first relevant result, so rank 1 scores 1, rank 2 scores 0.5, a miss scores 0. A chunk counts as relevant only if it comes from the expected file and contains a specific evidence phrase. The actual numbers are in the README and `docs/eval-results.md`. The questions were written by me against my own documents, so they are easier than real user questions; 28 questions is also small, so one question moves the hit rate by about 3.6 points.

**Why character-based chunks rather than tokens?**
Characters need no tokenizer dependency and are predictable across models. 800 characters is roughly 150 to 200 tokens of English, well inside `nomic-embed-text`'s context. The trade-off is that the size is approximate in tokens; for this app that does not matter.

**Why prefix chunks with the file name and heading before embedding?**
A chunk such as "Up to 5 unused days can be carried over" does not say it is about annual leave. Prepending "hr leave policy - Leave Policy > Annual leave > Carry-over" puts that context into the vector. nomic-embed-text also expects `search_document:` and `search_query:` prefixes, which the Ollama provider adds.

**How does streaming work end to end?**
Ollama returns newline-delimited JSON; `OllamaChat.streamChat` parses it into an async iterator of strings. `answerQuestion` is an async generator yielding `sources`, then `token` events, then `done`. The Express handler writes each as an SSE frame. The browser cannot use `EventSource` because that only supports GET, so it reads the `fetch` body stream and parses frames with `SseParser`. If the browser disconnects, the `close` event aborts the `AbortController`, which cancels the Ollama request.

**What happens when Ollama is slow or down?**
Every outbound call has a timeout (`fetchWithTimeout`), and connection errors, timeouts, 429 and 5xx are retried with exponential backoff (`withRetry`). Only the connection attempt of a chat stream is retried; once tokens have been sent, a failure becomes an SSE `error` event, because retrying would duplicate text. Ingests are queued so the shared CPU-only Ollama never gets parallel embedding requests from this app.

**How is the upload endpoint protected?**
The filename is reduced to its base name (no path traversal), the extension must be one of the supported types, the body size is capped by `MAX_UPLOAD_MB`, empty bodies are rejected, and the server binds to 127.0.0.1 by default. There is no authentication; it is meant to run on your own machine.

**How do you test something that depends on an LLM?**
The `mock` provider uses hash-based bag-of-words embeddings (texts sharing words get similar vectors) and a canned answer that quotes the first passage and cites `[1]`. That makes ranking and streaming tests deterministic, and CI needs no model. Ollama and Claude are tested with stubbed `fetch` functions that return recorded-style responses, including error cases.

## 4. Three small improvements to try

1. **Show which chunks were cited in the CLI output.** `src/cli/ask.ts` prints all sources. The `done` event already has `cited`; mark those lines (for example with `*`). Start in `formatSourcesList` in `src/citations.ts` and add a test in `tests/citations.test.ts`.
2. **Add a `/api/documents/:id/chunks` endpoint** that returns a document's chunks, so you can see how the chunker split a file. Add a `listChunks(documentId)` method to `VectorStore` (a simple `SELECT` ordered by `chunk_index`), then a route in `src/server.ts` next to the existing document routes, and a test in `tests/server.test.ts`.
3. **Try a different chunk size in the eval.** Run `CHUNK_SIZE=400 CHUNK_OVERLAP=60 npm run eval -- --no-write` and compare hit rates with the defaults. If you want this saved, add a `--label` flag in `eval/common.ts` so results go to a different JSON file instead of overwriting `retrieval.json`.
