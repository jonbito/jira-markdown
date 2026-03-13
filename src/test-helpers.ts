import assert from "node:assert/strict";
import {
  after,
  afterEach,
  before,
  beforeEach,
  describe,
  it,
  test
} from "node:test";
import { isDeepStrictEqual } from "node:util";

type AsyncMatcherResult = Promise<void>;

function formatValue(value: unknown): string {
  if (value instanceof Error) {
    return `${value.name}: ${value.message}`;
  }

  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function fail(message: string): never {
  throw new assert.AssertionError({
    actual: undefined,
    expected: undefined,
    message
  });
}

function matchesObject(actual: unknown, expected: unknown): boolean {
  if (expected === null || typeof expected !== "object") {
    return isDeepStrictEqual(actual, expected);
  }

  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) {
      return false;
    }

    return expected.every((item, index) => matchesObject(actual[index], item));
  }

  if (actual === null || typeof actual !== "object") {
    return false;
  }

  return Object.entries(expected).every(([key, value]) =>
    matchesObject((actual as Record<string, unknown>)[key], value)
  );
}

function containsValue(actual: unknown, expected: unknown): boolean {
  if (typeof actual === "string") {
    return actual.includes(String(expected));
  }

  if (Array.isArray(actual)) {
    return actual.some((item) => isDeepStrictEqual(item, expected));
  }

  return false;
}

function matchesPattern(actual: unknown, pattern: RegExp | string): boolean {
  if (typeof actual !== "string") {
    return false;
  }

  return typeof pattern === "string" ? actual.includes(pattern) : pattern.test(actual);
}

function hasProperty(actual: unknown, property: string): boolean {
  if (actual === null || typeof actual !== "object") {
    return false;
  }

  return property in actual;
}

function normalizeThrown(thrown: unknown): Error {
  if (thrown instanceof Error) {
    return thrown;
  }

  return new Error(String(thrown));
}

function matchesThrown(thrown: unknown, expected?: RegExp | string): boolean {
  if (expected === undefined) {
    return true;
  }

  const error = normalizeThrown(thrown);
  return typeof expected === "string"
    ? error.message.includes(expected)
    : expected.test(error.message);
}

function assertMatch(result: boolean, isNot: boolean, message: string): void {
  if (isNot ? result : !result) {
    fail(message);
  }
}

function createPromiseMatchers(
  actual: Promise<unknown>,
  mode: "rejects" | "resolves",
  isNot: boolean
): {
  toMatchObject(expected: unknown): AsyncMatcherResult;
  toThrow(expected?: RegExp | string): AsyncMatcherResult;
} {
  return {
    async toMatchObject(expected: unknown) {
      let settled:
        | { status: "resolved"; value: unknown }
        | { status: "rejected"; reason: unknown };

      try {
        settled = { status: "resolved", value: await actual };
      } catch (error) {
        settled = { status: "rejected", reason: error };
      }

      if (mode === "rejects") {
        if (settled.status !== "rejected") {
          fail(`Expected promise to reject, but it resolved to ${formatValue(settled.value)}.`);
        }

        assertMatch(
          matchesObject(settled.reason, expected),
          isNot,
          `Expected rejection ${formatValue(settled.reason)} ${isNot ? "not " : ""}to match object ${formatValue(expected)}.`
        );
        return;
      }

      if (settled.status !== "resolved") {
        fail(`Expected promise to resolve, but it rejected with ${formatValue(settled.reason)}.`);
      }

      assertMatch(
        matchesObject(settled.value, expected),
        isNot,
        `Expected ${formatValue(settled.value)} ${isNot ? "not " : ""}to match object ${formatValue(expected)}.`
      );
    },

    async toThrow(expected?: RegExp | string) {
      let settled:
        | { status: "resolved"; value: unknown }
        | { status: "rejected"; reason: unknown };

      try {
        settled = { status: "resolved", value: await actual };
      } catch (error) {
        settled = { status: "rejected", reason: error };
      }

      if (mode === "rejects") {
        if (settled.status !== "rejected") {
          fail(`Expected promise to reject, but it resolved to ${formatValue(settled.value)}.`);
        }

        assertMatch(
          matchesThrown(settled.reason, expected),
          isNot,
          `Expected rejection ${normalizeThrown(settled.reason).message} ${isNot ? "not " : ""}to match ${String(expected)}.`
        );
        return;
      }

      if (settled.status !== "resolved") {
        fail(`Expected promise to resolve, but it rejected with ${formatValue(settled.reason)}.`);
      }

      fail(`Expected resolved promise ${isNot ? "not " : ""}to throw.`);
    }
  };
}

