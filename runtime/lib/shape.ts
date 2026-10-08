/**
 * A type-guard validator over one parsed value: each guard returns the value when it has the wanted
 * type, or records an issue and returns a fallback, so a caller reads every field and reports every
 * bad path at once. Pure, imports nothing: a consumer that imports a parser built on it pulls in this
 * file and nothing else.
 */

export interface ShapeIssue {
  /** 1-based line in a parsed text; absent for a whole-value or JSON problem. */
  line?: number;
  message: string;
}

/** Collects type-guard issues over one value. Every issue reads `<label> <path>: expected <want>`. */
export class Shape {
  readonly #label: string;
  readonly #issues: ShapeIssue[] = [];

  constructor(label: string) {
    this.#label = label;
  }

  bad(path: string, want: string): void {
    this.#issues.push({ message: `${this.#label} ${path}: expected ${want}` });
  }

  obj(v: unknown, path: string): Record<string, unknown> | null {
    if (typeof v === "object" && v !== null && !Array.isArray(v)) return v as Record<string, unknown>;
    this.bad(path, "an object");
    return null;
  }

  arr(v: unknown, path: string): unknown[] {
    if (Array.isArray(v)) return v;
    this.bad(path, "an array");
    return [];
  }

  str(v: unknown, path: string): string {
    if (typeof v === "string") return v;
    this.bad(path, "a string");
    return "";
  }

  optStr(o: Record<string, unknown>, key: string, path: string): string | undefined {
    return o[key] === undefined ? undefined : this.str(o[key], `${path}.${key}`);
  }

  int(v: unknown, path: string): number {
    if (Number.isInteger(v) && (v as number) >= 0) return v as number;
    this.bad(path, "a non-negative integer");
    return 0;
  }

  bool(v: unknown, path: string): boolean {
    if (typeof v === "boolean") return v;
    this.bad(path, "a boolean");
    return false;
  }

  oneOf<T extends string>(v: unknown, allowed: readonly T[], path: string): T {
    if (typeof v === "string" && (allowed as readonly string[]).includes(v)) return v as T;
    this.bad(path, `one of ${allowed.join(" | ")}`);
    return allowed[0]!;
  }

  strs(v: unknown, path: string): string[] {
    return this.arr(v, path).map((x, i) => this.str(x, `${path}[${i}]`));
  }

  /** A copy of the issues so far, in order; empty when every check passed. */
  issues(): ShapeIssue[] {
    return this.#issues.map((i) => ({ ...i }));
  }
}
