import { getTransitFeed } from '../../data/transitFeeds.js';
/** Fetch only a registered region, with a deadline covering headers and JSON body. */
export function createTransitSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  timeoutMs = 20_000,
} = {}) {
  return {
    async getSnapshot(feedId, { signal } = {}) {
      if (!getTransitFeed(feedId)) throw new Error('Unknown transit region');
      const timeout = AbortSignal.timeout(timeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const response = await fetchImpl(`/api/transit/vehicles/${feedId}`, {
        signal: combined,
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) throw new Error('Transit feed unavailable');
      const maxBytes = 16 * 1024 * 1024;
      if (Number(response.headers.get('content-length')) > maxBytes) {
        void response.body?.cancel().catch(() => {});
        throw new Error('Transit response too large');
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Missing transit response');
      const cancel = () => {
        void reader.cancel().catch(() => {});
      };
      combined.addEventListener('abort', cancel, { once: true });
      let text = '',
        total = 0;
      const decoder = new TextDecoder();
      try {
        for (;;) {
          combined.throwIfAborted();
          const { done, value } = await reader.read();
          combined.throwIfAborted();
          if (done) break;
          total += value.byteLength;
          if (total > maxBytes) throw new Error('Transit response too large');
          text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
      } catch (error) {
        cancel();
        throw error;
      } finally {
        combined.removeEventListener('abort', cancel);
        reader.releaseLock();
      }
      const snapshot = JSON.parse(text);
      if (
        snapshot?.feedId !== feedId ||
        !Array.isArray(snapshot.vehicles) ||
        snapshot.vehicles.length > 15_000
      )
        throw new Error('Invalid transit snapshot');
      return {
        ...snapshot,
        stale:
          snapshot.stale === true ||
          response.headers.get('x-gev-cache') === 'STALE-ERROR',
      };
    },
  };
}
