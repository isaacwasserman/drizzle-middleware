import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { entityKind, sql } from "drizzle-orm-beta";
import { CasingCache } from "drizzle-orm-beta/casing";
import { BaseSQLiteDatabase as BaseSQLiteDatabaseBeta } from "drizzle-orm-beta/sqlite-core";
import { type Middleware, withMiddleware } from "./src/sqlite.ts";

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("withMiddleware (sqlite)", () => {
	test("returns a new db instance", () => {
		const db = mockDb([]);
		const wrapped = withMiddleware(db, () => ({}));
		expect(wrapped).not.toBe(db);
	});

	test("preserves $client and $cache", () => {
		const db = mockDb([]);
		db.$client = { fake: "client" };
		db.$cache = { fake: "cache" };
		const wrapped = withMiddleware(db, () => ({}));
		expect(wrapped.$client).toEqual({ fake: "client" });
		expect(wrapped.$cache).toEqual({ fake: "cache" });
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

	test("non-intercepted session properties pass through", () => {
		const log: Log = [];
		const db = mockDb(log);
		db.session.customProp = "hello";

		const wrapped = withMiddleware(db, () => ({}));
		expect(wrapped.session.customProp).toBe("hello");
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
});
