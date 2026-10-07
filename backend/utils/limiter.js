import * as db from '../db/db.js';

// FIFO concurrency limiter whose limit is re-read on every dispatch, so changes made
// in the admin settings apply to waiting jobs without a restart. Lowering the limit
// never interrupts running jobs; it only delays the next ones.
class Limiter {
  #active = 0;
  #queue = [];
  #getLimit;

  constructor(getLimit) {
    this.#getLimit = getLimit;
  }

  // Resolves with a release function (idempotent) once a slot is free.
  acquire() {
    return new Promise((resolve) => {
      this.#queue.push(resolve);
      this.refresh();
    });
  }

  refresh() {
    while (this.#queue.length > 0 && this.#active < this.#getLimit()) {
      this.#active++;
      let released = false;
      this.#queue.shift()(() => {
        if (released) return;
        released = true;
        this.#active--;
        this.refresh();
      });
    }
  }
}

const clampLimit = (value, fallback) =>
  Number.isInteger(value) && value >= 1 ? value : fallback;

export const downloadLimiter = new Limiter(() =>
  clampLimit(db.getSettings().maxConcurrentDownloads, 2),
);
export const mergeLimiter = new Limiter(() =>
  clampLimit(db.getSettings().maxConcurrentMerges, 1),
);

export function refreshLimiters() {
  downloadLimiter.refresh();
  mergeLimiter.refresh();
}
