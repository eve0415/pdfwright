/** Thrown when a token reaches the end of a window that is not the end of the source; the caller retries with a larger window. */
export class WindowEndError extends Error {
  constructor() {
    super('the window ends before the token does');
    this.name = 'WindowEndError';
  }
}
