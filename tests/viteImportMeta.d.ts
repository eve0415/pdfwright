// Vite expands an eager import.meta.glob into namespace imports of the matching modules when it transforms a test file, in every project. Its type ships with vite/client, which this repository does not depend on directly.
declare global {
  /** A module namespace object, whose toStringTag is 'Module' under ECMA-262, 10.4.6. */
  interface ModuleNamespace {
    readonly [Symbol.toStringTag]: 'Module';
  }

  interface ImportMeta {
    /** The namespace of every module matching `pattern`, relative to the importing file, keyed by that relative path. */
    glob(pattern: string, options: { eager: true }): { readonly [path: string]: ModuleNamespace };
  }
}

export {};
