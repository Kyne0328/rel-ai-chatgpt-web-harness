type AbortSignalInput = AbortSignal | null | undefined | readonly (AbortSignal | null | undefined)[];

function isAbortSignal(value: unknown): value is AbortSignal {
  return Boolean(value) && typeof (value as { addEventListener?: unknown }).addEventListener === 'function';
}

function combineAbortSignals(...values: AbortSignalInput[]): AbortSignal | undefined {
  const signals = values.flat().filter(isAbortSignal);
  if (signals.length === 0) return undefined;
  if (signals.length === 1) return signals[0];
  return AbortSignal.any(signals);
}

function isTimeoutAbort(signal?: AbortSignal | null): boolean {
  return signal?.aborted === true && signal.reason?.name === 'TimeoutError';
}

export { combineAbortSignals, isTimeoutAbort };
