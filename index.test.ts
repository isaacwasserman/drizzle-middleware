import { describe, expect, test } from "bun:test";

import { MySqlDatabase } from "drizzle-orm/mysql-core/db";
// Stable DB classes
import { PgDatabase } from "drizzle-orm/pg-core/db";
import { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core/db";

import { MySqlDatabase as MySqlDatabaseBeta } from "drizzle-orm-beta/mysql-core";
// Beta DB classes
import { PgAsyncDatabase } from "drizzle-orm-beta/pg-core";
import { BaseSQLiteDatabase as BaseSQLiteDatabaseBeta } from "drizzle-orm-beta/sqlite-core";

import { withMiddleware as withStableMysql } from "./src/mysql.ts";
// Stable withMiddleware
import { withMiddleware as withStablePg } from "./src/pg.ts";
import { withMiddleware as withStableSqlite } from "./src/sqlite.ts";

import { withMiddleware as withBetaMysql } from "./src/beta/mysql.ts";
// Beta withMiddleware
import { withMiddleware as withBetaPg } from "./src/beta/pg.ts";
import { withMiddleware as withBetaSqlite } from "./src/beta/sqlite.ts";

type Log = string[];

// ---------------------------------------------------------------------------
// Shared mock helpers
// ---------------------------------------------------------------------------

function createMockPreparedQuery(
	log: Log,
	id: string,
	opts?: { hasSetToken?: boolean },
) {
	const pq: any = {
		execute: async (placeholderValues?: Record<string, unknown>) => {
			log.push(`execute:${id}`);
			return [{ id: 1 }];
		},
		joinsNotNullableMap: undefined as Record<string, boolean> | undefined,
	};
	if (opts?.hasSetToken !== false) {
		pq.setToken = function (token: unknown) {
			log.push(`setToken:${id}:${String(token)}`);
			return this;
		};
	}
	return pq;
}

function createMockSession(
	log: Log,
	opts?: { hasSetToken?: boolean; relationalQuery?: boolean },
) {
	const session: Record<string, any> = {
		prepareQuery: (...args: unknown[]) => {
			const id = (args[0] as { sql?: string })?.sql ?? "query";
			log.push(`prepareQuery:${id}`);
			return createMockPreparedQuery(log, id, opts);
		},
		transaction: async (
			fn: (tx: unknown) => Promise<unknown>,
			_config?: unknown,
		) => {
			log.push("tx:begin");
			const txSession = createMockSession(log, opts);
			const tx = { session: txSession };
			const result = await fn(tx);
			log.push("tx:end");
			return result;
		},
	};
	if (opts?.relationalQuery) {
		session.prepareRelationalQuery = (...args: unknown[]) => {
			const id = (args[0] as { sql?: string })?.sql ?? "relQuery";
			log.push(`prepareRelationalQuery:${id}`);
			return createMockPreparedQuery(log, id, opts);
		};
	}
	return session;
}

function createSyncMockSession(log: Log) {
	return {
		prepareQuery: (...args: unknown[]) => {
			const id = (args[0] as { sql?: string })?.sql ?? "query";
			log.push(`prepareQuery:${id}`);
			return {
				execute: (placeholderValues?: Record<string, unknown>) => {
					log.push(`execute:${id}`);
					return [{ id: 1 }];
				},
				joinsNotNullableMap: undefined as Record<string, boolean> | undefined,
			};
		},
		transaction: (fn: (tx: unknown) => unknown, _config?: unknown) => {
			log.push("tx:begin");
			const txSession = createSyncMockSession(log);
			const tx = { session: txSession };
			const result = fn(tx);
			log.push("tx:end");
			return result;
		},
	};
}

// ---------------------------------------------------------------------------
// Variant definitions
// ---------------------------------------------------------------------------

interface AsyncVariant {
	name: string;
	dialect: "pg" | "mysql" | "sqlite";
	createDb: (session: any) => any;
	withMiddleware: (db: any, mw: any) => any;
	hasSetToken: boolean;
	hasRelationalQuery: boolean;
}

interface SyncVariant {
	name: string;
	createDb: (session: any) => any;
	withMiddleware: (db: any, mw: any) => any;
}

const asyncVariants: AsyncVariant[] = [
	{
		name: "stable/pg",
		dialect: "pg",
		createDb: (s) => new (PgDatabase as any)({}, s, undefined),
		withMiddleware: withStablePg,
		hasSetToken: true,
		hasRelationalQuery: false,
	},
	{
		name: "beta/pg",
		dialect: "pg",
		createDb: (s) => new (PgAsyncDatabase as any)({}, s, {}, undefined),
		withMiddleware: withBetaPg,
		hasSetToken: true,
		hasRelationalQuery: true,
	},
	{
		name: "stable/mysql",
		dialect: "mysql",
		createDb: (s) => new (MySqlDatabase as any)({}, s, undefined, "default"),
		withMiddleware: withStableMysql,
		hasSetToken: false,
		hasRelationalQuery: false,
	},
	{
		name: "beta/mysql",
		dialect: "mysql",
		createDb: (s) =>
			new (MySqlDatabaseBeta as any)({}, s, {}, undefined, "default"),
		withMiddleware: withBetaMysql,
		hasSetToken: false,
		hasRelationalQuery: true,
	},
	{
		name: "stable/sqlite-async",
		dialect: "sqlite",
		createDb: (s) => new (BaseSQLiteDatabase as any)("async", {}, s, undefined),
		withMiddleware: withStableSqlite,
		hasSetToken: false,
		hasRelationalQuery: false,
	},
	{
		name: "beta/sqlite-async",
		dialect: "sqlite",
		createDb: (s) =>
			new (BaseSQLiteDatabaseBeta as any)("async", {}, s, {}, undefined),
		withMiddleware: withBetaSqlite,
		hasSetToken: false,
		hasRelationalQuery: true,
	},
];

const syncVariants: SyncVariant[] = [
	{
		name: "stable/sqlite-sync",
		createDb: (s) => new (BaseSQLiteDatabase as any)("sync", {}, s, undefined),
		withMiddleware: withStableSqlite,
	},
	{
		name: "beta/sqlite-sync",
		createDb: (s) =>
			new (BaseSQLiteDatabaseBeta as any)("sync", {}, s, {}, undefined),
		withMiddleware: withBetaSqlite,
	},
];

// ---------------------------------------------------------------------------
// Async test matrix
// ---------------------------------------------------------------------------

for (const v of asyncVariants) {
	describe(`withMiddleware (${v.name})`, () => {
		function mockDb(log: Log) {
			return v.createDb(
				createMockSession(log, {
					hasSetToken: v.hasSetToken,
					relationalQuery: v.hasRelationalQuery,
				}),
			);
		}

		test("returns a new db instance, not the original", () => {
			const db = mockDb([]);
			const wrapped = v.withMiddleware(db, (next: any) => next());
			expect(wrapped).not.toBe(db);
		});

		test("preserves $client on the wrapped db", () => {
			const db = mockDb([]);
			db.$client = { fake: "client" };
			const wrapped = v.withMiddleware(db, (next: any) => next());
			expect(wrapped.$client).toEqual({ fake: "client" });
		});

		test("preserves $cache on the wrapped db", () => {
			const db = mockDb([]);
			db.$cache = { invalidate: () => {} };
			const wrapped = v.withMiddleware(db, (next: any) => next());
			expect(wrapped.$cache).toBeDefined();
		});

		test("middleware runs around a prepared query execute", async () => {
			const log: Log = [];
			const db = mockDb(log);

			const wrapped = v.withMiddleware(db, async (next: any, _tx: any) => {
				log.push("middleware:before");
				const result = await next();
				log.push("middleware:after");
				return result;
			});
			const session = wrapped.session;
			const prepared = session.prepareQuery({ sql: "SELECT 1" });
			await prepared.execute();

			expect(log).toEqual([
				"prepareQuery:SELECT 1",
				"tx:begin",
				"middleware:before",
				"prepareQuery:SELECT 1",
				"execute:SELECT 1",
				"middleware:after",
				"tx:end",
			]);
		});

		test("middleware receives the transaction object", async () => {
			const log: Log = [];
			const db = mockDb(log);
			let receivedTx: unknown = null;

			const wrapped = v.withMiddleware(db, async (next: any, tx: any) => {
				receivedTx = tx;
				return next();
			});
			const session = wrapped.session;
			const prepared = session.prepareQuery({ sql: "SELECT 1" });
			await prepared.execute();

			expect(receivedTx).not.toBeNull();
			expect((receivedTx as any).session).toBeDefined();
		});

		test("middleware wraps db.transaction() calls", async () => {
			const log: Log = [];
			const db = mockDb(log);

			const wrapped = v.withMiddleware(db, async (next: any, _tx: any) => {
				log.push("middleware:before");
				const result = await next();
				log.push("middleware:after");
				return result;
			});
			const session = wrapped.session;
			await session.transaction(async (tx: unknown) => {
				log.push("user:callback");
				return "done";
			});

			expect(log).toEqual([
				"tx:begin",
				"middleware:before",
				"user:callback",
				"middleware:after",
				"tx:end",
			]);
		});

		test("middleware can modify the result of a query", async () => {
			const db = mockDb([]);

			const wrapped = v.withMiddleware(db, async (next: any) => {
				const result = await next();
				return [...(result as any[]), { id: 999, injected: true }];
			});
			const session = wrapped.session;
			const prepared = session.prepareQuery({ sql: "SELECT 1" });
			const result = await prepared.execute();

			expect(result).toEqual([{ id: 1 }, { id: 999, injected: true }]);
		});

		test("middleware can short-circuit and skip the query", async () => {
			const log: Log = [];
			const db = mockDb(log);

			const wrapped = v.withMiddleware(db, async (_next: any) => {
				log.push("middleware:short-circuit");
				return [{ cached: true }];
			});
			const session = wrapped.session;
			const prepared = session.prepareQuery({ sql: "SELECT 1" });
			const result = await prepared.execute();

			expect(result).toEqual([{ cached: true }]);
			expect(log).not.toContain("execute:SELECT 1");
		});

		test("middleware can throw and the error propagates", async () => {
			const db = mockDb([]);

			const wrapped = v.withMiddleware(db, async () => {
				throw new Error("denied");
			});
			const session = wrapped.session;
			const prepared = session.prepareQuery({ sql: "SELECT 1" });

			expect(prepared.execute()).rejects.toThrow("denied");
		});

		test("joinsNotNullableMap is copied to the re-prepared query", async () => {
			const log: Log = [];
			const db = mockDb(log);

			const wrapped = v.withMiddleware(db, (next: any) => next());
			const session = wrapped.session;
			const prepared = session.prepareQuery({ sql: "SELECT 1" });
			prepared.joinsNotNullableMap = { users: true, posts: false };

			await prepared.execute();

			expect(log).toContain("prepareQuery:SELECT 1");
		});

		test("non-intercepted session properties pass through", () => {
			const log: Log = [];
			const db = mockDb(log);
			db.session.customProp = "hello";

			const wrapped = v.withMiddleware(db, (next: any) => next());
			expect(wrapped.session.customProp).toBe("hello");
		});

		test("chained middlewares: first-applied wraps outermost", async () => {
			const log: Log = [];
			const db = mockDb(log);

			const first = async (next: any) => {
				log.push("first:before");
				const r = await next();
				log.push("first:after");
				return r;
			};

			const second = async (next: any) => {
				log.push("second:before");
				const r = await next();
				log.push("second:after");
				return r;
			};

			const wrapped = v.withMiddleware(v.withMiddleware(db, first), second);
			const session = wrapped.session;
			const prepared = session.prepareQuery({ sql: "Q" });
			await prepared.execute();

			const middlewareLogs = log.filter(
				(l) => l.startsWith("first:") || l.startsWith("second:"),
			);
			expect(middlewareLogs).toEqual([
				"first:before",
				"second:before",
				"second:after",
				"first:after",
			]);
		});

		test("session.execute() is intercepted via transitive this.prepareQuery()", async () => {
			const log: Log = [];

			const session = {
				prepareQuery(...args: unknown[]) {
					const id = (args[0] as { sql?: string })?.sql ?? "query";
					log.push(`prepareQuery:${id}`);
					return createMockPreparedQuery(log, id, {
						hasSetToken: v.hasSetToken,
					});
				},
				execute(query: { sql: string }) {
					const prepared = this.prepareQuery(query);
					return prepared.execute();
				},
				async transaction(
					fn: (tx: unknown) => Promise<unknown>,
					_config?: unknown,
				) {
					log.push("tx:begin");
					const txSession = createMockSession(log, {
						hasSetToken: v.hasSetToken,
					});
					const tx = { session: txSession };
					const result = await fn(tx);
					log.push("tx:end");
					return result;
				},
			};

			const db = v.createDb(session);
			const wrapped = v.withMiddleware(db, async (next: any, _tx: any) => {
				log.push("middleware:before");
				const result = await next();
				log.push("middleware:after");
				return result;
			});
			await wrapped.session.execute({ sql: "SELECT raw" });

			expect(log).toContain("middleware:before");
			expect(log).toContain("middleware:after");
		});

		test("transaction config is forwarded", async () => {
			let receivedConfig: unknown = null;
			const log: Log = [];

			const session = {
				prepareQuery: (...args: unknown[]) =>
					createMockPreparedQuery(log, "q", {
						hasSetToken: v.hasSetToken,
					}),
				transaction: async (
					fn: (tx: unknown) => Promise<unknown>,
					config?: unknown,
				) => {
					receivedConfig = config;
					const tx = {
						session: createMockSession(log, {
							hasSetToken: v.hasSetToken,
						}),
					};
					return fn(tx);
				},
			};

			const db = v.createDb(session);
			const wrapped = v.withMiddleware(db, (next: any) => next());

			const txConfig = { isolationLevel: "serializable" };
			await wrapped.session.transaction(async () => "ok", txConfig);

			expect(receivedConfig).toEqual(txConfig);
		});

		// -----------------------------------------------------------------------
		// Conditional: setToken
		// -----------------------------------------------------------------------

		if (v.hasSetToken) {
			test("setToken is forwarded to the re-prepared query inside the tx", async () => {
				const log: Log = [];
				const db = mockDb(log);
				const wrapped = v.withMiddleware(db, (next: any) => next());

				const session = wrapped.session;
				const prepared = session.prepareQuery({ sql: "SELECT 1" });
				prepared.setToken("my-token");
				await prepared.execute();

				expect(log).toContain("setToken:SELECT 1:my-token");
			});
		} else {
			test("works without setToken", async () => {
				const log: Log = [];
				const db = mockDb(log);
				const wrapped = v.withMiddleware(db, (next: any) => next());

				const session = wrapped.session;
				const prepared = session.prepareQuery({ sql: "SELECT 1" });

				expect(prepared.setToken).toBeUndefined();
				await prepared.execute();

				expect(log).toContain("execute:SELECT 1");
				expect(log.filter((l) => l.startsWith("setToken:"))).toHaveLength(0);
			});
		}

		// -----------------------------------------------------------------------
		// Conditional: MySQL mode preservation
		// -----------------------------------------------------------------------

		if (v.dialect === "mysql") {
			test("preserves mode on the wrapped db", () => {
				const db = mockDb([]);
				const wrapped = v.withMiddleware(db, (next: any) => next());
				expect(wrapped.mode).toBe("default");
			});
		}

		// -----------------------------------------------------------------------
		// Conditional: prepareRelationalQuery (beta only)
		// -----------------------------------------------------------------------

		if (v.hasRelationalQuery) {
			test("middleware runs around a relational query execute", async () => {
				const log: Log = [];
				const db = mockDb(log);

				const wrapped = v.withMiddleware(db, async (next: any, _tx: any) => {
					log.push("middleware:before");
					const result = await next();
					log.push("middleware:after");
					return result;
				});
				const session = wrapped.session;
				const prepared = session.prepareRelationalQuery({
					sql: "SELECT rel",
				});
				await prepared.execute();

				expect(log).toEqual([
					"prepareRelationalQuery:SELECT rel",
					"tx:begin",
					"middleware:before",
					"prepareRelationalQuery:SELECT rel",
					"execute:SELECT rel",
					"middleware:after",
					"tx:end",
				]);
			});

			test("middleware can short-circuit a relational query", async () => {
				const log: Log = [];
				const db = mockDb(log);

				const wrapped = v.withMiddleware(db, async (_next: any) => {
					log.push("middleware:short-circuit");
					return [{ cached: true }];
				});
				const session = wrapped.session;
				const prepared = session.prepareRelationalQuery({
					sql: "SELECT rel",
				});
				const result = await prepared.execute();

				expect(result).toEqual([{ cached: true }]);
				expect(log).not.toContain("execute:SELECT rel");
			});

			test("relational query passes through when session lacks the method", () => {
				const log: Log = [];
				const sessionWithout = createMockSession(log, {
					hasSetToken: v.hasSetToken,
					relationalQuery: false,
				});
				const db = v.createDb(sessionWithout);
				const wrapped = v.withMiddleware(db, (next: any) => next());
				expect(wrapped.session.prepareRelationalQuery).toBeUndefined();
			});
		}
	});
}

// ---------------------------------------------------------------------------
// Sync test matrix
// ---------------------------------------------------------------------------

for (const v of syncVariants) {
	describe(`withMiddleware (${v.name})`, () => {
		function mockDb(log: Log) {
			return v.createDb(createSyncMockSession(log));
		}

		test("returns a new db instance, not the original", () => {
			const db = mockDb([]);
			const wrapped = v.withMiddleware(db, (next: any) => next());
			expect(wrapped).not.toBe(db);
		});

		test("sync middleware runs around a prepared query execute", () => {
			const log: Log = [];
			const db = mockDb(log);

			const wrapped = v.withMiddleware(db, (next: any, _tx: any) => {
				log.push("middleware:before");
				const result = next();
				log.push("middleware:after");
				return result;
			});
			const session = wrapped.session;
			const prepared = session.prepareQuery({ sql: "SELECT 1" });
			const result = prepared.execute();

			expect(result).toEqual([{ id: 1 }]);
			expect(log).toEqual([
				"prepareQuery:SELECT 1",
				"tx:begin",
				"middleware:before",
				"prepareQuery:SELECT 1",
				"execute:SELECT 1",
				"middleware:after",
				"tx:end",
			]);
		});

		test("sync middleware wraps transaction calls", () => {
			const log: Log = [];
			const db = mockDb(log);

			const wrapped = v.withMiddleware(db, (next: any, _tx: any) => {
				log.push("middleware:before");
				const result = next();
				log.push("middleware:after");
				return result;
			});
			const session = wrapped.session;
			const result = session.transaction((tx: unknown) => {
				log.push("user:callback");
				return "done";
			});

			expect(result).toBe("done");
			expect(log).toEqual([
				"tx:begin",
				"middleware:before",
				"user:callback",
				"middleware:after",
				"tx:end",
			]);
		});

		test("sync middleware can modify the result", () => {
			const db = mockDb([]);

			const wrapped = v.withMiddleware(db, (next: any) => {
				const result = next();
				return [...(result as any[]), { id: 999 }];
			});
			const session = wrapped.session;
			const prepared = session.prepareQuery({ sql: "SELECT 1" });
			const result = prepared.execute();

			expect(result).toEqual([{ id: 1 }, { id: 999 }]);
		});

		test("sync middleware can short-circuit", () => {
			const log: Log = [];
			const db = mockDb(log);

			const wrapped = v.withMiddleware(db, (_next: any) => {
				return [{ cached: true }];
			});
			const session = wrapped.session;
			const prepared = session.prepareQuery({ sql: "SELECT 1" });
			const result = prepared.execute();

			expect(result).toEqual([{ cached: true }]);
			expect(log).not.toContain("execute:SELECT 1");
		});

		test("sync middleware can throw and the error propagates", () => {
			const db = mockDb([]);

			const wrapped = v.withMiddleware(db, () => {
				throw new Error("denied");
			});
			const session = wrapped.session;
			const prepared = session.prepareQuery({ sql: "SELECT 1" });

			expect(() => prepared.execute()).toThrow("denied");
		});

		test("no promises in the sync chain", () => {
			const db = mockDb([]);
			const wrapped = v.withMiddleware(db, (next: any) => next());

			const session = wrapped.session;
			const prepared = session.prepareQuery({ sql: "SELECT 1" });
			const result = prepared.execute();

			expect(result).not.toBeInstanceOf(Promise);
			expect(result).toEqual([{ id: 1 }]);
		});

		test("chained middlewares: first-applied wraps outermost", () => {
			const log: Log = [];
			const db = mockDb(log);

			const first = (next: any) => {
				log.push("first:before");
				const r = next();
				log.push("first:after");
				return r;
			};

			const second = (next: any) => {
				log.push("second:before");
				const r = next();
				log.push("second:after");
				return r;
			};

			const wrapped = v.withMiddleware(v.withMiddleware(db, first), second);
			const session = wrapped.session;
			const prepared = session.prepareQuery({ sql: "Q" });
			prepared.execute();

			const middlewareLogs = log.filter(
				(l) => l.startsWith("first:") || l.startsWith("second:"),
			);
			expect(middlewareLogs).toEqual([
				"first:before",
				"second:before",
				"second:after",
				"first:after",
			]);
		});
	});
}
