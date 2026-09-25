// The implementation that the contract suite tests: v1 by default, or v2 with
// CONTRACT_IMPL=v2. v2 must pass every contract test, including the ones
// marked as v1 bugs.

import { test } from "bun:test";
import { executeBatchTransaction as v1Batch } from "../src/index.ts";
import { withMiddleware as v1Pg } from "../src/pg.ts";
import { withMiddleware as v1Sqlite } from "../src/sqlite.ts";
import {
	executeBatchTransaction as v2Batch,
	withMiddleware as v2Pg,
} from "../src/v2/pg.ts";
import { withMiddleware as v2Sqlite } from "../src/v2/sqlite.ts";

export type { Middleware } from "../src/pg.ts";

export const IMPL: "v1" | "v2" =
	process.env.CONTRACT_IMPL === "v2" ? "v2" : "v1";

// The tests use v1's signatures; v2 accepts the same dbs.
export const withPgMiddleware: typeof v1Pg =
	IMPL === "v2" ? (v2Pg as unknown as typeof v1Pg) : v1Pg;
export const withSqliteMiddleware: typeof v1Sqlite =
	IMPL === "v2" ? (v2Sqlite as unknown as typeof v1Sqlite) : v1Sqlite;
export const executeBatchTransaction: typeof v1Batch =
	IMPL === "v2" ? (v2Batch as unknown as typeof v1Batch) : v1Batch;

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
