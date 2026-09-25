import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { entityKind, sql } from "drizzle-orm-beta";
import { CasingCache } from "drizzle-orm-beta/casing";
import { LibSQLSession } from "drizzle-orm-beta/libsql/session";
import { PrismaSQLiteSession } from "drizzle-orm-beta/prisma/sqlite/session";
import {
	BaseSQLiteDatabase as BaseSQLiteDatabaseBeta,
	SQLiteAsyncDialect,
	SQLiteTransaction,
	integer,
	sqliteTable,
} from "drizzle-orm-beta/sqlite-core";
import {
	PREPARED_ALLOWED,
	PREPARED_DENIED,
	SESSION_ALLOWED,
	SESSION_DENIED,
} from "./src/sqlite-guard.ts";
import {
	type Middleware,
	executeBatchTransaction,
	withMiddleware,
} from "./src/sqlite.ts";
import { fakePrisma } from "./test-helpers/fake-prisma.ts";
import { reviewDrizzleMembers } from "./test-helpers/member-review.ts";

type Log = string[];

const EXPECTED_SESSION_KINDS = new Set([
	"SQLiteBunSession",
	"BetterSQLiteSession",
	"SQLJsSession",
	"SQLiteDOSession",
	"ExpoSQLiteSession",
	"OPSQLiteSession",
	"LibSQLSession",
	"SQLiteD1Session",
	"SQLiteRemoteSession",
	"SQLiteCloudSession",
	"TursoDatabaseSession",
	"BunSQLiteSession",
	"PrismaSQLiteSession",
]);

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockPreparedQuery(log: Log, id: string) {
	const pq: any = {
		execute: async () => {
			log.push(`execute:${id}`);
			return [{ id: 1 }];
		},
		all: async () => {
			log.push(`all:${id}`);
			return [{ id: 1 }];
		},
		run: async () => {
			log.push(`run:${id}`);
			return { changes: 0, lastInsertRowid: 0 };
		},
		joinsNotNullableMap: undefined as Record<string, boolean> | undefined,
		setToken(token: unknown) {
			log.push(`setToken:${id}:${String(token)}`);
			return this;
		},
	};
	return pq;
}

function createMockSession(log: Log) {
	const session: Record<string, any> = {
		prepareQuery: (...args: unknown[]) => {
			const q = args[0] as { sql?: string };
			const id = q?.sql ?? "query";
			log.push(`prepareQuery:${id}`);
			return createMockPreparedQuery(log, id);
		},
		prepareRelationalQuery: (...args: unknown[]) => {
			const q = args[0] as { sql?: string };
			const id = q?.sql ?? "relQuery";
			log.push(`prepareRelationalQuery:${id}`);
			return createMockPreparedQuery(log, id);
		},
		transaction: async (
			fn: (tx: unknown) => Promise<unknown>,
			_config?: unknown,
		) => {
			log.push("tx:begin");
			const txSession = createMockSession(log);
			const tx = { session: txSession };
			const result = await fn(tx);
			log.push("tx:end");
			return result;
		},
	};
	return session;
}

const mockDialect = {
	casing: new CasingCache(undefined),
	escapeName(name: string) {
		return `"${name}"`;
	},
	escapeParam(_num: number) {
		return "?";
	},
	escapeString(str: string) {
		return `'${str.replace(/'/g, "''")}'`;
	},
	sqlToQuery(s: any) {
		return s.toQuery({
			casing: mockDialect.casing,
			escapeName: mockDialect.escapeName,
			escapeParam: mockDialect.escapeParam,
			escapeString: mockDialect.escapeString,
		});
	},
};

function mockDb(log: Log) {
	return new (BaseSQLiteDatabaseBeta as any)(
		"async",
		mockDialect,
		createMockSession(log),
		{},
		undefined,
	);
}

