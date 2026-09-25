// The implementation that the contract suite tests.
//
// The suite runs against v1 today. When v2 exists, point these exports at it:
// v2 must pass every contract test, including the ones marked as v1 bugs.

import { test } from "bun:test";

export type { Middleware } from "../src/pg.ts";
export { withMiddleware as withPgMiddleware } from "../src/pg.ts";
export { withMiddleware as withSqliteMiddleware } from "../src/sqlite.ts";
export { executeBatchTransaction } from "../src/index.ts";

export const IMPL: "v1" | "v2" = "v1";

/**
 * A contract test that v1 is known to fail (an audit finding). On v1 it runs
 * as `test.failing`, so it fails the suite if v1 starts to pass it without a
 * review. On v2 it is a normal test. Set CONTRACT_SHOW_V1_BUGS=1 to run them as
 * normal tests on v1 and read why each one fails.
 */
export function knownV1Bug(
	name: string,
	reason: string,
	fn: () => void | Promise<void>,
): void {
	if (IMPL === "v1" && !process.env.CONTRACT_SHOW_V1_BUGS)
		test.failing(`${name} [v1 bug: ${reason}]`, fn);
	else test(name, fn);
}
