/**
 * Side-effecting module: intercept Node's `ExperimentalWarning` for the
 * `node:sqlite` module before any other import triggers the warning.
 *
 * Why it's a separate module imported FIRST rather than inline at the top
 * of every bin entry: ESM hoists all `import` statements before any module
 * body code runs. If we put the `process.emit` override inline in cli.ts
 * after `import '@agenticmail/core'`, the `node:sqlite` load (and the
 * warning fire) happens BEFORE our override is installed. By splitting
 * the override into its own side-effecting module and importing it
 * FIRST, we guarantee Node finishes evaluating this module — which
 * installs the hook — before it starts on `@agenticmail/core`.
 *
 * Scope of the suppression: ONLY the SQLite ExperimentalWarning. Every
 * other warning (deprecations, real experimental flags the user opts
 * into, unhandled-promise alerts, etc.) is passed through to Node's
 * default printer. We don't want to globally silence warnings — that
 * hides real problems. We just don't want every end-user CLI run to
 * print four lines of "this is experimental" noise about a storage
 * engine they didn't choose.
 */

// Wrapped in a block so no module-level binding is exported. Without
// this, `originalEmit` becomes an inferred top-level type that
// references node:process internals — TS4023 forbids re-exporting
// names from external modules that aren't importable, and tsup's DTS
// step fails on that.
{
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const originalEmit = (process as any).emit.bind(process);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process as any).emit = function (name: string | symbol, ...args: unknown[]): boolean {
    if (
      name === 'warning'
      && args[0]
      && typeof args[0] === 'object'
      && 'name' in (args[0] as Record<string, unknown>)
      && (args[0] as { name: unknown }).name === 'ExperimentalWarning'
      && 'message' in (args[0] as Record<string, unknown>)
      && typeof (args[0] as { message: unknown }).message === 'string'
      && /\bSQLite\b/i.test((args[0] as { message: string }).message)
    ) {
      return false;
    }
    return originalEmit(name, ...args);
  };
}
