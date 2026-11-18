/** Combine request cancellation and deadlines on older camera-capable browsers. */
export function combineSignals(signals: readonly AbortSignal[]): AbortSignal {
  if (typeof AbortSignal.any === "function")
    return AbortSignal.any([...signals]);
  const controller = new AbortController();
  const callbacks = new Map<AbortSignal, () => void>();
  const dispose = () => {
    for (const [signal, callback] of callbacks)
      signal.removeEventListener("abort", callback);
    callbacks.clear();
  };
  for (const signal of new Set(signals)) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      dispose();
      break;
    }
    const abort = () => {
      controller.abort(signal.reason);
      dispose();
    };
    callbacks.set(signal, abort);
    signal.addEventListener("abort", abort, { once: true });
  }
  return controller.signal;
}
