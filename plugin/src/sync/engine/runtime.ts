import { SYNC_TIMERS } from "../constants";

export async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>
) {
  if (!items.length) return;
  let index = 0;
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (true) {
      const current = index;
      index += 1;
      if (current >= items.length) return;
      await worker(items[current], current);
    }
  });
  await Promise.all(workers);
}

export async function yieldToUi() {
  await new Promise<void>((resolve) => window.setTimeout(resolve, SYNC_TIMERS.uiYieldMs));
}
