/**
 * Small helpers for building parameterised SQL.
 *
 * The store repeatedly needs "add this clause only if the caller supplied a value,
 * and keep the bound parameters lined up with it". Doing that with two parallel
 * arrays is where mismatches hide: a fragment pushed without its value, or values
 * pushed in the wrong order, both produce SQL that is syntactically fine and
 * semantically wrong.
 *
 * Binding a fragment to its values in one call makes that mismatch unrepresentable.
 */

export type SqlValue = string | number | null;

/** A SQL fragment together with the values it binds. */
interface Clause {
  readonly sql: string;
  readonly values: readonly SqlValue[];
}

/** Accumulates clauses, then renders them with their values in the right order. */
export class ClauseList {
  readonly #clauses: Clause[] = [];

  /** Append a clause. A fragment can never be added without its values. */
  add(sql: string, ...values: SqlValue[]): this {
    this.#clauses.push({ sql, values });
    return this;
  }

  /** Append only when `value` was supplied. `null` is a value; `undefined` is absence. */
  addIfDefined(sql: string, value: SqlValue | undefined): this {
    return value === undefined ? this : this.add(sql, value);
  }

  get isEmpty(): boolean {
    return this.#clauses.length === 0;
  }

  join(separator: string): string {
    return this.#clauses.map((c) => c.sql).join(separator);
  }

  get values(): SqlValue[] {
    return this.#clauses.flatMap((c) => [...c.values]);
  }
}

/** `?, ?, ?` for an IN list of the given length. */
export function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

/** Normalise a "one or many" filter field to an array. */
export function toArray<T>(value: T | readonly T[]): T[] {
  return Array.isArray(value) ? [...value] : [value as T];
}
