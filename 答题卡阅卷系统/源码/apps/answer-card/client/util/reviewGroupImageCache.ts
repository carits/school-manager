/** Keep a small, version-keyed image cache; preview and navigation share in-flight work. */
export function createReviewImageCache(load: (key: string, signal: AbortSignal) => Promise<string>, release: (url: string) => void, limit = 7) {
  type Entry = { promise: Promise<string>; url?: string; controller: AbortController };
  const entries = new Map<string, Entry>();
  let active: string | null = null, generation = 0;
  const remove = (key: string, entry: Entry) => {
    entries.delete(key); entry.controller.abort(); if (entry.url) release(entry.url);
  };
  const trim = () => {
    for (const [key, entry] of entries) {
      if (entries.size <= limit) break;
      if (key !== active) remove(key,entry);
    }
  };
  return {
    setActive(key: string | null) { active = key; trim(); },
    retain(keys: string[]) {
      const keep = new Set(keys.slice(0,limit));
      if (active) keep.add(active);
      for (const [key,entry] of entries) if (!keep.has(key)) remove(key,entry);
      trim();
    },
    get(key: string): Promise<string> {
      const cached = entries.get(key);
      if (cached) { entries.delete(key); entries.set(key, cached); return cached.promise; }
      const startGeneration = generation;
      const entry: Entry = { promise: Promise.resolve(""), controller: new AbortController() };
      entry.promise = Promise.resolve().then(() => load(key,entry.controller.signal)).then(url => {
        if (generation !== startGeneration || entries.get(key)!==entry) { release(url); throw new Error("图片已离开阅卷窗口"); }
        entry.url = url; trim(); return url;
      }).catch(error => { if (entries.get(key) === entry) entries.delete(key); throw error; });
      entries.set(key, entry);
      trim();
      return entry.promise;
    },
    clear() {
      generation++; active = null;
      for (const [key,entry] of entries) remove(key,entry);
    }
  };
}
