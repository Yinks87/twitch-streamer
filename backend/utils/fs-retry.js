import fs from 'node:fs';

// Windows refuses to rename a file that another process (or a just-finished HTTP
// response stream, e.g. the video preview) still has an open handle on — retry a
// few times with a short backoff instead of crashing the whole process.
export async function renameWithRetry(src, dest, attempts = 10, delayMs = 300) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      fs.renameSync(src, dest);
      return;
    } catch (err) {
      const retryable = err.code === 'EPERM' || err.code === 'EBUSY';
      if (!retryable || attempt === attempts) throw err;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}
