import { EMPTY_STORE, type ZapRule, type ZapStore } from "./types";

/**
 * Persistence layer. Only the service worker touches this module — it owns
 * the canonical store and keeps a synchronous in-memory mirror (see sw.ts).
 * Everyone else (popup, options, content scripts) talks to the service
 * worker over messages instead of reading storage directly.
 *
 * Rules are chunked per-origin across chrome.storage.sync items to stay
 * under the 8KB-per-item / 100KB-total quota. An origin whose rules alone
 * exceed the per-item cap falls back to chrome.storage.local.
 */

const INDEX_KEY = "zap:index";
const originKey = (origin: string) => `zap:origin:${origin}`;

interface Index {
  version: 1;
  origins: string[];
  localOrigins: string[];
  disabledOrigins: string[];
}

function emptyIndex(): Index {
  return { version: 1, origins: [], localOrigins: [], disabledOrigins: [] };
}

async function readIndex(): Promise<Index> {
  const got = await chrome.storage.sync.get(INDEX_KEY);
  const idx = got[INDEX_KEY] as Index | undefined;
  return idx ?? emptyIndex();
}

function isQuotaError(err: unknown): boolean {
  const msg = String(err ?? chrome.runtime.lastError?.message ?? "");
  return /quota/i.test(msg);
}

export async function loadStore(): Promise<ZapStore> {
  const index = await readIndex();
  const rules: ZapRule[] = [];

  const syncOrigins = index.origins.filter((o) => !index.localOrigins.includes(o));
  if (syncOrigins.length > 0) {
    const got = await chrome.storage.sync.get(syncOrigins.map(originKey));
    for (const origin of syncOrigins) {
      const originRules = got[originKey(origin)] as ZapRule[] | undefined;
      if (originRules) rules.push(...originRules);
    }
  }

  if (index.localOrigins.length > 0) {
    const got = await chrome.storage.local.get(index.localOrigins.map(originKey));
    for (const origin of index.localOrigins) {
      const originRules = got[originKey(origin)] as ZapRule[] | undefined;
      if (originRules) rules.push(...originRules);
    }
  }

  if (rules.length === 0 && index.origins.length === 0) {
    return { ...EMPTY_STORE, disabledOrigins: index.disabledOrigins };
  }

  return { version: 1, rules, disabledOrigins: index.disabledOrigins };
}

/** Persists the rules for a single origin, falling back to local storage on quota overflow. */
export async function saveOrigin(origin: string, rules: ZapRule[]): Promise<void> {
  const index = await readIndex();
  const key = originKey(origin);

  if (rules.length === 0) {
    index.origins = index.origins.filter((o) => o !== origin);
    index.localOrigins = index.localOrigins.filter((o) => o !== origin);
    await Promise.all([
      chrome.storage.sync.remove(key),
      chrome.storage.local.remove(key),
      writeIndex(index),
    ]);
    return;
  }

  if (!index.origins.includes(origin)) index.origins.push(origin);

  const wasLocal = index.localOrigins.includes(origin);
  if (!wasLocal) {
    try {
      await chrome.storage.sync.set({ [key]: rules });
      await writeIndex(index);
      return;
    } catch (err) {
      if (!isQuotaError(err)) throw err;
      // fall through to local storage
    }
  }

  index.localOrigins = index.localOrigins.includes(origin)
    ? index.localOrigins
    : [...index.localOrigins, origin];
  await chrome.storage.local.set({ [key]: rules });
  await chrome.storage.sync.remove(key).catch(() => {});
  await writeIndex(index);
}

async function writeIndex(index: Index): Promise<void> {
  await chrome.storage.sync.set({ [INDEX_KEY]: index });
}

export async function saveDisabledOrigins(disabledOrigins: string[]): Promise<void> {
  const index = await readIndex();
  index.disabledOrigins = disabledOrigins;
  await writeIndex(index);
}