export function expect<T>(actual: T) {
  const createMatchers = (isNot = false) => ({
    get not() {
      return createMatchers(!isNot);
    },

    get rejects() {
      return createPromiseMatchers(Promise.resolve(actual), "rejects", isNot);
    },

    get resolves() {
      return createPromiseMatchers(Promise.resolve(actual), "resolves", isNot);
    },

    toBe(expected: unknown) {
      assertMatch(
        Object.is(actual, expected),
        isNot,
        `Expected ${formatValue(actual)} ${isNot ? "not " : ""}to be ${formatValue(expected)}.`
      );
    },

    toEqual(expected: unknown) {
      assertMatch(
        isDeepStrictEqual(actual, expected),
        isNot,
        `Expected ${formatValue(actual)} ${isNot ? "not " : ""}to equal ${formatValue(expected)}.`
      );
    },

    toContain(expected: unknown) {
      assertMatch(
        containsValue(actual, expected),
        isNot,
        `Expected ${formatValue(actual)} ${isNot ? "not " : ""}to contain ${formatValue(expected)}.`
      );
    },

    toMatch(expected: RegExp | string) {
      assertMatch(
        matchesPattern(actual, expected),
        isNot,
        `Expected ${formatValue(actual)} ${isNot ? "not " : ""}to match ${String(expected)}.`
      );
    },

    toMatchObject(expected: unknown) {
      assertMatch(
        matchesObject(actual, expected),
        isNot,
        `Expected ${formatValue(actual)} ${isNot ? "not " : ""}to match object ${formatValue(expected)}.`
      );
    },

    toHaveLength(expected: number) {
      const length = (actual as { length?: unknown })?.length;
      assertMatch(
        typeof length === "number" && length === expected,
        isNot,
        `Expected ${formatValue(actual)} ${isNot ? "not " : ""}to have length ${expected}.`
      );
    },

    toHaveProperty(expected: string) {
      assertMatch(
        hasProperty(actual, expected),
        isNot,
        `Expected ${formatValue(actual)} ${isNot ? "not " : ""}to have property ${expected}.`
      );
    },

    toBeDefined() {
      assertMatch(
        actual !== undefined,
        isNot,
        `Expected value ${isNot ? "not " : ""}to be defined.`
      );
    },

    toBeUndefined() {
      assertMatch(
        actual === undefined,
        isNot,
        `Expected value ${isNot ? "not " : ""}to be undefined.`
      );
    },

    toBeGreaterThan(expected: number) {
      assertMatch(
        typeof actual === "number" && actual > expected,
        isNot,
        `Expected ${formatValue(actual)} ${isNot ? "not " : ""}to be greater than ${expected}.`
      );
    },

    toBeInstanceOf(expected: new (...args: any[]) => unknown) {
      assertMatch(
        actual instanceof expected,
        isNot,
        `Expected ${formatValue(actual)} ${isNot ? "not " : ""}to be an instance of ${expected.name}.`
      );
    },

    toThrow(expected?: RegExp | string) {
      if (typeof actual !== "function") {
        fail(`Expected ${formatValue(actual)} to be a function.`);
      }

      let threw = false;
      let thrown: unknown;

      try {
        actual();
      } catch (error) {
        threw = true;
        thrown = error;
      }

      if (!threw) {
        if (isNot) {
          return;
        }

        fail("Expected function to throw.");
      }

      assertMatch(
        matchesThrown(thrown, expected),
        isNot,
        `Expected thrown error ${normalizeThrown(thrown).message} ${isNot ? "not " : ""}to match ${String(expected)}.`
      );
    }
  });

  return createMatchers();
}

export { after, afterEach, before, beforeEach, describe, it, test };
