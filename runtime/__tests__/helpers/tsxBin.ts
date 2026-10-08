/** The build runtime runs its TypeScript on Node's own type stripping, so a self-test spawns the
 *  running node binary on a `.ts` file directly. Named TSX_BIN to keep the ported tests' call sites. */
export const TSX_BIN = process.execPath;
