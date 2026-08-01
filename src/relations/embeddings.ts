import { createLogger } from '../logger.js';

/**
 * Question embeddings for candidate generation.
 *
 * A local sentence-transformer rather than a hosted embedding API: the model is
 * 23MB, runs on CPU, costs nothing per call, and — more importantly — is
 * deterministic and versioned, so a re-run produces byte-identical vectors and
 * the pipeline stays reproducible. Embedding 300k questions through a metered
 * API to find candidate pairs would cost more than the classification it feeds.
 *
 * The vectors are normalised, so cosine similarity is a dot product and
 * pgvector's `<=>` operator returns `1 - similarity` directly.
 */

const log = createLogger('embeddings');

/** Pinned: changing it invalidates every stored vector, which `model` detects. */
export const EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';
export const EMBEDDING_DIMENSIONS = 384;

export interface Embedder {
  readonly model: string;
  readonly dimensions: number;
  embed(texts: readonly string[]): Promise<number[][]>;
}

type FeatureExtractor = (
  texts: string[],
  options: { pooling: 'mean'; normalize: boolean },
) => Promise<{ tolist(): number[][] }>;

let pipelinePromise: Promise<FeatureExtractor> | undefined;

/**
 * Loads the model once per process.
 *
 * The import is dynamic so that merely importing this module — which the
 * schema and the review CLI both do transitively — does not pull ONNX runtime
 * into memory for a process that will never embed anything.
 */
async function loadPipeline(): Promise<FeatureExtractor> {
  pipelinePromise ??= (async () => {
    const { pipeline } = await import('@huggingface/transformers');
    log.info({ model: EMBEDDING_MODEL }, 'loading embedding model');
    const extractor = await pipeline('feature-extraction', EMBEDDING_MODEL);
    return extractor as unknown as FeatureExtractor;
  })();
  return pipelinePromise;
}

/** The real embedder. Batched, because per-call overhead dominates otherwise. */
export function createEmbedder(): Embedder {
  return {
    model: EMBEDDING_MODEL,
    dimensions: EMBEDDING_DIMENSIONS,

    async embed(texts) {
      if (texts.length === 0) return [];
      const extractor = await loadPipeline();
      const output = await extractor([...texts], { pooling: 'mean', normalize: true });
      const vectors = output.tolist();

      for (const vector of vectors) {
        if (vector.length !== EMBEDDING_DIMENSIONS) {
          throw new Error(
            `embedder returned ${vector.length} dimensions, expected ${EMBEDDING_DIMENSIONS}`,
          );
        }
      }
      return vectors;
    },
  };
}

/**
 * What actually gets embedded.
 *
 * The question alone. Resolution criteria are long, boilerplate-heavy, and
 * dominated by identical legal text across a whole event — including them
 * makes every market in an event look near-identical and destroys the signal
 * the index exists to provide. The criteria are given to the *classifier*,
 * where they matter; they are kept out of the *retriever*, where they do not.
 */
export function embeddingText(question: string): string {
  return question.replace(/\s+/g, ' ').trim();
}

/** Cosine similarity of two normalised vectors. */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return dot;
}
