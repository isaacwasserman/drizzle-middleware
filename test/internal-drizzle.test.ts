import { describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { entityKind, sql } from "drizzle-orm-beta";
import { drizzle as bunSqlite } from "drizzle-orm-beta/bun-sqlite";
import { Cache } from "drizzle-orm-beta/cache/core";
import { drizzle as pglite } from "drizzle-orm-beta/pglite";
import {
	DrizzleInternalsError,
	asDrizzleDb,
	asDrizzleSession,
	asPreparedQuery,
	entityKindOf,
	extendsEntityKind,
	hasQueryCache,
	readMember,
	sessionKindOf,
} from "../src/internal/drizzle.ts";

class MemoryCache extends Cache {
	static override readonly [entityKind]: string = "MemoryCache";
	strategy(): "all" {
		return "all";
	}
	override async get(): Promise<undefined> {
		return undefined;
	}
	override async put(): Promise<void> {}
	override async onMutate(): Promise<void> {}
}

describe("Drizzle internals boundary", () => {
	test("accepts real Postgres and SQLite dbs and sessions", () => {
		for (const db of [
			pglite({ client: new PGlite() }),
			bunSqlite(":memory:"),
		]) {
			const checked = asDrizzleDb(db);
			expect(readMember(db, "session")).toBe(checked.session);
			expect(asDrizzleSession(readMember(db, "session"))).toBe(checked.session);
		}
	});

	test("rejects values without the expected shape", () => {
		for (const value of [undefined, null, 1, "db", {}, { session: {} }]) {
			expect(() => asDrizzleDb(value)).toThrow(DrizzleInternalsError);
		}
		expect(() =>
			asDrizzleSession({ prepareQuery() {}, transaction() {}, dialect: {} }),
		).toThrow("dialect has no sqlToQuery()");
		expect(() => asDrizzleSession({ transaction() {} })).toThrow(
			"session has no prepareQuery() or transaction()",
		);
		expect(() => asPreparedQuery({})).toThrow(
			"prepared query has no execute()",
		);
	});

	test("the error says the Drizzle version is not supported", () => {
		expect(() => asDrizzleDb({})).toThrow(
			"drizzle-middleware: unexpected Drizzle internals (session has no prepareQuery() or transaction()). This Drizzle version is not supported.",
		);
	});

	test("reads a prepared query from a real session", () => {
		const db = asDrizzleDb(pglite({ client: new PGlite() }));
		const prepared = db.session.prepareQuery(
			db.dialect.sqlToQuery(sql`select 1`),
		);
		expect(asPreparedQuery(prepared)).toBe(prepared);
	});

	test("reads entity kinds", () => {
		const db = asDrizzleDb(pglite({ client: new PGlite() }));
		expect(entityKindOf(db.session)).toBe("PgliteSession");
		expect(sessionKindOf(db.session)).toBe("PgliteSession");
		expect(entityKindOf({})).toBeUndefined();
		expect(entityKindOf(undefined)).toBeUndefined();
	});

	test("detects driver transactions through the prototype chain", async () => {
		const pg = pglite({ client: new PGlite() });
		await pg.transaction(async (tx) => {
			expect(entityKindOf(tx)).toBe("PgliteTransaction");
			expect(extendsEntityKind(tx, "PgAsyncTransaction")).toBe(true);
		});
		expect(extendsEntityKind(pg, "PgAsyncTransaction")).toBe(false);

		const lite = bunSqlite(":memory:");
		lite.transaction((tx) => {
			expect(entityKindOf(tx)).toBe("SQLiteBunTransaction");
			expect(extendsEntityKind(tx, "SQLiteTransaction")).toBe(true);
		});
		expect(extendsEntityKind(lite, "SQLiteTransaction")).toBe(false);
		expect(extendsEntityKind(null, "SQLiteTransaction")).toBe(false);
	});

	test("detects a Drizzle query cache", () => {
		const sessionOf = (db: unknown) => asDrizzleDb(db).session;
		expect(hasQueryCache(sessionOf(pglite({ client: new PGlite() })))).toBe(
			false,
		);
		const cached = pglite({ client: new PGlite(), cache: new MemoryCache() });
		expect(hasQueryCache(sessionOf(cached))).toBe(true);
		expect(hasQueryCache(sessionOf(bunSqlite(":memory:")))).toBe(false);
	});

	test("readMember returns undefined for non-objects", () => {
		expect(readMember(undefined, "x")).toBeUndefined();
		expect(readMember(1, "x")).toBeUndefined();
		expect(readMember({ x: 2 }, "x")).toBe(2);
	});
});
