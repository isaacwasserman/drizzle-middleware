import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { entityKind, sql } from "drizzle-orm-beta";
import { CasingCache } from "drizzle-orm-beta/casing";
import { BaseSQLiteDatabase as BaseSQLiteDatabaseBeta } from "drizzle-orm-beta/sqlite-core";
import {
	type BatchMiddleware,
	SQLITE_DRIVER_KINDS,
	withBatchMiddleware,
} from "./src/beta/sqlite-batch.ts";

type Log = string[];

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

describe("withBatchMiddleware (beta/sqlite)", () => {
	test("returns a new db instance", () => {
		const db = mockDb([]);
		const wrapped = withBatchMiddleware(db, () => ({}));
		expect(wrapped).not.toBe(db);
	});

	test("preserves $client and $cache", () => {
		const db = mockDb([]);
		db.$client = { fake: "client" };
		db.$cache = { fake: "cache" };
		const wrapped = withBatchMiddleware(db, () => ({}));
		expect(wrapped.$client).toEqual({ fake: "client" });
		expect(wrapped.$cache).toEqual({ fake: "cache" });
	});

	test("fast path: no before/after skips transaction", async () => {
		const log: Log = [];
		const db = mockDb(log);
		const wrapped = withBatchMiddleware(db, () => ({}));

		const prepared = wrapped.session.prepareQuery({
			sql: "SELECT 1",
		});
		await prepared.execute();

		expect(log).not.toContain("tx:begin");
	});

	test("before + inner concatenated into one statement", async () => {
		const log: Log = [];
		const db = mockDb(log);

		const wrapped = withBatchMiddleware(db, () => ({
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
		const wrapped = withBatchMiddleware(db, () => ({
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

		const wrapped = withBatchMiddleware(db, () => ({
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

		const wrapped = withBatchMiddleware(db, () => ({
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

		const wrapped = withBatchMiddleware(db, () => ({
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

		const wrapped = withBatchMiddleware(db, () => ({
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

		const wrapped = withBatchMiddleware(db, () => ({}));
		expect(wrapped.session.customProp).toBe("hello");
	});

	// -------------------------------------------------------------------
	// Placeholder resolution
	// -------------------------------------------------------------------

	test("placeholder values are resolved and inlined into concatenated query", async () => {
		const log: Log = [];
		const db = mockDb(log);

		const wrapped = withBatchMiddleware(db, () => ({
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

		const wrapped = withBatchMiddleware(db, () => ({
			after: [sql`SELECT 1`],
		}));

		const prepared = wrapped.session.prepareQuery({ sql: "SELECT 1" });
		const result = await prepared.execute();

		expect(result).toEqual([{ id: 1 }]);
	});

	// -------------------------------------------------------------------
	// Driver coverage drift detection
	// -------------------------------------------------------------------

	test("SQLITE_DRIVER_KINDS covers every SQLite session in drizzle-orm-beta", () => {
		const ABSTRACT_KINDS = new Set(["SQLiteSession"]);
		const sessionKinds = new Set<string>();
		const dirs = readdirSync("node_modules/drizzle-orm-beta", {
			withFileTypes: true,
		});
		for (const d of dirs) {
			if (!d.isDirectory()) continue;
			const checkPaths = [
				`node_modules/drizzle-orm-beta/${d.name}/session.js`,
				`node_modules/drizzle-orm-beta/${d.name}/sqlite/session.js`,
			];
			for (const p of checkPaths) {
				let src: string;
				try {
					src = require("node:fs").readFileSync(p, "utf8");
				} catch {
					continue;
				}
				if (
					!src.includes("SQLiteSession") &&
					!src.includes("SqliteSession") &&
					!src.includes("SQLitePreparedQuery")
				)
					continue;
				const matches = src.matchAll(
					/\[entityKind\]\s*=\s*"([^"]*Session[^"]*)"/g,
				);
				for (const m of matches) {
					if (!ABSTRACT_KINDS.has(m[1]!)) sessionKinds.add(m[1]!);
				}
			}
		}

		const covered = new Set<string>(SQLITE_DRIVER_KINDS);
		const uncovered = [...sessionKinds].filter((k) => !covered.has(k));
		const stale = [...covered].filter((k) => !sessionKinds.has(k));

		expect(uncovered).toEqual([]);
		expect(stale).toEqual([]);
	});
});
