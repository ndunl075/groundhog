import { join } from "node:path";
import { dataDir } from "../store/paths.ts";
import type { Store } from "../store/db.ts";

export const DEFAULT_MODEL = "Xenova/all-MiniLM-L6-v2";

/** Model text is truncated to the encoder's window; longer input is wasted work. */
const MAX_CHARS = 2000;

export interface EmbedProgress {
  done: number;
  total: number;
}

/**
 * Wraps transformers.js. The dependency is optional and the model is fetched on
 * first use, so a Groundhog that never enables embeddings never pays for either.
 *
 * Inference runs in-process: ONNX Runtime executes on its own native thread
 * pool, so the event loop stays free without a worker — which also keeps the
 * single-file .exe build simple.
 */
export class Embedder {
  readonly modelId: string;
  readonly dim: number;
  private readonly extract: FeatureExtractor;

  private constructor(modelId: string, dim: number, extract: FeatureExtractor) {
    this.modelId = modelId;
    this.dim = dim;
    this.extract = extract;
  }

  static async load(
    modelId: string = DEFAULT_MODEL,
    onDownload?: (msg: string) => void,
  ): Promise<Embedder> {
    const mod = await importTransformers();

    // Keep models beside the indexes so the portable build stays self-contained.
    mod.env.cacheDir = join(dataDir(), "models");

    // transformers.js fires progress per chunk read; report only when the
    // whole percent actually moves, or the callback drowns the terminal.
    const lastPercent = new Map<string, number>();
    const extract = (await mod.pipeline("feature-extraction", modelId, {
      dtype: "q8",
      progress_callback: onDownload
        ? (p: { status?: string; file?: string; progress?: number }) => {
            if (p.status !== "progress" || !p.file || typeof p.progress !== "number") return;
            const percent = Math.floor(p.progress);
            if (lastPercent.get(p.file) === percent) return;
            lastPercent.set(p.file, percent);
            onDownload(`${p.file} ${percent}%`);
          }
        : undefined,
    })) as FeatureExtractor;

    const probe = await runExtractor(extract, ["dimension probe"]);
    return new Embedder(modelId, probe[0]!.length, extract);
  }

  /** Returns L2-normalized vectors, so cosine similarity is a plain dot product. */
  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    return runExtractor(
      this.extract,
      texts.map((t) => t.slice(0, MAX_CHARS)),
    );
  }
}

async function runExtractor(
  extract: FeatureExtractor,
  texts: string[],
): Promise<Float32Array[]> {
  const output = await extract(texts, { pooling: "mean", normalize: true });
  const flat = output.data;
  const rows = texts.length;
  const dim = flat.length / rows;

  const out: Float32Array[] = [];
  for (let i = 0; i < rows; i++) {
    out.push(Float32Array.from(flat.subarray(i * dim, (i + 1) * dim)));
  }
  return out;
}

async function importTransformers(): Promise<TransformersModule> {
  try {
    return (await import("@huggingface/transformers")) as unknown as TransformersModule;
  } catch {
    throw new Error(
      "Semantic search needs the optional @huggingface/transformers package.\n" +
        "Install it with: npm i @huggingface/transformers",
    );
  }
}

// ---- store integration -----------------------------------------------------

const MODEL_KEY = "embed:model";

export function embeddingModel(store: Store): string | null {
  return store.getMeta(MODEL_KEY);
}

export function embeddingsEnabled(store: Store): boolean {
  return embeddingModel(store) !== null;
}

/**
 * Embeds every chunk that has no vector yet. Safe to interrupt and re-run:
 * progress is committed per batch, and the query for pending work is the
 * resume point.
 *
 * Switching models invalidates the existing vectors, so they are dropped rather
 * than left to be silently compared across incompatible spaces.
 */
export async function backfillVectors(
  store: Store,
  opts: {
    modelId?: string;
    batch?: number;
    embedder?: Embedder;
    onProgress?: (p: EmbedProgress) => void;
    onDownload?: (msg: string) => void;
  } = {},
): Promise<{ embedded: number; durationMs: number; dim: number }> {
  const started = Date.now();
  const embedder =
    opts.embedder ?? (await Embedder.load(opts.modelId ?? DEFAULT_MODEL, opts.onDownload));

  const previous = embeddingModel(store);
  if (previous && previous !== embedder.modelId) {
    store.raw.prepare("DELETE FROM vector").run();
  }
  store.setMeta(MODEL_KEY, embedder.modelId);
  store.setMeta("embed:dim", String(embedder.dim));

  const batchSize = opts.batch ?? 32;
  const total = (
    store.raw
      .prepare(
        "SELECT COUNT(*) AS n FROM chunk c LEFT JOIN vector v ON v.chunk_id = c.id WHERE v.chunk_id IS NULL",
      )
      .get() as { n: number }
  ).n;

  let embedded = 0;
  for (;;) {
    const pending = store.chunksWithoutVectors(batchSize);
    if (pending.length === 0) break;

    const vectors = await embedder.embed(pending.map((c) => c.text));
    store.putVectors(
      pending.map((chunk, i) => ({ chunkId: chunk.id, vector: vectors[i]! })),
    );

    embedded += pending.length;
    opts.onProgress?.({ done: embedded, total });
  }

  return { embedded, durationMs: Date.now() - started, dim: embedder.dim };
}

// ---- minimal structural types for the optional dependency ------------------

interface ExtractorOutput {
  data: Float32Array;
}

type FeatureExtractor = (
  texts: string[],
  opts: { pooling: "mean"; normalize: boolean },
) => Promise<ExtractorOutput>;

interface TransformersModule {
  env: { cacheDir: string };
  pipeline: (
    task: string,
    model: string,
    opts: Record<string, unknown>,
  ) => Promise<unknown>;
}
