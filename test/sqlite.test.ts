// the applicable v1 unit tests (sqlite.test.ts), rewritten to check
// behavior on registered drivers instead of v1 internals. See MAPPING.md.

import { describe, expect, spyOn, test } from "bun:test";
import { entityKind, eq, sql } from "drizzle-orm-beta";
import { drizzle } from "drizzle-orm-beta/bun-sqlite";
import { SQLiteBunTransaction } from "drizzle-orm-beta/bun-sqlite/session";
import { LibSQLSession } from "drizzle-orm-beta/libsql/session";
import { PrismaSQLiteSession } from "drizzle-orm-beta/prisma/sqlite/session";
import {
	BaseSQLiteDatabase,
	SQLiteAsyncDialect,
	integer,
	sqliteTable,
	text,
} from "drizzle-orm-beta/sqlite-core";
import { readMember } from "../src/internal/drizzle.ts";
import { executeBatchTransaction } from "../src/pg.ts";
import { withMiddleware } from "../src/sqlite.ts";
import { driverTest } from "./helpers/drivers.ts";
import { fakePrisma } from "./helpers/fake-prisma.ts";

const t = sqliteTable("t", { id: integer("id") });
const log = sqliteTable("log", {
	n: integer("n").primaryKey({ autoIncrement: true }),
	v: text("v"),
});
const insertLog = (v: string) => sql`insert into log (v) values (${v})`;

function createDb() {
	const db = drizzle(":memory:");
	db.run(sql`create table t (id integer)`);
	db.run(sql`create table log (n integer primary key autoincrement, v text)`);
	return db;
}
const logged = (db: ReturnType<typeof createDb>) =>
	db
		.select({ v: log.v })
		.from(log)
		.orderBy(log.n)
		.all()
		.map((r) => r.v);

// A fake libSQL client. Each statement is logged with the handle that ran it:
// the main `client`, or the interactive `tx`. Both `execute` and `batch` log
// the same way, so a test checks where and in which order statements ran, not
// which libSQL method sent them. A statement's rows are `[[<its first word>]]`.
type Statement = { sql: string; args?: unknown[] };
function fakeLibsqlDb(calls: string[], args: unknown[][] = []) {
	const result = (s: Statement) => {
		args.push(s.args ?? []);
		const word = s.sql.split(" ")[0] ?? "";
		return {
			rows: [[word]],
			columns: ["v"],
			columnTypes: ["TEXT"],
			rowsAffected: 0,
			lastInsertRowid: undefined,
		};
	};
	const handle = (who: string) => ({
		execute: async (s: Statement) => {
			calls.push(`${who}: ${s.sql}`);
			return result(s);
		},
		batch: async (statements: Statement[]) =>
			statements.map((s) => {
				calls.push(`${who}: ${s.sql}`);
				return result(s);
			}),
		migrate: async (statements: Statement[]) =>
			statements.map((s) => {
				calls.push(`${who}: ${s.sql}`);
				return result(s);
			}),
	});
	const client = {
		...handle("client"),
		transaction: async () => ({
			...handle("tx"),
			commit: async () => calls.push("tx: commit"),
			rollback: async () => calls.push("tx: rollback"),
		}),
	};
	const dialect = new SQLiteAsyncDialect();
	return new (BaseSQLiteDatabase as any)(
		"async",
		dialect,
		new LibSQLSession(
			client as any,
			dialect,
			{} as any,
			undefined,
			{},
			undefined,
		),
		{},
		undefined,
	);
}

