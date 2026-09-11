// Preserve the last in-memory value if browser storage is full or disabled.
export function createStorage(getStorage, onError = () => {}) {
  const memory = new Map();
  return {
    getItem(key) {
      if (memory.has(key)) return memory.get(key);
      try { return getStorage().getItem(key); }
      catch (error) { onError(error); return null; }
    },
    setItem(key, value) {
      memory.set(key, String(value));
      try { getStorage().setItem(key, String(value)); return true; }
      catch (error) { onError(error); return false; }
    },
    removeItem(key) {
      memory.set(key, null);
      try { getStorage().removeItem(key); }
      catch (error) { onError(error); }
    },
  };
}

let warned = false;
export const storage = createStorage(() => globalThis.localStorage, () => {
  if (warned) return;
  warned = true;
  console.warn('Prompt Workbench: browser storage unavailable; changes are kept in memory.');
  globalThis.dispatchEvent?.(new Event('pwb-storage-error'));
});
