// The fail-closed guard's member lists, reviewed against the installed
// Drizzle. A member that Drizzle adds must be put on the allowed or the denied
// list after review; until then the guard blocks it.

import { describe, expect, test } from "bun:test";
import { PG_RULES, SQLITE_RULES } from "../src/core/unit.ts";
import { SESSION_INTERCEPTED, preparedIntercepted } from "../src/core/wrap.ts";
import * as pg from "../src/pg-guard.ts";
import * as sqlite from "../src/sqlite-guard.ts";
import { reviewDrizzleMembers } from "./helpers/member-review.ts";

describe("guard member lists", () => {
	test("every Drizzle Postgres session and prepared-query member is reviewed", () => {
		const review = reviewDrizzleMembers({
			coreDir: "pg-core",
			sessionBases: ["PgAsyncSession"],
			preparedBases: ["PgAsyncPreparedQuery"],
			// The Effect classes extend these directly and are not supported.
			sessionAncestors: ["PgSession"],
			preparedAncestors: ["PgBasePreparedQuery"],
			session: {
				allowed: pg.SESSION_ALLOWED,
				denied: pg.SESSION_DENIED,
				intercepted: SESSION_INTERCEPTED,
			},
			prepared: {
				allowed: pg.PREPARED_ALLOWED,
				denied: pg.PREPARED_DENIED,
				intercepted: preparedIntercepted(PG_RULES),
			},
		});
		expect(review.unparsed).toEqual([]);
		// The parser must find the drivers, or the checks below prove nothing.
		for (const name of [
			"PgAsyncSession",
			"NodePgSession",
			"NeonHttpSession",
			"PostgresJsPreparedQuery",
			"PglitePreparedQuery",
		])
			expect(review.classNames).toContain(name);
		expect(review.unknown).toEqual([]);
		expect(review.overlap).toEqual([]);
		// An allowed method that is not intercepted must read only allowed
		// members, so it cannot reach the driver.
		expect(review.leakyMethods).toEqual([]);
	});

	test("every Drizzle SQLite session and prepared-query member is reviewed", () => {
		const review = reviewDrizzleMembers({
			coreDir: "sqlite-core",
			sessionBases: ["SQLiteSession"],
			preparedBases: ["SQLitePreparedQuery"],
			session: {
				allowed: sqlite.SESSION_ALLOWED,
				denied: sqlite.SESSION_DENIED,
				intercepted: SESSION_INTERCEPTED,
			},
			prepared: {
				allowed: sqlite.PREPARED_ALLOWED,
				denied: sqlite.PREPARED_DENIED,
				intercepted: preparedIntercepted(SQLITE_RULES),
			},
		});
		expect(review.unparsed).toEqual([]);
		for (const name of [
			"SQLiteSession",
			"SQLiteBunSession",
			"LibSQLSession",
			"SQLiteD1Session",
			"LibSQLPreparedQuery",
			"PrismaSQLitePreparedQuery",
		])
			expect(review.classNames).toContain(name);
		expect(review.unknown).toEqual([]);
		expect(review.overlap).toEqual([]);
		expect(review.leakyMethods).toEqual([]);
	});
});
