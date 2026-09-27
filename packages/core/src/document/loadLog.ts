import type { LoadWarning } from '../parse/loadWarning.ts';

// Warnings that no common reader reports, or that describe values rather than structure, leave the status intact.
const INTACT_CODES = new Set<LoadWarning['code']>(['dangling-reference', 'resources-missing', 'generation-mismatch', 'page-count-mismatch']);

/** Collects load warnings and decides whether they make the structure tolerated. */
export class LoadLog {
  readonly warnings: LoadWarning[] = [];
  tolerated = false;

  warn(warning: LoadWarning): void {
    this.warnings.push(warning);
    if (!INTACT_CODES.has(warning.code)) this.tolerated = true;
  }

  /** Records a warning about a deviation no common reader reports, which leaves the status as it is. */
  note(warning: LoadWarning): void {
    this.warnings.push(warning);
  }

  /** Runs `attempt` with its warnings held back; they are kept only if it returns. */
  attempt<T>(attempt: (warn: (warning: LoadWarning) => void) => T): T {
    const held: LoadWarning[] = [];
    const result = attempt(warning => {
      held.push(warning);
    });
    for (const warning of held) this.warn(warning);
    return result;
  }
}
