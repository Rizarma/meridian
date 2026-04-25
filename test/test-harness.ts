/**
 * Lightweight Test Harness for Phase 0 Characterization Tests
 *
 * This is a minimal test framework that documents current behavior
 * before refactoring. No external dependencies.
 */

export interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  durationMs: number;
}

export interface TestSuite {
  name: string;
  tests: TestResult[];
}

const suites: TestSuite[] = [];
let currentSuite: TestSuite | null = null;
const suiteStack: TestSuite[] = [];
const pendingSuites: Promise<void>[] = [];
const pendingTests: Promise<void>[] = [];
let executionChain: Promise<void> = Promise.resolve();

/**
 * Define a test suite (group of related tests)
 * Supports both sync and async test functions within the suite.
 */
export function describe(name: string, fn: () => void | Promise<void>): void {
  currentSuite = { name, tests: [] };

  try {
    const result = fn();
    // If fn returns a promise, we need to handle it
    // Note: In a minimal harness, we assume synchronous execution
    // For full async support, use describeAsync
    if (result && typeof result.then === "function") {
      throw new Error("Async suite functions detected. Use describeAsync() for async test suites.");
    }
  } catch (e) {
    // Re-throw to allow caller to handle
    currentSuite = null;
    throw e;
  }

  suites.push(currentSuite);
  currentSuite = null;
}

/**
 * Define an async test suite (supports async test functions)
 * This is synchronous at call site but stores the promise for later execution.
 * Use runTestsAsync() to await all pending suites before running tests.
 */
export function describeAsync(name: string, fn: () => Promise<void>): void {
  const suite: TestSuite = { name, tests: [] };

  // Store the promise to be awaited later in runTestsAsync()
  const suitePromise = (async () => {
    suiteStack.push(suite); // Push this suite onto stack
    try {
      await fn();
      // Wait for all async tests in this suite to complete
      if (pendingTests.length > 0) {
        await Promise.all(pendingTests);
        pendingTests.length = 0;
      }
      suites.push(suite);
    } finally {
      suiteStack.pop(); // Pop this suite from stack
      // Clear any remaining pending tests
      pendingTests.length = 0;
    }
  })();

  pendingSuites.push(suitePromise);
}

/**
 * Define a single test case
 * Handles both sync and async test functions by detecting Promise return values.
 */
export function test(name: string, fn: () => void | Promise<void>): void {
  if (!currentSuite) {
    throw new Error("test() must be called inside describe() or describeAsync()");
  }

  const testResult: TestResult = {
    name,
    passed: true,
    error: undefined,
    durationMs: 0,
  };
  currentSuite.tests.push(testResult);

  const testPromise = executionChain.then(async () => {
    const start = Date.now();
    try {
      await fn();
      testResult.passed = true;
    } catch (e) {
      testResult.passed = false;
      testResult.error = e instanceof Error ? e.message : String(e);
    }
    testResult.durationMs = Date.now() - start;
  });

  executionChain = testPromise.then(
    () => undefined,
    () => undefined
  );

  pendingTests.push(testPromise);
}

/**
 * Define an async test case (for use within describeAsync)
 * Synchronously registers the test, but stores async execution for later awaiting.
 */
export function testAsync(name: string, fn: () => Promise<void>): void {
  const activeSuite = suiteStack[suiteStack.length - 1]; // Get top of stack
  if (!activeSuite) {
    throw new Error("testAsync() must be called inside describeAsync()");
  }

  // Register test synchronously with placeholder result
  const testResult: TestResult = {
    name,
    passed: true,
    error: undefined,
    durationMs: 0,
  };
  activeSuite.tests.push(testResult);

  // Store the async execution to be awaited
  const testPromise = executionChain.then(async () => {
    const start = Date.now();
    try {
      await fn();
      testResult.passed = true;
    } catch (e) {
      testResult.passed = false;
      testResult.error = e instanceof Error ? e.message : String(e);
    }
    testResult.durationMs = Date.now() - start;
  });

  executionChain = testPromise.then(
    () => undefined,
    () => undefined
  );

  // Add to pending tests for this suite
  pendingTests.push(testPromise);
}

/**
 * Assertion helpers
 */
export interface Expectation {
  toBe(expected: unknown): void;
  toBeGreaterThan(n: number): void;
  toBeLessThan(n: number): void;
  toBeTruthy(): void;
  toBeFalsy(): void;
  toHaveProperty(key: string): void;
}

class AssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssertionError";
  }
}

export function expect(value: unknown): Expectation {
  return {
    toBe(expected: unknown): void {
      if (value !== expected) {
        throw new AssertionError(
          `Expected ${JSON.stringify(expected)}, but got ${JSON.stringify(value)}`
        );
      }
    },

    toBeGreaterThan(n: number): void {
      if (typeof value !== "number") {
        throw new AssertionError(`Expected number, but got ${typeof value}`);
      }
      if (!(value > n)) {
        throw new AssertionError(`Expected ${value} to be greater than ${n}`);
      }
    },

    toBeLessThan(n: number): void {
      if (typeof value !== "number") {
        throw new AssertionError(`Expected number, but got ${typeof value}`);
      }
      if (!(value < n)) {
        throw new AssertionError(`Expected ${value} to be less than ${n}`);
      }
    },

    toBeTruthy(): void {
      if (!value) {
        throw new AssertionError(`Expected ${JSON.stringify(value)} to be truthy`);
      }
    },

    toBeFalsy(): void {
      if (value) {
        throw new AssertionError(`Expected ${JSON.stringify(value)} to be falsy`);
      }
    },

    toHaveProperty(key: string): void {
      if (value == null || typeof value !== "object") {
        throw new AssertionError(`Expected object, but got ${typeof value}`);
      }
      if (!(key in (value as Record<string, unknown>))) {
        throw new AssertionError(`Expected object to have property "${key}"`);
      }
    },
  };
}

/**
 * Print test results summary
 */
function printResults(): void {
  console.log(`\n${"=".repeat(60)}`);
  console.log("PHASE 0 CHARACTERIZATION TESTS");
  console.log(`${"=".repeat(60)}\n`);

  let totalTests = 0;
  let passedTests = 0;
  let failedTests = 0;

  for (const suite of suites) {
    if (!suite) continue;
    console.log(`\n📦 ${suite.name}`);
    console.log("-".repeat(40));

    for (const test of suite.tests) {
      totalTests++;
      const icon = test.passed ? "✅" : "❌";
      const duration = test.durationMs < 10 ? "<10ms" : `${test.durationMs}ms`;

      console.log(`  ${icon} ${test.name} (${duration})`);

      if (!test.passed && test.error) {
        console.log(`     Error: ${test.error}`);
        failedTests++;
      } else if (test.passed) {
        passedTests++;
      }
    }
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log("SUMMARY");
  console.log("=".repeat(60));
  console.log(`Total:  ${totalTests}`);
  console.log(`Passed: ${passedTests} ✅`);
  console.log(`Failed: ${failedTests} ❌`);

  if (failedTests === 0) {
    console.log("\n🎉 All tests passed!");
  } else {
    console.log(`\n⚠️  ${failedTests} test(s) failed`);
  }
}

/**
 * Run all tests and print summary (synchronous version)
 * For sync tests only. Use runTestsAsync() if using describeAsync().
 */
export function runTests(): void {
  printResults();

  // Exit with error code if any tests failed
  const failedTests = suites.reduce(
    (count, suite) => count + (suite?.tests.filter((t) => !t.passed).length ?? 0),
    0
  );

  if (failedTests > 0) {
    process.exit(1);
  }
}

/**
 * Run all tests and print summary (asynchronous version)
 * Awaits all pending async suites before running tests.
 * Use this when test files use describeAsync().
 */
export async function runTestsAsync(): Promise<void> {
  // Wait for all async suites/tests to complete
  if (pendingSuites.length > 0 || pendingTests.length > 0) {
    await Promise.all([...pendingSuites, ...pendingTests]);
  }

  printResults();

  // Exit with error code if any tests failed
  const failedTests = suites.reduce(
    (count, suite) => count + (suite?.tests.filter((t) => !t.passed).length ?? 0),
    0
  );

  if (failedTests > 0) {
    process.exit(1);
  }
}

/**
 * Reset all test state (useful for testing the harness itself)
 */
export function resetTests(): void {
  suites.length = 0;
  currentSuite = null;
  suiteStack.length = 0;
  pendingSuites.length = 0;
  pendingTests.length = 0;
}

/**
 * Get raw test results for programmatic access
 */
export function getTestResults(): TestSuite[] {
  return JSON.parse(JSON.stringify(suites));
}
