/** A path the repo's tests live at. */
export const TEST_PATH_RES: readonly RegExp[] = [/(^|\/)__tests__\//, /(^|\/)tests?\//, /\.(test|spec)\.[a-z]+$/, /_test\.[a-z]+$/];

/** Whether repo-relative `path` is a test file by `TEST_PATH_RES`. */
export function isTestPath(path: string): boolean {
  return TEST_PATH_RES.some((re) => re.test(path));
}
