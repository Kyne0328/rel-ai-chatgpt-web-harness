type AbortErrorFactory = (signal: AbortSignal) => unknown;
type ResourceCleanup<T> = (value: T) => Promise<unknown> | unknown;

function throwIfAborted(signal: AbortSignal | undefined, errorFactory: AbortErrorFactory): void {
  if (signal?.aborted) throw errorFactory(signal);
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined, errorFactory: AbortErrorFactory): Promise<T> {
  return withAbortResource(promise, signal, undefined, errorFactory);
}

function withAbortResource<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  cleanup: ResourceCleanup<T> | undefined,
  errorFactory: AbortErrorFactory
): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      reject(errorFactory(signal));
    };
    promise.then(
      value => {
        signal.removeEventListener('abort', onAbort);
        if (!aborted) {
          resolve(value);
          return;
        }
        if (cleanup) {
          try {
            void Promise.resolve(cleanup(value)).catch(() => {});
          } catch {
            // Cleanup after cancellation is best-effort; cancellation already won the race.
          }
        }
      },
      error => {
        signal.removeEventListener('abort', onAbort);
        if (!aborted) reject(error);
      }
    );
    // The source has already started. Own its eventual outcome even when
    // cancellation won before this wrapper was called.
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
}

export { throwIfAborted, withAbort, withAbortResource };
