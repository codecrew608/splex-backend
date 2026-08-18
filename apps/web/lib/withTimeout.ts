// try/catch/finally only runs once an awaited promise settles — it does
// nothing if the underlying fetch never settles at all (a connection that
// hangs rather than failing outright; browsers' fetch() has no default
// timeout). That's a distinct failure mode from a thrown/rejected error,
// and it's the one class of failure that could leave a "Creating
// account..."-style button stuck forever even with correct try/catch/
// finally around it. Race against a timeout so every awaited auth call
// has a hard upper bound regardless of why the network call is stuck.
export function withTimeout<T>(promise: Promise<T>, ms: number, message = "Request timed out. Please try again."): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(message)), ms);
    }),
  ]);
}
