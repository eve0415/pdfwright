/** The runtimes the suite runs in, one Vitest project each. */
export type Runtime = 'browser' | 'bun' | 'deno' | 'node' | 'workers';

declare module 'vitest' {
  interface ProvidedContext {
    /** The runtime the project that runs a test file is configured for. */
    runtime: Runtime;
  }
}