describe("withMiddleware (sqlite)", () => {
	// -------------------------------------------------------------------
	// The wrapped db
	// -------------------------------------------------------------------

	test("returns a new db instance", () => {
		const db = createDb();
		expect(withMiddleware(db, () => ({}))).not.toBe(db);
	});

	test("blocks $client", () => {
		const db = createDb();
		expect(() => withMiddleware(db, () => ({})).$client).toThrow(
			"blocked access to `$client`",
		);
		expect(db.$client).toBeDefined();
	});

	test("keeps the relational-query flags of the input db and transaction", () => {
		const db = createDb();
		const dialect = readMember(db, "dialect");
		const session = readMember(db, "session");
		const flaggedDb = new (db.constructor as any)(
			"sync",
			dialect,
			session,
			{},
			undefined,
			true,
			true,
		);
		const flaggedTx = new SQLiteBunTransaction(
			"sync",
			dialect as any,
			session as any,
			{},
			undefined,
			2,
			true,
			true,
		);
		for (const input of [flaggedDb, flaggedTx]) {
			const wrapped = withMiddleware(input, () => ({})) as any;
			expect(wrapped.rowModeRQB).toBe(true);
			expect(wrapped.forbidJsonb).toBe(true);
		}
		expect((withMiddleware(flaggedTx, () => ({})) as any).nestedIndex).toBe(2);
	});

	// -------------------------------------------------------------------
	// Queries (bun:sqlite)
	// -------------------------------------------------------------------

	test("no middleware: the query runs directly, without a transaction", () => {
		const db = createDb();
		db.insert(t).values({ id: 1 }).run();
		const transaction = spyOn(db.$client, "transaction");
		expect(
			withMiddleware(db, () => ({}))
				.select()
				.from(t)
				.all(),
		).toEqual([{ id: 1 }]);
		expect(transaction).not.toHaveBeenCalled();
	});

	test("$count runs the middleware and returns the count", async () => {
		const db = createDb();
		db.insert(t)
			.values([{ id: 1 }, { id: 2 }])
			.run();
		const wrapped = withMiddleware(db, () => ({ before: [insertLog("b")] }));
		expect(await wrapped.$count(t)).toBe(2);
		expect(logged(db)).toEqual(["b"]);
	});

	test("a wrapped open transaction runs before and after around each query, in it", () => {
		const db = createDb();
		expect(() =>
			db.transaction((tx) => {
				const wrapped = withMiddleware(tx, () => ({
					before: [insertLog("before 1"), insertLog("before 2")],
					after: [insertLog("after")],
				}));
				wrapped.run(insertLog("query"));
				expect(logged(tx as any)).toEqual([
					"before 1",
					"before 2",
					"query",
					"after",
				]);
				throw new Error("roll back the outer transaction");
			}),
		).toThrow("roll back the outer transaction");
		expect(logged(db)).toEqual([]);
	});

	test("unknown prepared-query members are blocked", () => {
		const prepared = withMiddleware(createDb(), () => ({}))
			.select()
			.from(t)
			.prepare() as unknown as Record<string, unknown>;
		expect(() => prepared.stmt).toThrow("blocked access to `stmt`");
		expect(() => prepared.allRqbV2).toThrow("blocked access to `allRqbV2`");
	});

	// -------------------------------------------------------------------
	// libSQL
	// -------------------------------------------------------------------

	driverTest("LibSQLSession")(
		"libSQL: a wrapped transaction runs every statement on it, in order",
		async () => {
			const calls: string[] = [];
			const db = fakeLibsqlDb(calls);
			await db.transaction(async (tx: any) => {
				// `LibSQLTransaction` subclasses `SQLiteTransaction`.
				expect(tx.constructor[entityKind]).toBe("LibSQLTransaction");
				const wrapped = withMiddleware(tx, () => ({
					before: [sql`INSERT INTO kv VALUES ('tenant')`],
					after: [sql`DELETE FROM kv`],
				}));
				await wrapped.select().from(t);
			});
			expect(calls).toEqual([
				"tx: INSERT INTO kv VALUES ('tenant')",
				'tx: select "id" from "t"',
				"tx: DELETE FROM kv",
				"tx: commit",
			]);
		},
	);

	driverTest("LibSQLSession")(
		"libSQL: a nested transaction on a wrapped transaction runs the middleware",
		async () => {
			const calls: string[] = [];
			const db = fakeLibsqlDb(calls);
			await db.transaction(async (tx: any) => {
				const wrapped = withMiddleware(tx, () => ({
					before: [sql`INSERT INTO kv VALUES ('tenant')`],
				}));
				await wrapped.transaction(async (savepoint: any) => {
					await savepoint.select().from(t);
				});
			});
			expect(calls).toEqual([
				"tx: savepoint sp0",
				"tx: INSERT INTO kv VALUES ('tenant')",
				'tx: select "id" from "t"',
				"tx: release savepoint sp0",
				"tx: commit",
			]);
		},
	);

	driverTest("LibSQLSession")(
		"libSQL: executeBatchTransaction on a transaction uses the transaction",
		async () => {
			const calls: string[] = [];
			const db = fakeLibsqlDb(calls);
			await db.transaction(async (tx: any) => {
				await executeBatchTransaction([tx.select().from(t)]);
			});
			expect(calls).toEqual(['tx: select "id" from "t"', "tx: commit"]);
		},
	);

	driverTest("LibSQLSession")(
		"libSQL: raw all() returns the same result as the unwrapped db",
		async () => {
			const plain = await fakeLibsqlDb([]).all(sql`select_query`);
			const wrapped = withMiddleware(fakeLibsqlDb([]), () => ({
				after: [sql`after_statement`],
			})) as any;
			expect(plain).toEqual([["select_query"]]);
			expect(await wrapped.all(sql`select_query`)).toEqual(plain);
		},
	);

	driverTest("LibSQLSession")(
		"libSQL: after-only middleware returns the query's rows",
		async () => {
			const wrapped = withMiddleware(fakeLibsqlDb([]), () => ({
				after: [sql`after_statement`],
			})) as any;
			const rows = await wrapped.select({ v: sql<string>`v` }).from(t);
			expect(rows).toEqual([{ v: "select" }]);
		},
	);

	driverTest("LibSQLSession")(
		"libSQL: each execution of a prepared query uses its own values",
		async () => {
			const calls: string[] = [];
			const args: unknown[][] = [];
			const wrapped = withMiddleware(fakeLibsqlDb(calls, args), () => ({
				before: [sql`before`],
			})) as any;
			const byId = wrapped
				.select()
				.from(t)
				.where(eq(t.id, sql.placeholder("id")))
				.prepare();
			await byId.all({ id: 1 });
			await byId.all({ id: 2 });
			// v1 inlines the value into the SQL text; v2 sends it as an argument.
			const seen = calls.map((c, i) => `${c} ${JSON.stringify(args[i])}`);
			expect(seen.filter((s) => s.includes("1")).length).toBeGreaterThan(0);
			expect(seen.filter((s) => s.includes("2")).length).toBeGreaterThan(0);
		},
	);

	driverTest("LibSQLSession")(
		"libSQL: values reach the driver as arguments, not in the SQL text",
		async () => {
			const calls: string[] = [];
			const args: unknown[][] = [];
			const wrapped = withMiddleware(fakeLibsqlDb(calls, args), () => ({
				before: [sql`select ${"tenant-value"}`],
			})) as any;
			await wrapped.select().from(t).where(eq(t.id, 42));
			expect(calls.some((c) => c.includes("tenant-value"))).toBe(false);
			expect(calls.some((c) => c.includes("42"))).toBe(false);
			expect(args).toContainEqual(["tenant-value"]);
			expect(args).toContainEqual([42]);
		},
	);

	driverTest("LibSQLSession")(
		"libSQL: db.run after another query runs its own statement",
		async () => {
			const calls: string[] = [];
			const wrapped = withMiddleware(fakeLibsqlDb(calls), () => ({
				before: [sql`select 'before'`],
			})) as any;
			await wrapped.select().from(t);
			await wrapped.run(sql`delete from sessions where id = ${5}`);
			expect(
				calls.some((c) => c.startsWith("client: delete from sessions")),
			).toBe(true);
		},
	);

	driverTest("LibSQLSession")(
		"libSQL: batch and migrate are blocked (they skip the middleware)",
		() => {
			const calls: string[] = [];
			const wrapped = withMiddleware(fakeLibsqlDb(calls), () => ({
				before: [sql`INSERT INTO kv (key, value) VALUES ('tenant', 'x')`],
			})) as any;
			for (const prop of ["batch", "migrate"]) {
				expect(() => wrapped.session[prop]([])).toThrow(
					`blocked access to \`${prop}\``,
				);
			}
			expect(calls).toEqual([]);
		},
	);

	// -------------------------------------------------------------------
	// Prisma: sequential transaction
	// -------------------------------------------------------------------

	driverTest("PrismaSQLiteSession")(
		"Prisma SQLite: runs each statement in order in a Prisma transaction",
		async () => {
			const calls: string[] = [];
			const dialect = new SQLiteAsyncDialect();
			const db = new (BaseSQLiteDatabase as any)(
				"async",
				dialect,
				new PrismaSQLiteSession(fakePrisma(calls) as any, dialect, {}),
				{},
				undefined,
			);
			const wrapped = withMiddleware(db, () => ({
				before: [sql`INSERT INTO kv (key, value) VALUES ('tenant', ${"acme"})`],
				after: [sql`DELETE FROM kv`],
			})) as any;
			expect(await wrapped.select().from(t)).toEqual([{ id: 1 }]);
			expect(await executeBatchTransaction([wrapped.select().from(t)])).toEqual(
				[[{ id: 1 }]],
			);
			const unit = [
				"begin",
				`tx: INSERT INTO kv (key, value) VALUES ('tenant', ?) ["acme"]`,
				'tx: select "id" from "t"',
				"tx: DELETE FROM kv",
				"commit",
			];
			expect(calls).toEqual([...unit, ...unit]);
		},
	);
});
