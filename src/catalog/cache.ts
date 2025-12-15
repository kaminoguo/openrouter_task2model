import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { OpenRouterModel } from '../schema/taskSpec.js';

export interface CacheEntry<T> {
  data: T;
  fetched_at: string;
  expires_at: string;
}

export interface CacheStatus {
  fetched_at: string;
  cache_age_ms: number;
  source: 'live' | 'cache';
}

// Embeddings cache: model_id -> embedding vector
export interface EmbeddingsCache {
  embeddings: Record<string, number[]>;  // model_id -> embedding
  fetched_at: string;
  model_count: number;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes
const EMBEDDINGS_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours (embeddings change less often)
const CACHE_DIR = process.env.CACHE_DIR || join(homedir(), '.cache', 'openrouter-task2model');

// In-memory cache
let modelsCache: CacheEntry<OpenRouterModel[]> | null = null;
let embeddingsCache: EmbeddingsCache | null = null;

export function getCacheTTL(): number {
  const envTTL = process.env.CACHE_TTL_MS;
  if (envTTL) {
    const parsed = parseInt(envTTL, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_TTL_MS;
}

export function isCacheValid(entry: CacheEntry<unknown> | null): boolean {
  if (!entry) return false;
  return new Date(entry.expires_at).getTime() > Date.now();
}

export function getModelsCache(): CacheEntry<OpenRouterModel[]> | null {
  return modelsCache;
}

export function setModelsCache(models: OpenRouterModel[]): CacheEntry<OpenRouterModel[]> {
  const now = new Date();
  const ttl = getCacheTTL();
  const entry: CacheEntry<OpenRouterModel[]> = {
    data: models,
    fetched_at: now.toISOString(),
    expires_at: new Date(now.getTime() + ttl).toISOString(),
  };
  modelsCache = entry;

  // Fire-and-forget disk persistence
  saveToDisk(entry).catch(() => {
    // Disk save failure should not affect runtime
  });

  return entry;
}

export function getCacheStatus(entry: CacheEntry<unknown>, source: 'live' | 'cache'): CacheStatus {
  const fetchedAt = new Date(entry.fetched_at).getTime();
  return {
    fetched_at: entry.fetched_at,
    cache_age_ms: Date.now() - fetchedAt,
    source,
  };
}

export function clearModelsCache(): void {
  modelsCache = null;
}

// Embeddings cache functions
export function getEmbeddingsCache(): EmbeddingsCache | null {
  return embeddingsCache;
}

export function setEmbeddingsCache(embeddings: Record<string, number[]>): EmbeddingsCache {
  const cache: EmbeddingsCache = {
    embeddings,
    fetched_at: new Date().toISOString(),
    model_count: Object.keys(embeddings).length,
  };
  embeddingsCache = cache;

  // Fire-and-forget disk persistence
  saveEmbeddingsToDisk(cache).catch(() => {
    // Disk save failure should not affect runtime
  });

  return cache;
}

export function getModelEmbedding(modelId: string): number[] | null {
  return embeddingsCache?.embeddings[modelId] || null;
}

export function hasAllEmbeddings(modelIds: string[]): boolean {
  if (!embeddingsCache) return false;
  return modelIds.every(id => id in embeddingsCache!.embeddings);
}

export function getMissingEmbeddingIds(modelIds: string[]): string[] {
  if (!embeddingsCache) return modelIds;
  return modelIds.filter(id => !(id in embeddingsCache!.embeddings));
}

export function addEmbeddings(newEmbeddings: Record<string, number[]>): void {
  if (!embeddingsCache) {
    setEmbeddingsCache(newEmbeddings);
    return;
  }

  embeddingsCache.embeddings = { ...embeddingsCache.embeddings, ...newEmbeddings };
  embeddingsCache.model_count = Object.keys(embeddingsCache.embeddings).length;

  // Fire-and-forget disk persistence
  saveEmbeddingsToDisk(embeddingsCache).catch(() => {});
}

export function clearEmbeddingsCache(): void {
  embeddingsCache = null;
}

// Disk persistence functions
async function ensureCacheDir(): Promise<void> {
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
  } catch {
    // Ignore errors
  }
}

async function saveToDisk(entry: CacheEntry<OpenRouterModel[]>): Promise<void> {
  await ensureCacheDir();

  const modelsPath = join(CACHE_DIR, 'models.json');
  const metaPath = join(CACHE_DIR, 'meta.json');

  await Promise.all([
    fs.writeFile(modelsPath, JSON.stringify(entry.data, null, 2)),
    fs.writeFile(metaPath, JSON.stringify({
      fetched_at: entry.fetched_at,
      expires_at: entry.expires_at,
      model_count: entry.data.length,
    }, null, 2)),
  ]);
}

async function saveEmbeddingsToDisk(cache: EmbeddingsCache): Promise<void> {
  await ensureCacheDir();

  const embeddingsPath = join(CACHE_DIR, 'embeddings.json');
  await fs.writeFile(embeddingsPath, JSON.stringify(cache));
}

async function loadEmbeddingsFromDisk(): Promise<EmbeddingsCache | null> {
  try {
    const embeddingsPath = join(CACHE_DIR, 'embeddings.json');
    const json = await fs.readFile(embeddingsPath, 'utf-8');
    const cache = JSON.parse(json) as EmbeddingsCache;

    // Check if embeddings are still fresh (24h TTL)
    const fetchedAt = new Date(cache.fetched_at).getTime();
    if (Date.now() - fetchedAt > EMBEDDINGS_TTL_MS) {
      return null;
    }

    embeddingsCache = cache;
    return cache;
  } catch {
    return null;
  }
}

export async function loadFromDisk(): Promise<CacheEntry<OpenRouterModel[]> | null> {
  try {
    const modelsPath = join(CACHE_DIR, 'models.json');
    const metaPath = join(CACHE_DIR, 'meta.json');

    const [modelsJson, metaJson] = await Promise.all([
      fs.readFile(modelsPath, 'utf-8'),
      fs.readFile(metaPath, 'utf-8'),
    ]);

    const models = JSON.parse(modelsJson) as OpenRouterModel[];
    const meta = JSON.parse(metaJson) as { fetched_at: string; expires_at: string };

    const entry: CacheEntry<OpenRouterModel[]> = {
      data: models,
      fetched_at: meta.fetched_at,
      expires_at: meta.expires_at,
    };

    // Only use disk cache if it's still valid
    if (isCacheValid(entry)) {
      modelsCache = entry;
      return entry;
    }

    return null;
  } catch {
    return null;
  }
}

// Initialize cache from disk on startup
export async function initializeCache(): Promise<void> {
  const promises: Promise<unknown>[] = [];

  if (!modelsCache) {
    promises.push(loadFromDisk());
  }

  if (!embeddingsCache) {
    promises.push(loadEmbeddingsFromDisk());
  }

  await Promise.all(promises);
}
