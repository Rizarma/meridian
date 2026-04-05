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

/**
 * Define a test suite (group of related tests)
 */
export function describe(name: string, fn: () => void): void {
  currentSuite = { name, tests: [] };
  fn();
  suites.push(currentSuite);
  currentSuite = null;
}

/**
 * Define a single test case
 */
export function test(name: string, fn: () => void): void {
  if (!currentSuite) {
    throw new Error("test() must be called inside describe()");
  }

  const start = Date.now();
  let passed = true;
  let error: string | undefined;

  try {
    fn();
  } catch (e) {
    passed = false;
    error = e instanceof Error ? e.message : String(e);
  }

  currentSuite.tests.push({
    name,
    passed,
    error,
    durationMs: Date.now() - start,
  });
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
  };
}

/**
 * Run all tests and print summary
 */
export function runTests(): void {
  console.log("\n" + "=".repeat(60));
  console.log("PHASE 0 CHARACTERIZATION TESTS");
  console.log("=".repeat(60) + "\n");

  let totalTests = 0;
  let passedTests = 0;
  let failedTests = 0;

  for (const suite of suites) {
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

  console.log("\n" + "=".repeat(60));
  console.log("SUMMARY");
  console.log("=".repeat(60));
  console.log(`Total:  ${totalTests}`);
  console.log(`Passed: ${passedTests} ✅`);
  console.log(`Failed: ${failedTests} ❌`);

  if (failedTests === 0) {
    console.log("\n🎉 All tests passed!");
  } else {
    console.log(`\n⚠️  ${failedTests} test(s) failed`);
    process.exit(1);
  }
}

/**
 * Reset all test state (useful for testing the harness itself)
 */
export function resetTests(): void {
  suites.length = 0;
  currentSuite = null;
}

/**
 * Get raw test results for programmatic access
 */
export function getTestResults(): TestSuite[] {
  return JSON.parse(JSON.stringify(suites));
}
