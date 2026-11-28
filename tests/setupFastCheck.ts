import { configureGlobal } from 'fast-check';

// A fixed seed makes a failing property fail the same way on every run and in every runtime, and its report prints the seed and path that replay it.
configureGlobal({ seed: 20_261_128, numRuns: 50 });