function getCombinedPrepare(log: Log): string {
	const entry = log.find(
		(value) => value.startsWith("prepareQuery:") && value.includes(";\n"),
	);
	if (!entry)
		throw new Error(`No combined query found in log: ${log.join(", ")}`);
	return entry;
}

// A fake libSQL client. Each call is logged with the handle that got it: the
// main `client`, or the interactive `tx` that `client.transaction()` opens.
function fakeLibsqlClient(log: Log) {
	const resultSet = {
		rows: [],
		columns: [],
		columnTypes: [],
		rowsAffected: 0,
		lastInsertRowid: undefined,
	};
	const handle = (who: string) => ({
		execute: async (query: { sql: string }) => {
			log.push(`${who}.execute: ${query.sql}`);
			return resultSet;
		},
		batch: async (queries: { sql: string }[]) => {
			for (const q of queries) log.push(`${who}.batch: ${q.sql}`);
			return queries.map(() => resultSet);
		},
	});
	return {
		...handle("client"),
		transaction: async () => ({
			...handle("tx"),
			commit: async () => log.push("tx.commit"),
			rollback: async () => log.push("tx.rollback"),
		}),
	};
}

function fakeLibsqlDb(log: Log) {
	const dialect = new SQLiteAsyncDialect();
	return new (BaseSQLiteDatabaseBeta as any)(
		"async",
		dialect,
		new LibSQLSession(
			fakeLibsqlClient(log) as any,
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

const libsqlTable = sqliteTable("t", { id: integer("id") });

// ---------------------------------------------------------------------------
// Member review for the fail-closed guard
// ---------------------------------------------------------------------------

function reviewDrizzleSqliteMembers() {
	return reviewDrizzleMembers({
		coreDir: "sqlite-core",
		sessionBases: ["SQLiteSession"],
		preparedBases: ["SQLitePreparedQuery"],
		session: {
			allowed: SESSION_ALLOWED,
			denied: SESSION_DENIED,
			intercepted: new Set([
				"prepareQuery",
				"prepareRelationalQuery",
				"prepareOneTimeRelationalQuery",
				"transaction",
			]),
		},
		prepared: {
			allowed: PREPARED_ALLOWED,
			denied: PREPARED_DENIED,
			intercepted: new Set(["execute", "run", "all", "get", "values"]),
		},
	});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("withMiddleware (sqlite)", () => {
	test("returns a new db instance", () => {
		const db = mockDb([]);
		const wrapped = withMiddleware(db, () => ({}));
		expect(wrapped).not.toBe(db);
	});

	test("blocks $client and preserves $cache", () => {
		const db = mockDb([]);
		db.$client = { fake: "client" };
		db.$cache = { fake: "cache" };
		const wrapped = withMiddleware(db, () => ({}));
		expect(() => wrapped.$client).toThrow(
			"blocked access to `$client` on a wrapped db",
		);
		expect(wrapped.$cache).toEqual({ fake: "cache" });
		// The unwrapped db keeps its client, and a wrapped db can be wrapped.
		expect(db.$client).toEqual({ fake: "client" });
		expect(() => withMiddleware(wrapped, () => ({})).$client).toThrow(
			"blocked access to `$client`",
		);
	});

	test("fast path: no before/after skips transaction", async () => {
		const log: Log = [];
		const db = mockDb(log);
		const wrapped = withMiddleware(db, () => ({}));

		const prepared = wrapped.session.prepareQuery({
			sql: "SELECT 1",
		});
		await prepared.execute();

		expect(log).not.toContain("tx:begin");
	});

	test("before + inner concatenated into one statement", async () => {
		const log: Log = [];
		const db = mockDb(log);

		const wrapped = withMiddleware(db, () => ({
			before: [sql`SELECT 1`, sql`SELECT 2`],
		}));

		const prepared = wrapped.session.prepareQuery({
			sql: "SELECT 3",
		});
		await prepared.execute();

		expect(log).not.toContain("tx:begin");
		const combined = getCombinedPrepare(log);
		expect(combined).toContain(";\n");
	});

	test("params use ? syntax (SQLite), not $N (PG)", async () => {
		const log: Log = [];
		const db = mockDb(log);

		const tenantId = "tenant-42";
		const wrapped = withMiddleware(db, () => ({
			before: [sql`SELECT ${tenantId}`],
		}));

		const prepared = wrapped.session.prepareQuery({
			sql: "SELECT 1",
		});
		await prepared.execute();

		const combined = getCombinedPrepare(log);
		expect(combined).toContain("'tenant-42'");
		expect(combined).not.toContain("$1");
		expect(combined).not.toContain("?");
	});

	test("inner query params are inlined via dialect capture", async () => {
		const log: Log = [];
		const db = mockDb(log);

		const wrapped = withMiddleware(db, () => ({
			before: [sql`SELECT 1`],
		}));

		const innerSql = sql`SELECT * FROM users WHERE id = ${42} AND name = ${"alice"}`;
		const query = (wrapped as any).dialect.sqlToQuery(innerSql);
		const prepared = wrapped.session.prepareQuery(query);
		await prepared.execute();

		const combined = getCombinedPrepare(log);
		expect(combined).toContain("42");
		expect(combined).toContain("'alice'");
	});

	test("standalone: 3 before + inner + 3 after = 1 prepareQuery call", async () => {
		const log: Log = [];
		const db = mockDb(log);

		const wrapped = withMiddleware(db, () => ({
			before: [sql`SELECT 1`, sql`SELECT 2`, sql`SELECT 3`],
			after: [sql`SELECT 4`, sql`SELECT 5`, sql`SELECT 6`],
		}));

		const prepared = wrapped.session.prepareQuery({
			sql: "SELECT inner",
		});
		await prepared.execute();

		const combinedEntries = log.filter(
			(l) => l.startsWith("prepareQuery:") && l.includes(";\n"),
		);
		expect(combinedEntries.length).toBe(1);
	});

	test("user tx: before/after run individually", async () => {
		const log: Log = [];
		const db = mockDb(log);

		const wrapped = withMiddleware(db, () => ({
			before: [sql`SELECT 1`, sql`SELECT 2`],
			after: [sql`SELECT 3`],
		}));

		await wrapped.session.transaction(async (tx: any) => {
			log.push("user:callback");
			return "done";
		});

		const txStart = log.indexOf("tx:begin");
		const txEnd = log.indexOf("tx:end");
		const prepareCallsInTx = log.filter(
			(l, i) => i > txStart && i < txEnd && l.startsWith("prepareQuery:"),
		);
		expect(prepareCallsInTx.length).toBe(3);
	});

	test("customResultMapper is applied to the extracted result", async () => {
		const log: Log = [];
		const db = mockDb(log);

		const wrapped = withMiddleware(db, () => ({
			before: [sql`SELECT 1`],
		}));

		const mapper = (rows: any[]) =>
			rows.map((r: any) => ({ mapped: true, ...r }));

		const prepared = wrapped.session.prepareQuery(
			{ sql: "SELECT 1" },
			undefined,
			"all",
			false,
			mapper,
		);
		const result = await prepared.execute();

		expect(result).toEqual([{ mapped: true, id: 1 }]);
	});

	test("driver transactions (subclasses) are detected as tx input", async () => {
		const log: Log = [];
		const db = fakeLibsqlDb(log);

		await db.transaction(async (tx: any) => {
			// `LibSQLTransaction` subclasses `SQLiteTransaction`.
			expect(tx.constructor[entityKind]).toBe("LibSQLTransaction");
			const wrapped = withMiddleware(tx, () => ({
				before: [sql`INSERT INTO kv VALUES ('tenant')`],
				after: [sql`DELETE FROM kv`],
			}));
			await wrapped.select().from(libsqlTable);
		});

		// Everything runs on the open transaction, none on the main client.
		expect(log).toEqual([
			"tx.execute: INSERT INTO kv VALUES ('tenant')",
			'tx.execute: select "id" from "t"',
			"tx.execute: DELETE FROM kv",
			"tx.commit",
		]);
	});

	test("libSQL: nested transaction on a wrapped transaction runs the middleware", async () => {
		const log: Log = [];
		const db = fakeLibsqlDb(log);

		await db.transaction(async (tx: any) => {
			const wrapped = withMiddleware(tx, () => ({
				before: [sql`INSERT INTO kv VALUES ('tenant')`],
			}));
			await wrapped.transaction(async (savepoint: any) => {
				await savepoint.select().from(libsqlTable);
			});
		});

		expect(log).toEqual([
			"tx.execute: savepoint sp0",
			"tx.execute: INSERT INTO kv VALUES ('tenant')",
			'tx.execute: select "id" from "t"',
			"tx.execute: release savepoint sp0",
			"tx.commit",
		]);
	});

	test("Prisma SQLite: runs each statement in order in a Prisma transaction", async () => {
		const log: Log = [];
		const dialect = new SQLiteAsyncDialect();
		const db = new (BaseSQLiteDatabaseBeta as any)(
			"async",
			dialect,
			new PrismaSQLiteSession(fakePrisma(log) as any, dialect, {}),
			{},
			undefined,
		);
		const wrapped = withMiddleware(db, () => ({
			before: [sql`INSERT INTO kv (key, value) VALUES ('tenant', ${"acme"})`],
			after: [sql`DELETE FROM kv`],
		})) as any;

		expect(await wrapped.select().from(libsqlTable)).toEqual([{ id: 1 }]);
		expect(
			await executeBatchTransaction([wrapped.select().from(libsqlTable)]),
		).toEqual([[{ id: 1 }]]);

		const envelope = [
			"begin",
			`tx: INSERT INTO kv (key, value) VALUES ('tenant', ?) ["acme"]`,
			'tx: select "id" from "t"',
			"tx: DELETE FROM kv",
			"commit",
		];
		expect(log).toEqual([...envelope, ...envelope]);
	});

	test("executeBatchTransaction on a libSQL transaction uses the transaction", async () => {
		const log: Log = [];
		const db = fakeLibsqlDb(log);

		await db.transaction(async (tx: any) => {
			await executeBatchTransaction([tx.select().from(libsqlTable)]);
		});

		expect(log).toEqual(['tx.batch: select "id" from "t"', "tx.commit"]);
	});

	test("keeps the relational-query flags of the input db", () => {
		const db = new (BaseSQLiteDatabaseBeta as any)(
			"async",
			mockDialect,
			createMockSession([]),
			{},
			undefined,
			true,
			true,
		);
		const tx = new (SQLiteTransaction as any)(
			"async",
			mockDialect,
			createMockSession([]),
			{},
			undefined,
			2,
			true,
			true,
		);

		for (const input of [db, tx]) {
			const wrapped = withMiddleware(input, () => ({})) as any;
			expect(wrapped.rowModeRQB).toBe(true);
			expect(wrapped.forbidJsonb).toBe(true);
		}
		expect((withMiddleware(tx, () => ({})) as any).nestedIndex).toBe(2);
	});

	test("sync tx input: stacked layers each run once", () => {
		const log: Log = [];
		const syncPrepared = (id: string) => ({
			run: () => log.push(`run:${id}`),
			all: () => {
				log.push(`all:${id}`);
				return [{ id: 1 }];
			},
			joinsNotNullableMap: undefined,
		});
		const session = {
			prepareQuery: (query: { sql: string }) => syncPrepared(query.sql),
		};
		const txDb = new (SQLiteTransaction as any)(
			"sync",
			mockDialect,
			session,
			{},
			undefined,
			0,
		);

		const inner = withMiddleware(txDb, () => ({
			before: [sql`SELECT 'inner'`],
		}));
		const outer = withMiddleware(inner, () => ({
			before: [sql`SELECT 'outer'`],
		}));
		outer.session.prepareQuery({ sql: "SELECT 1" }).all();

		expect(log).toEqual([
			"run:SELECT 'outer'",
			"run:SELECT 'inner'",
			"all:SELECT 1",
		]);
	});

	// -------------------------------------------------------------------
	// Fail-closed member guard
	// -------------------------------------------------------------------

	test("allowed session members pass through", () => {
		const log: Log = [];
		const db = mockDb(log);
		db.session.dialect = mockDialect;
		db.session.options = { logger: "x" };

		const wrapped = withMiddleware(db, () => ({}));
		expect(wrapped.session.options).toEqual({ logger: "x" });
		expect(wrapped.session.dialect).toBe(mockDialect);
	});

	test("unknown session members are blocked", () => {
		const log: Log = [];
		const db = mockDb(log);
		db.session.client = { exec: () => log.push("client:exec") };
		db.session.customProp = "hello";

		const wrapped = withMiddleware(db, () => ({}));
		for (const prop of ["client", "customProp"]) {
			expect(() => wrapped.session[prop]).toThrow(
				`blocked access to \`${prop}\` on a wrapped session`,
			);
			expect(() =>
				Object.getOwnPropertyDescriptor(wrapped.session, prop),
			).toThrow(`blocked access to \`${prop}\``);
		}
		expect(log).toEqual([]);
	});

	test("unknown prepared-query members are blocked", () => {
		const log: Log = [];
		const db = mockDb(log);
		const wrapped = withMiddleware(db, () => ({}));

		const prepared = wrapped.session.prepareQuery({ sql: "SELECT 1" });
		expect(() => prepared.stmt).toThrow(
			"blocked access to `stmt` on a wrapped prepared query",
		);
		expect(() => prepared.allRqbV2).toThrow("blocked access to `allRqbV2`");
		expect(prepared.joinsNotNullableMap).toBeUndefined();
	});

	test("LibSQLSession.batch and migrate are blocked (they skip the middleware)", () => {
		const sent: string[] = [];
		const client = {
			batch: async (queries: { sql: string }[]) => {
				for (const q of queries) sent.push(q.sql);
				return [];
			},
			migrate: async (queries: { sql: string }[]) => {
				for (const q of queries) sent.push(q.sql);
				return [];
			},
		};

		const db = new (BaseSQLiteDatabaseBeta as any)(
			"async",
			mockDialect,
			new LibSQLSession(
				client as any,
				mockDialect as any,
				{} as any,
				undefined,
				{},
				undefined,
			),
			{},
			undefined,
		);
		const wrapped = withMiddleware(db, () => ({
			before: [sql`INSERT INTO kv (key, value) VALUES ('tenant', 'x')`],
		}));

		for (const prop of ["batch", "migrate"]) {
			expect(() => wrapped.session[prop]([])).toThrow(
				`blocked access to \`${prop}\` on a wrapped session`,
			);
		}
		expect(sent).toEqual([]);
	});

	// -------------------------------------------------------------------
	// Placeholder resolution
	// -------------------------------------------------------------------

	test("placeholder values are resolved and inlined into concatenated query", async () => {
		const log: Log = [];
		const db = mockDb(log);

		const wrapped = withMiddleware(db, () => ({
			before: [sql`SELECT 1`],
		}));

		const innerSql = sql`SELECT * FROM users WHERE id = ${sql.placeholder("userId")}`;
		const query = (wrapped as any).dialect.sqlToQuery(innerSql);
		const prepared = wrapped.session.prepareQuery(query);
		await prepared.execute({ userId: 42 });

		expect(log).not.toContain("tx:begin");
		const combined = getCombinedPrepare(log);
		expect(combined).toContain("42");
	});

	// -------------------------------------------------------------------
	// After-only extraction
	// -------------------------------------------------------------------

	test("after-only: inner result is extracted from multi-statement response", async () => {
		const log: Log = [];

		class LibSQLLikeSession {
			static [entityKind] = "LibSQLSession";

			client = {
				async batch(stmts: Array<{ sql: string; args: any[] }>) {
					return stmts.map((s, i) => [{ id: i + 1 }]);
				},
			};

			prepareQuery(...args: unknown[]) {
				const q = args[0] as { sql?: string };
				const sqlStr = q?.sql ?? "query";
				log.push(`prepareQuery:${sqlStr}`);
				const stmtCount = (sqlStr.match(/;\n/g) || []).length + 1;
				return {
					execute: async () => {
						log.push(`execute:${sqlStr}`);
						if (stmtCount > 1) {
							return Array.from({ length: stmtCount }, (_, i) => [
								{ id: i + 1 },
							]);
						}
						return [{ id: 1 }];
					},
					all: async () => {
						log.push(`all:${sqlStr}`);
						return [{ id: 1 }];
					},
					run: async () => {
						log.push(`run:${sqlStr}`);
						return { changes: 0, lastInsertRowid: 0 };
					},
					joinsNotNullableMap: undefined,
					setToken(token: unknown) {
						return this;
					},
				};
			}

			async transaction(
				fn: (tx: unknown) => Promise<unknown>,
				_config?: unknown,
			) {
				log.push("tx:begin");
				const tx = { session: new LibSQLLikeSession() };
				const result = await fn(tx);
				log.push("tx:end");
				return result;
			}
		}

		const db = new (BaseSQLiteDatabaseBeta as any)(
			"async",
			mockDialect,
			new LibSQLLikeSession(),
			{},
			undefined,
		);

		const wrapped = withMiddleware(db, () => ({
			after: [sql`SELECT 1`],
		}));

		const prepared = wrapped.session.prepareQuery({ sql: "SELECT 1" });
		const result = await prepared.execute();

		expect(result).toEqual([{ id: 1 }]);
	});

	test("covers every SQLite session in drizzle-orm-beta", () => {
		const sessionKinds = new Set<string>();
		for (const dir of readdirSync("node_modules/drizzle-orm-beta", {
			withFileTypes: true,
		})) {
			if (!dir.isDirectory()) continue;
			for (const path of [
				`node_modules/drizzle-orm-beta/${dir.name}/session.js`,
				`node_modules/drizzle-orm-beta/${dir.name}/sqlite/session.js`,
			]) {
				try {
					const source = require("node:fs").readFileSync(path, "utf8");
					if (
						!source.includes("SQLiteSession") &&
						!source.includes("SqliteSession") &&
						!source.includes("SQLitePreparedQuery")
					)
						continue;
					for (const match of source.matchAll(
						/\[entityKind\]\s*=\s*"([^"]*Session[^"]*)"/g,
					)) {
						if (match[1] !== "SQLiteSession") sessionKinds.add(match[1]!);
					}
				} catch {
					// The driver does not expose a runtime session module.
				}
			}
		}

		expect(sessionKinds).toEqual(EXPECTED_SESSION_KINDS);
	});

	test("every Drizzle SQLite session and prepared-query member is reviewed", () => {
		const { unknown, overlap, leakyMethods, classNames, unparsed } =
			reviewDrizzleSqliteMembers();
		expect(unparsed).toEqual([]);

		// The parser must find the drivers, or the checks below prove nothing.
		for (const name of [
			"SQLiteSession",
			"SQLiteBunSession",
			"LibSQLSession",
			"SQLiteD1Session",
			"LibSQLPreparedQuery",
			"PrismaSQLitePreparedQuery",
		])
			expect(classNames).toContain(name);

		// A new member must be added to the allowed or the denied list in
		// src/sqlite-guard.ts after review. Until then the guard blocks it.
		expect(unknown).toEqual([]);
		expect(overlap).toEqual([]);
		// An allowed method that is not intercepted must read only allowed
		// members, so it cannot reach the driver.
		expect(leakyMethods).toEqual([]);
	});
});
