import { describe, expect, test } from "bun:test";
import { MySqlDatabase } from "drizzle-orm/mysql-core/db";
import { PgDatabase } from "drizzle-orm/pg-core/db";
import { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core/db";
import {
	type Middleware as MysqlMiddleware,
	withMiddleware as withMysqlMiddleware,
} from "./src/mysql.ts";
import {
	type Middleware as PgMiddleware,
	withMiddleware as withPgMiddleware,
} from "./src/pg.ts";
import {
	type Middleware as SqliteMiddleware,
	type SyncMiddleware as SyncSqliteMiddleware,
	withMiddleware as withSqliteMiddleware,
} from "./src/sqlite.ts";

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

function createMockSession(log: Log, opts?: { hasSetToken?: boolean }) {
	return {
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
}

// ---------------------------------------------------------------------------
// PG mock factory
// ---------------------------------------------------------------------------

function createMockPgDb(log: Log) {
	const session = createMockSession(log);
	const db = new (PgDatabase as any)({}, session, undefined);
	return db as PgDatabase<any, any, any>;
}

// ---------------------------------------------------------------------------
// MySQL mock factory
// ---------------------------------------------------------------------------

function createMockMysqlDb(log: Log) {
	const session = createMockSession(log, { hasSetToken: false });
	const db = new (MySqlDatabase as any)({}, session, undefined, "default");
	return db as MySqlDatabase<any, any, any, any>;
}

// ---------------------------------------------------------------------------
// SQLite mock factories
// ---------------------------------------------------------------------------

function createMockSqliteDb(log: Log) {
	const session = createMockSession(log, { hasSetToken: false });
	const db = new (BaseSQLiteDatabase as any)("async", {}, session, undefined);
	return db as BaseSQLiteDatabase<"async", any, any, any>;
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

function createMockSyncSqliteDb(log: Log) {
	const session = createSyncMockSession(log);
	const db = new (BaseSQLiteDatabase as any)("sync", {}, session, undefined);
	return db as BaseSQLiteDatabase<"sync", any, any, any>;
}

// ---------------------------------------------------------------------------
// Postgres tests
// ---------------------------------------------------------------------------

describe("withMiddleware (pg)", () => {
	test("returns a new db instance, not the original", () => {
		const db = createMockPgDb([]);
		const wrapped = withPgMiddleware(db, (next) => next());
		expect(wrapped).not.toBe(db);
	});

	test("preserves $client on the wrapped db", () => {
		const db = createMockPgDb([]);
		(db as any).$client = { fake: "client" };
		const wrapped = withPgMiddleware(db, (next) => next());
		expect((wrapped as any).$client).toEqual({ fake: "client" });
	});

	test("preserves $cache on the wrapped db", () => {
		const db = createMockPgDb([]);
		(db as any).$cache = { invalidate: () => {} };
		const wrapped = withPgMiddleware(db, (next) => next());
		expect((wrapped as any).$cache).toBeDefined();
	});

	test("middleware runs around a prepared query execute", async () => {
		const log: Log = [];
		const db = createMockPgDb(log);

		const middleware: PgMiddleware = async (next, _tx) => {
			log.push("middleware:before");
			const result = await next();
			log.push("middleware:after");
			return result;
		};

		const wrapped = withPgMiddleware(db, middleware);
		const session = (wrapped as any).session;
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
		const db = createMockPgDb(log);
		let receivedTx: unknown = null;

		const middleware: PgMiddleware = async (next, tx) => {
			receivedTx = tx;
			return next();
		};

		const wrapped = withPgMiddleware(db, middleware);
		const session = (wrapped as any).session;
		const prepared = session.prepareQuery({ sql: "SELECT 1" });
		await prepared.execute();

		expect(receivedTx).not.toBeNull();
		expect((receivedTx as any).session).toBeDefined();
	});

	test("middleware wraps db.transaction() calls", async () => {
		const log: Log = [];
		const db = createMockPgDb(log);

		const middleware: PgMiddleware = async (next, _tx) => {
			log.push("middleware:before");
			const result = await next();
			log.push("middleware:after");
			return result;
		};

		const wrapped = withPgMiddleware(db, middleware);
		const session = (wrapped as any).session;
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
		const db = createMockPgDb([]);

		const middleware: PgMiddleware = async (next) => {
			const result = await next();
			return [...(result as any[]), { id: 999, injected: true }];
		};

		const wrapped = withPgMiddleware(db, middleware);
		const session = (wrapped as any).session;
		const prepared = session.prepareQuery({ sql: "SELECT 1" });
		const result = await prepared.execute();

		expect(result).toEqual([{ id: 1 }, { id: 999, injected: true }]);
	});

	test("middleware can short-circuit and skip the query", async () => {
		const log: Log = [];
		const db = createMockPgDb(log);

		const middleware: PgMiddleware = async (_next) => {
			log.push("middleware:short-circuit");
			return [{ cached: true }];
		};

		const wrapped = withPgMiddleware(db, middleware);
		const session = (wrapped as any).session;
		const prepared = session.prepareQuery({ sql: "SELECT 1" });
		const result = await prepared.execute();

		expect(result).toEqual([{ cached: true }]);
		expect(log).not.toContain("execute:SELECT 1");
	});

	test("middleware can throw and the error propagates", async () => {
		const db = createMockPgDb([]);

		const middleware: PgMiddleware = async () => {
			throw new Error("denied");
		};

		const wrapped = withPgMiddleware(db, middleware);
		const session = (wrapped as any).session;
		const prepared = session.prepareQuery({ sql: "SELECT 1" });

		expect(prepared.execute()).rejects.toThrow("denied");
	});

	test("setToken is forwarded to the re-prepared query inside the tx", async () => {
		const log: Log = [];
		const db = createMockPgDb(log);
		const wrapped = withPgMiddleware(db, (next) => next());

		const session = (wrapped as any).session;
		const prepared = session.prepareQuery({ sql: "SELECT 1" });
		prepared.setToken("my-token");
		await prepared.execute();

		expect(log).toContain("setToken:SELECT 1:my-token");
	});

	test("joinsNotNullableMap is copied to the re-prepared query", async () => {
		const log: Log = [];
		const db = createMockPgDb(log);

		const wrapped = withPgMiddleware(db, (next) => next());
		const session = (wrapped as any).session;
		const prepared = session.prepareQuery({ sql: "SELECT 1" });
		prepared.joinsNotNullableMap = { users: true, posts: false };

		await prepared.execute();

		expect(log).toContain("prepareQuery:SELECT 1");
	});

	test("non-intercepted session properties pass through", () => {
		const log: Log = [];
		const db = createMockPgDb(log);
		const origSession = (db as any).session;
		origSession.customProp = "hello";

		const wrapped = withPgMiddleware(db, (next) => next());
		const wrappedSession = (wrapped as any).session;

		expect(wrappedSession.customProp).toBe("hello");
	});

	test("chained middlewares: first-applied wraps outermost", async () => {
		const log: Log = [];
		const db = createMockPgDb(log);

		const first: PgMiddleware = async (next) => {
			log.push("first:before");
			const r = await next();
			log.push("first:after");
			return r;
		};

		const second: PgMiddleware = async (next) => {
			log.push("second:before");
			const r = await next();
			log.push("second:after");
			return r;
		};

		const wrapped = withPgMiddleware(withPgMiddleware(db, first), second);
		const session = (wrapped as any).session;
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
				return createMockPreparedQuery(log, id);
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
				const txSession = createMockSession(log);
				const tx = { session: txSession };
				const result = await fn(tx);
				log.push("tx:end");
				return result;
			},
		};

		const db = new (PgDatabase as any)({}, session, undefined) as PgDatabase<
			any,
			any,
			any
		>;

		const middleware: PgMiddleware = async (next, _tx) => {
			log.push("middleware:before");
			const result = await next();
			log.push("middleware:after");
			return result;
		};

		const wrapped = withPgMiddleware(db, middleware);
		const wrappedSession = (wrapped as any).session;
		await wrappedSession.execute({ sql: "SELECT raw" });

		expect(log).toContain("middleware:before");
		expect(log).toContain("middleware:after");
	});

	test("transaction config is forwarded", async () => {
		let receivedConfig: unknown = null;
		const log: Log = [];

		const session = {
			prepareQuery: (...args: unknown[]) => createMockPreparedQuery(log, "q"),
			transaction: async (
				fn: (tx: unknown) => Promise<unknown>,
				config?: unknown,
			) => {
				receivedConfig = config;
				const tx = { session: createMockSession(log) };
				return fn(tx);
			},
		};

		const db = new (PgDatabase as any)({}, session, undefined) as PgDatabase<
			any,
			any,
			any
		>;

		const wrapped = withPgMiddleware(db, (next) => next());
		const wrappedSession = (wrapped as any).session;

		const txConfig = { isolationLevel: "serializable" };
		await wrappedSession.transaction(async () => "ok", txConfig);

		expect(receivedConfig).toEqual(txConfig);
	});
});

// ---------------------------------------------------------------------------
// MySQL tests
// ---------------------------------------------------------------------------

describe("withMiddleware (mysql)", () => {
	test("returns a new db instance, not the original", () => {
		const db = createMockMysqlDb([]);
		const wrapped = withMysqlMiddleware(db, (next) => next());
		expect(wrapped).not.toBe(db);
	});

	test("preserves $client on the wrapped db", () => {
		const db = createMockMysqlDb([]);
		(db as any).$client = { fake: "client" };
		const wrapped = withMysqlMiddleware(db, (next) => next());
		expect((wrapped as any).$client).toEqual({ fake: "client" });
	});

	test("middleware runs around a prepared query execute", async () => {
		const log: Log = [];
		const db = createMockMysqlDb(log);

		const middleware: MysqlMiddleware = async (next, _tx) => {
			log.push("middleware:before");
			const result = await next();
			log.push("middleware:after");
			return result;
		};

		const wrapped = withMysqlMiddleware(db, middleware);
		const session = (wrapped as any).session;
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

	test("middleware wraps db.transaction() calls", async () => {
		const log: Log = [];
		const db = createMockMysqlDb(log);

		const middleware: MysqlMiddleware = async (next, _tx) => {
			log.push("middleware:before");
			const result = await next();
			log.push("middleware:after");
			return result;
		};

		const wrapped = withMysqlMiddleware(db, middleware);
		const session = (wrapped as any).session;
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
		const db = createMockMysqlDb([]);

		const middleware: MysqlMiddleware = async (next) => {
			const result = await next();
			return [...(result as any[]), { id: 999 }];
		};

		const wrapped = withMysqlMiddleware(db, middleware);
		const session = (wrapped as any).session;
		const prepared = session.prepareQuery({ sql: "SELECT 1" });
		const result = await prepared.execute();

		expect(result).toEqual([{ id: 1 }, { id: 999 }]);
	});

	test("middleware can short-circuit and skip the query", async () => {
		const log: Log = [];
		const db = createMockMysqlDb(log);

		const middleware: MysqlMiddleware = async (_next) => {
			return [{ cached: true }];
		};

		const wrapped = withMysqlMiddleware(db, middleware);
		const session = (wrapped as any).session;
		const prepared = session.prepareQuery({ sql: "SELECT 1" });
		const result = await prepared.execute();

		expect(result).toEqual([{ cached: true }]);
		expect(log).not.toContain("execute:SELECT 1");
	});

	test("middleware can throw and the error propagates", async () => {
		const db = createMockMysqlDb([]);

		const middleware: MysqlMiddleware = async () => {
			throw new Error("denied");
		};

		const wrapped = withMysqlMiddleware(db, middleware);
		const session = (wrapped as any).session;
		const prepared = session.prepareQuery({ sql: "SELECT 1" });

		expect(prepared.execute()).rejects.toThrow("denied");
	});

	test("works without setToken (MySQL has none)", async () => {
		const log: Log = [];
		const db = createMockMysqlDb(log);
		const wrapped = withMysqlMiddleware(db, (next) => next());

		const session = (wrapped as any).session;
		const prepared = session.prepareQuery({ sql: "SELECT 1" });

		expect(prepared.setToken).toBeUndefined();
		await prepared.execute();

		expect(log).toContain("execute:SELECT 1");
	});

	test("preserves mode on the wrapped db", () => {
		const db = createMockMysqlDb([]);
		const wrapped = withMysqlMiddleware(db, (next) => next());
		expect((wrapped as any).mode).toBe("default");
	});

	test("chained middlewares: first-applied wraps outermost", async () => {
		const log: Log = [];
		const db = createMockMysqlDb(log);

		const first: MysqlMiddleware = async (next) => {
			log.push("first:before");
			const r = await next();
			log.push("first:after");
			return r;
		};

		const second: MysqlMiddleware = async (next) => {
			log.push("second:before");
			const r = await next();
			log.push("second:after");
			return r;
		};

		const wrapped = withMysqlMiddleware(withMysqlMiddleware(db, first), second);
		const session = (wrapped as any).session;
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

	test("non-intercepted session properties pass through", () => {
		const log: Log = [];
		const db = createMockMysqlDb(log);
		const origSession = (db as any).session;
		origSession.customProp = "hello";

		const wrapped = withMysqlMiddleware(db, (next) => next());
		const wrappedSession = (wrapped as any).session;

		expect(wrappedSession.customProp).toBe("hello");
	});

	test("transaction config is forwarded", async () => {
		let receivedConfig: unknown = null;
		const log: Log = [];

		const session = {
			prepareQuery: (...args: unknown[]) =>
				createMockPreparedQuery(log, "q", { hasSetToken: false }),
			transaction: async (
				fn: (tx: unknown) => Promise<unknown>,
				config?: unknown,
			) => {
				receivedConfig = config;
				const tx = {
					session: createMockSession(log, { hasSetToken: false }),
				};
				return fn(tx);
			},
		};

		const db = new (MySqlDatabase as any)(
			{},
			session,
			undefined,
			"default",
		) as MySqlDatabase<any, any, any, any>;

		const wrapped = withMysqlMiddleware(db, (next) => next());
		const wrappedSession = (wrapped as any).session;

		const txConfig = { isolationLevel: "serializable" };
		await wrappedSession.transaction(async () => "ok", txConfig);

		expect(receivedConfig).toEqual(txConfig);
	});
});

// ---------------------------------------------------------------------------
// SQLite tests
// ---------------------------------------------------------------------------

describe("withMiddleware (sqlite async)", () => {
	test("returns a new db instance, not the original", () => {
		const db = createMockSqliteDb([]);
		const wrapped = withSqliteMiddleware(db, (next) => next());
		expect(wrapped).not.toBe(db);
	});

	test("preserves $client on the wrapped db", () => {
		const db = createMockSqliteDb([]);
		(db as any).$client = { fake: "client" };
		const wrapped = withSqliteMiddleware(db, (next) => next());
		expect((wrapped as any).$client).toEqual({ fake: "client" });
	});

	test("middleware runs around a prepared query execute", async () => {
		const log: Log = [];
		const db = createMockSqliteDb(log);

		const middleware: SqliteMiddleware = async (next, _tx) => {
			log.push("middleware:before");
			const result = await next();
			log.push("middleware:after");
			return result;
		};

		const wrapped = withSqliteMiddleware(db, middleware);
		const session = (wrapped as any).session;
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

	test("middleware wraps db.transaction() calls", async () => {
		const log: Log = [];
		const db = createMockSqliteDb(log);

		const middleware: SqliteMiddleware = async (next, _tx) => {
			log.push("middleware:before");
			const result = await next();
			log.push("middleware:after");
			return result;
		};

		const wrapped = withSqliteMiddleware(db, middleware);
		const session = (wrapped as any).session;
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
		const db = createMockSqliteDb([]);

		const middleware: SqliteMiddleware = async (next) => {
			const result = await next();
			return [...(result as any[]), { id: 999 }];
		};

		const wrapped = withSqliteMiddleware(db, middleware);
		const session = (wrapped as any).session;
		const prepared = session.prepareQuery({ sql: "SELECT 1" });
		const result = await prepared.execute();

		expect(result).toEqual([{ id: 1 }, { id: 999 }]);
	});

	test("middleware can short-circuit and skip the query", async () => {
		const log: Log = [];
		const db = createMockSqliteDb(log);

		const middleware: SqliteMiddleware = async (_next) => {
			return [{ cached: true }];
		};

		const wrapped = withSqliteMiddleware(db, middleware);
		const session = (wrapped as any).session;
		const prepared = session.prepareQuery({ sql: "SELECT 1" });
		const result = await prepared.execute();

		expect(result).toEqual([{ cached: true }]);
		expect(log).not.toContain("execute:SELECT 1");
	});

	test("middleware can throw and the error propagates", async () => {
		const db = createMockSqliteDb([]);

		const middleware: SqliteMiddleware = async () => {
			throw new Error("denied");
		};

		const wrapped = withSqliteMiddleware(db, middleware);
		const session = (wrapped as any).session;
		const prepared = session.prepareQuery({ sql: "SELECT 1" });

		expect(prepared.execute()).rejects.toThrow("denied");
	});

	test("works without setToken (SQLite has none)", async () => {
		const log: Log = [];
		const db = createMockSqliteDb(log);
		const wrapped = withSqliteMiddleware(db, (next) => next());

		const session = (wrapped as any).session;
		const prepared = session.prepareQuery({ sql: "SELECT 1" });

		expect(prepared.setToken).toBeUndefined();
		await prepared.execute();

		expect(log).toContain("execute:SELECT 1");
		expect(log.filter((l) => l.startsWith("setToken:"))).toHaveLength(0);
	});

	test("chained middlewares: first-applied wraps outermost", async () => {
		const log: Log = [];
		const db = createMockSqliteDb(log);

		const first: SqliteMiddleware = async (next) => {
			log.push("first:before");
			const r = await next();
			log.push("first:after");
			return r;
		};

		const second: SqliteMiddleware = async (next) => {
			log.push("second:before");
			const r = await next();
			log.push("second:after");
			return r;
		};

		const wrapped = withSqliteMiddleware(
			withSqliteMiddleware(db, first),
			second,
		);
		const session = (wrapped as any).session;
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

	test("non-intercepted session properties pass through", () => {
		const log: Log = [];
		const db = createMockSqliteDb(log);
		const origSession = (db as any).session;
		origSession.customProp = "hello";

		const wrapped = withSqliteMiddleware(db, (next) => next());
		const wrappedSession = (wrapped as any).session;

		expect(wrappedSession.customProp).toBe("hello");
	});

	test("transaction config is forwarded", async () => {
		let receivedConfig: unknown = null;
		const log: Log = [];

		const session = {
			prepareQuery: (...args: unknown[]) =>
				createMockPreparedQuery(log, "q", { hasSetToken: false }),
			transaction: async (
				fn: (tx: unknown) => Promise<unknown>,
				config?: unknown,
			) => {
				receivedConfig = config;
				const tx = {
					session: createMockSession(log, { hasSetToken: false }),
				};
				return fn(tx);
			},
		};

		const db = new (BaseSQLiteDatabase as any)(
			"async",
			{},
			session,
			undefined,
		) as BaseSQLiteDatabase<"async", any, any, any>;

		const wrapped = withSqliteMiddleware(db, (next) => next());
		const wrappedSession = (wrapped as any).session;

		const txConfig = { behavior: "immediate" };
		await wrappedSession.transaction(async () => "ok", txConfig);

		expect(receivedConfig).toEqual(txConfig);
	});
});

// ---------------------------------------------------------------------------
// Sync SQLite tests
// ---------------------------------------------------------------------------

describe("withMiddleware (sqlite sync)", () => {
	test("returns a new db instance, not the original", () => {
		const db = createMockSyncSqliteDb([]);
		const wrapped = withSqliteMiddleware(db, (next) => next());
		expect(wrapped).not.toBe(db);
	});

	test("sync middleware runs around a prepared query execute", () => {
		const log: Log = [];
		const db = createMockSyncSqliteDb(log);

		const middleware: SyncSqliteMiddleware = (next, _tx) => {
			log.push("middleware:before");
			const result = next();
			log.push("middleware:after");
			return result;
		};

		const wrapped = withSqliteMiddleware(db, middleware);
		const session = (wrapped as any).session;
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
		const db = createMockSyncSqliteDb(log);

		const middleware: SyncSqliteMiddleware = (next, _tx) => {
			log.push("middleware:before");
			const result = next();
			log.push("middleware:after");
			return result;
		};

		const wrapped = withSqliteMiddleware(db, middleware);
		const session = (wrapped as any).session;
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
		const db = createMockSyncSqliteDb([]);

		const middleware: SyncSqliteMiddleware = (next) => {
			const result = next();
			return [...(result as any[]), { id: 999 }];
		};

		const wrapped = withSqliteMiddleware(db, middleware);
		const session = (wrapped as any).session;
		const prepared = session.prepareQuery({ sql: "SELECT 1" });
		const result = prepared.execute();

		expect(result).toEqual([{ id: 1 }, { id: 999 }]);
	});

	test("sync middleware can short-circuit", () => {
		const log: Log = [];
		const db = createMockSyncSqliteDb(log);

		const middleware: SyncSqliteMiddleware = (_next) => {
			return [{ cached: true }];
		};

		const wrapped = withSqliteMiddleware(db, middleware);
		const session = (wrapped as any).session;
		const prepared = session.prepareQuery({ sql: "SELECT 1" });
		const result = prepared.execute();

		expect(result).toEqual([{ cached: true }]);
		expect(log).not.toContain("execute:SELECT 1");
	});

	test("sync middleware can throw and the error propagates", () => {
		const db = createMockSyncSqliteDb([]);

		const middleware: SyncSqliteMiddleware = () => {
			throw new Error("denied");
		};

		const wrapped = withSqliteMiddleware(db, middleware);
		const session = (wrapped as any).session;
		const prepared = session.prepareQuery({ sql: "SELECT 1" });

		expect(() => prepared.execute()).toThrow("denied");
	});

	test("no promises in the sync chain", () => {
		const db = createMockSyncSqliteDb([]);
		const wrapped = withSqliteMiddleware(db, (next) => next());

		const session = (wrapped as any).session;
		const prepared = session.prepareQuery({ sql: "SELECT 1" });
		const result = prepared.execute();

		expect(result).not.toBeInstanceOf(Promise);
		expect(result).toEqual([{ id: 1 }]);
	});
});
