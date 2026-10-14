import { DrizzleQueryError, SQL, fillPlaceholders, is } from "drizzle-orm-beta";
import {
	Cache,
	NoopCache,
	hashQuery,
	strategyFor,
} from "drizzle-orm-beta/cache/core";
import {
	NodePgDatabase,
	NodePgSession,
	NodePgTransaction,
} from "drizzle-orm-beta/node-postgres";
import type { PgTransactionConfig } from "drizzle-orm-beta/pg-core";
import pg from "pg";
import { leadingWords, transactionControl } from "./sql-text.js";

export interface MiddlewareStatements {
	/** Statements that run after BEGIN and before the query. */
	before?: SQL[];
	/** Statements that run after the query and before COMMIT. */
	after?: SQL[];
}

/**
 * Called once for each query outside a transaction, and once for each
 * `db.transaction()`.
 */
export type Middleware = () => MiddlewareStatements;

export interface MiddlewareOptions {
	/**
	 * Use the db's Drizzle query cache for reads. Default: true. The cache key
	 * of a read is the hash of the whole unit (BEGIN, `before`, the query,
	 * `after`, COMMIT), so a result is used again only for the same
	 * middleware statements and values.
	 *
	 * A cache hit sends nothing: `before` and `after` do not run. Writes in
	 * `before` and `after` do not invalidate the cache. Inside
	 * `db.transaction()`, reads do not use the cache. `$withCache({ tag })`
	 * throws, because a tag replaces the key.
	 *
	 * With `false`, reads do not use the cache and writes still invalidate
	 * it, so each query runs its middleware.
	 */
	cache?: boolean;
}

export type MiddlewareStage = "begin" | "before" | "after" | "commit";

/** A statement that the package sent for the middleware failed. */
export class MiddlewareError extends Error {
	override readonly name = "MiddlewareError";
	readonly stage: MiddlewareStage;
	readonly index: number;
	readonly query: string;

	constructor(
		stage: MiddlewareStage,
		index: number,
		query: string,
		message: string,
		options?: { cause?: unknown },
	) {
		super(message, options);
		this.stage = stage;
		this.index = index;
		this.query = query;
	}
}

// The pg.Client members that this package uses. pg >= 8.23 has all of them.
type PgClient = Omit<pg.PoolClient, "connection" | "pipeline"> & {
	pipeline: boolean;
	readyForQuery: boolean;
	connection: {
		stream: { cork?: () => void; uncork?: () => void };
		parsedStatements: Record<string, string | undefined>;
		submittedNamedStatements: Record<string, string | undefined>;
	};
};

interface Statement {
	config: pg.QueryConfig & { types?: unknown; rowMode?: "array" };
	values: unknown[];
	stage: MiddlewareStage | "query";
	index: number;
}

interface CompiledMiddleware {
	before: Statement[];
	after: Statement[];
}

type Settled = PromiseSettledResult<pg.QueryResult>;

const prepareValue: (value: unknown) => unknown = (pg as any).utils
	.prepareValue;

function fail(message: string): never {
	throw new Error(`drizzle-middleware: ${message}`);
}

// The results of the package's own statements are not used. Without parsers,
// a result row cannot fail on the client after the server committed.
const RAW_TYPES = { getTypeParser: () => (value: unknown) => value };

function control(
	text: string,
	stage: MiddlewareStage | "query",
	index: number,
): Statement {
	return { config: { text, types: RAW_TYPES }, values: [], stage, index };
}

function compile(
	dialect: NodePgSession<any, any, any>["dialect"],
	middleware: Middleware,
): CompiledMiddleware {
	const result = middleware();
	if (result === null || typeof result !== "object") {
		fail("the middleware must return an object with `before` and `after`.");
	}
	const stage = (name: "before" | "after"): Statement[] => {
		const list = result[name] ?? [];
		if (!Array.isArray(list)) fail(`\`${name}\` must be an array of SQL.`);
		return list.map((item, index) => {
			if (!is(item, SQL)) {
				fail(`${name}[${index}] is not a Drizzle SQL object.`);
			}
			const query = dialect.sqlToQuery(item);
			assertAllowed(query.sql);
			return {
				config: { text: query.sql, types: RAW_TYPES },
				values: fillPlaceholders(query.params, {}),
				stage: name,
				index,
			};
		});
	};
	return { before: stage("before"), after: stage("after") };
}

function assertAllowed(text: unknown): void {
	if (typeof text !== "string") fail("a query must have SQL text.");
	const keyword = transactionControl(text);
	if (keyword !== undefined) {
		fail(
			`${keyword} is not allowed through a db with middleware: it would end the transaction that runs the middleware. Use db.transaction().`,
		);
	}
	if (leadingWords(text, 1)[0] === "copy") {
		fail(
			"COPY is not allowed through a db with middleware: in the copy mode, Postgres ignores the statements after it in the pipeline. Use the app's db.",
		);
	}
}

/**
 * In a unit inside the app's transaction, the unit's savepoint must stay
 * until the unit ends: SAVEPOINT, RELEASE and ROLLBACK TO could release it,
 * or undo `before`.
 */
function assertNoSavepointControl(text: string): void {
	const first = leadingWords(text, 1)[0];
	if (first === "savepoint" || first === "release" || first === "rollback") {
		fail(
			`${first.toUpperCase()} is not allowed through a transaction with middleware: it could end the savepoint that runs the middleware. Use tx.transaction().`,
		);
	}
}

/**
 * One pooled client, from checkout to release. The client is in pg's
 * pipeline mode for the whole lease.
 */
class Lease {
	/** True if the connection state is not known. Then the client is destroyed. */
	failed = false;
	private readonly pipeline: boolean;
	private readonly onError = () => {
		this.failed = true;
	};

	private constructor(readonly client: PgClient) {
		this.pipeline = client.pipeline;
		// pg-pool removes its error listener from a checked-out client. Without
		// a listener, a lost connection would be an uncaught error.
		client.on("error", this.onError);
		client.pipeline = true;
	}

	static async checkout(pool: pg.Pool): Promise<Lease> {
		const client = (await pool.connect()) as unknown as PgClient;
		const supported =
			client instanceof pg.Client &&
			typeof client.pipeline === "boolean" &&
			typeof client.getTransactionStatus === "function" &&
			typeof client.connection?.parsedStatements === "object" &&
			typeof client.connection?.submittedNamedStatements === "object";
		if (!supported) {
			client.release();
			fail(
				"the pool gave a client that is not a pg.Client from pg >= 8.23 (pg-native is not supported).",
			);
		}
		if (client.getTransactionStatus() !== "I") {
			client.release(true);
			fail(
				"the pool gave a client that is inside a transaction. The client was destroyed.",
			);
		}
		return new Lease(client);
	}

	/**
	 * Not async: if a statement cannot be prepared, this throws before it
	 * returns, and nothing was sent.
	 */
	send(statements: Statement[]): Promise<Settled[]> {
		return send(this.client, statements).then((settled) => {
			if (!settled.every(answeredByServer)) this.failed = true;
			return settled;
		});
	}

	/**
	 * Gives the client back to the pool. The client is destroyed if it is not
	 * idle outside a transaction, or if its state is not known.
	 */
	async giveBack(): Promise<void> {
		if (!this.failed) await waitForIdle(this.client);
		this.client.pipeline = this.pipeline;
		const destroy = this.failed || this.client.getTransactionStatus() !== "I";
		this.client.release(destroy || undefined);
		this.client.off("error", this.onError);
	}
}

/**
 * Prepares the statements, then writes all of them to the socket in one
 * write. Nothing is sent if a statement cannot be prepared: pg would fail
 * such a statement on the client without telling the server, and the
 * statements after it would still commit.
 */
function send(client: PgClient, statements: Statement[]): Promise<Settled[]> {
	const names = new Map<string, string>();
	const ready = statements.map((statement) => {
		const { name, text } = statement.config;
		if (name) {
			const known =
				names.get(name) ??
				client.connection.parsedStatements[name] ??
				client.connection.submittedNamedStatements[name];
			if (known !== undefined && known !== text) {
				fail(
					`the prepared statement name '${name}' is already used for a different statement on this connection.`,
				);
			}
			names.set(name, text);
		}
		return {
			// Always the extended protocol: it rejects a text with more than one
			// statement, so a text cannot hide a COMMIT after its first statement.
			config: { ...statement.config, queryMode: "extended" as const },
			values: statement.values.map(prepareValue),
		};
	});
	const stream = client.connection.stream;
	stream.cork?.();
	try {
		return Promise.allSettled(
			ready.map(({ config, values }) => client.query(config, values)),
		);
	} finally {
		stream.uncork?.();
	}
}

/** Waits for the ReadyForQuery of the last statement, or for the end. */
function waitForIdle(client: PgClient): Promise<void> {
	if (client.readyForQuery) return Promise.resolve();
	return new Promise((resolve) => {
		const events = ["drain", "end", "error"] as const;
		const done = () => {
			for (const event of events) client.off(event, done);
			resolve();
		};
		for (const event of events) client.on(event, done);
	});
}

function isIdle(client: PgClient): boolean {
	const internals = client as any;
	return (
		client.readyForQuery === true &&
		!internals._activeQuery &&
		internals._sentQueryQueue?.length === 0 &&
		internals._queryQueue?.length === 0
	);
}

const pipelineHolds = new WeakMap<
	PgClient,
	{ count: number; previous: boolean }
>();

/**
 * Turns on pg's pipeline mode on a client that the app owns, for the time
 * of one flight. The mode goes back only when the client is idle: turning it
 * off while pipelined queries wait for answers would corrupt pg's queues.
 * The 'drain' event comes synchronously when the client becomes idle.
 */
function holdPipeline(client: PgClient): () => void {
	let hold = pipelineHolds.get(client);
	if (hold === undefined) {
		hold = { count: 0, previous: client.pipeline };
		pipelineHolds.set(client, hold);
		client.pipeline = true;
	}
	hold.count++;
	const current = hold;
	const restore = () => {
		if (current.count > 0 || pipelineHolds.get(client) !== current) {
			client.off("drain", restore);
			return;
		}
		if (!isIdle(client)) return;
		client.off("drain", restore);
		pipelineHolds.delete(client);
		client.pipeline = current.previous;
	};
	return () => {
		current.count--;
		if (current.count > 0) return;
		if (isIdle(client)) restore();
		else client.on("drain", restore);
	};
}

/**
 * The pooled client of a transaction that the app owns. Each send first
 * checks that the transaction still has the client: after the transaction
 * ends, the pool can give the client to another request.
 */
class BorrowedClient {
	private readonly release: unknown;
	private readonly useCount: number;

	constructor(readonly client: PgClient) {
		this.release = client.release;
		this.useCount = (client as any)._poolUseCount ?? 0;
	}

	assertOpen(): void {
		const ended =
			this.client.release !== this.release ||
			((this.client as any)._poolUseCount ?? 0) !== this.useCount ||
			this.client.getTransactionStatus() === "I";
		if (ended) {
			fail("this transaction has ended. A query cannot use it after that.");
		}
	}

	/** Not async, for the same reason as Lease.send. */
	send(statements: Statement[]): Promise<Settled[]> {
		this.assertOpen();
		const release = holdPipeline(this.client);
		let pending: Promise<Settled[]>;
		try {
			pending = send(this.client, statements);
		} catch (error) {
			release();
			throw error;
		}
		return pending.finally(release);
	}
}

/**
 * True if the server answered the statement and the session goes on. A
 * FATAL or PANIC error ends the session.
 */
function answeredByServer(result: Settled): boolean {
	if (result.status === "fulfilled") return true;
	const error = result.reason;
	return (
		error instanceof pg.DatabaseError &&
		error.severity !== "FATAL" &&
		error.severity !== "PANIC"
	);
}

function middlewareError(
	statement: Statement,
	cause: unknown,
): MiddlewareError {
	const where =
		statement.stage === "before" || statement.stage === "after"
			? `${statement.stage}[${statement.index}]`
			: statement.stage.toUpperCase();
	const reason = cause instanceof Error ? cause.message : String(cause);
	return new MiddlewareError(
		statement.stage as MiddlewareStage,
		statement.index,
		statement.config.text,
		`drizzle-middleware: middleware statement ${where} failed: ${reason}`,
		{ cause },
	);
}

/**
 * Throws the first failure in statement order. The failure of the app's own
 * query is thrown as it is, the same as without middleware.
 */
function throwFirstFailure(statements: Statement[], settled: Settled[]): void {
	settled.forEach((result, i) => {
		if (result.status === "fulfilled") return;
		const statement = statements[i] as Statement;
		if (statement.stage === "query") throw result.reason;
		throw middlewareError(statement, result.reason);
	});
	// In an aborted transaction, Postgres answers COMMIT with ROLLBACK.
	const last = settled[settled.length - 1];
	const commit = statements[statements.length - 1] as Statement;
	if (
		commit.stage === "commit" &&
		last?.status === "fulfilled" &&
		last.value.command === "ROLLBACK"
	) {
		throw middlewareError(
			commit,
			new Error(`the transaction ended with ${last.value.command}`),
		);
	}
}

const BEGIN = "begin";
const COMMIT = "commit";
const ROLLBACK = "rollback";
const ISOLATION_LEVELS = new Set([
	"read uncommitted",
	"read committed",
	"repeatable read",
	"serializable",
]);
const ACCESS_MODES = new Set(["read only", "read write"]);

/**
 * The same BEGIN text as Drizzle's, from checked values only. A BEGIN that
 * fails would let the next statements commit one by one.
 */
function beginText(config: PgTransactionConfig): string {
	const parts = [BEGIN];
	if (config.isolationLevel) {
		if (!ISOLATION_LEVELS.has(config.isolationLevel)) {
			fail(`unknown isolation level ${JSON.stringify(config.isolationLevel)}.`);
		}
		parts.push(`isolation level ${config.isolationLevel}`);
	}
	if (config.accessMode) {
		if (!ACCESS_MODES.has(config.accessMode)) {
			fail(`unknown access mode ${JSON.stringify(config.accessMode)}.`);
		}
		parts.push(config.accessMode);
	}
	if (typeof config.deferrable === "boolean") {
		parts.push(config.deferrable ? "deferrable" : "not deferrable");
	}
	return parts.join(" ");
}

/** BEGIN; before; query; after; COMMIT in one round trip. */
async function runUnit(
	pool: pg.Pool,
	middleware: CompiledMiddleware,
	config: Statement["config"],
	values: unknown[],
): Promise<pg.QueryResult> {
	assertAllowed(config.text);
	const statements = [
		control(BEGIN, "begin", 0),
		...middleware.before,
		{ config, values, stage: "query" as const, index: 0 },
		...middleware.after,
		control(COMMIT, "commit", 0),
	];
	const lease = await Lease.checkout(pool);
	let settled: Settled[];
	try {
		settled = await lease.send(statements);
	} finally {
		await lease.giveBack();
	}
	throwFirstFailure(statements, settled);
	const result = settled[1 + middleware.before.length] as Settled;
	return (result as PromiseFulfilledResult<pg.QueryResult>).value;
}

/**
 * The client that Drizzle sees. Drizzle only calls `query`; any other member
 * throws, so a new Drizzle code path cannot reach the database without the
 * middleware.
 */
const gates = new WeakSet<object>();

function gate(
	query: (config: Statement["config"], values?: unknown[]) => Promise<unknown>,
): any {
	const proxy = new Proxy(
		{ query },
		{
			get(target, property) {
				if (property === "query") return target.query;
				if (typeof property === "symbol") return undefined;
				fail(
					`Drizzle used client.${property}, which a db with middleware does not support.`,
				);
			},
		},
	);
	gates.add(proxy);
	return proxy;
}

/**
 * The sessions of the plain transactions that a db with middleware gives the
 * app when the middleware returns no statements. Such a transaction is still
 * a transaction of a db with middleware, so `withMiddleware` rejects it, the
 * same as a transaction on a gate.
 */
const plainTransactionSessions = new WeakSet<object>();

type TransactionState = "new" | "open" | "closed";

interface Connection {
	send(statements: Statement[]): Promise<Settled[]>;
}

/** The statements that start, end and undo a transaction or a savepoint. */
interface Boundary {
	begin: Statement;
	commit: Statement;
	rollback: Statement[];
	/** Checks a query of the app inside the transaction. */
	check(text: unknown): void;
}

function transactionBoundary(begin: string): Boundary {
	return {
		begin: control(begin, "begin", 0),
		commit: control(COMMIT, "commit", 0),
		rollback: [control(ROLLBACK, "query", 0)],
		check: assertAllowed,
	};
}

let savepointCount = 0;

function savepointBoundary(): Boundary {
	const name = `drizzle_middleware_${++savepointCount}`;
	return {
		begin: control(`savepoint ${name}`, "begin", 0),
		commit: control(`release savepoint ${name}`, "commit", 0),
		rollback: [
			control(`rollback to savepoint ${name}`, "query", 0),
			control(`release savepoint ${name}`, "query", 0),
		],
		check: assertAllowed,
	};
}

/**
 * One db.transaction() (or a savepoint in the app's transaction). BEGIN and
 * `before` go in the same round trip as the first query; `after` goes in the
 * same round trip as COMMIT.
 */
class TransactionScope {
	private state: TransactionState = "new";

	constructor(
		private readonly connection: Connection,
		private readonly middleware: CompiledMiddleware,
		private readonly boundary: Boundary,
	) {}

	/** Changes the state only if the statements were sent. */
	private flight(statements: Statement[], next: TransactionState) {
		const pending = this.connection.send(statements);
		this.state = next;
		return pending;
	}

	async query(
		config: Statement["config"],
		values: unknown[] = [],
	): Promise<pg.QueryResult> {
		if (this.state === "closed") {
			fail("this transaction has ended. A query cannot use it after that.");
		}
		this.boundary.check(config.text);
		const query: Statement = { config, values, stage: "query", index: 0 };
		const statements =
			this.state === "new"
				? [this.boundary.begin, ...this.middleware.before, query]
				: [query];
		const settled = await this.flight(statements, "open");
		throwFirstFailure(statements, settled);
		return (
			settled[settled.length - 1] as PromiseFulfilledResult<pg.QueryResult>
		).value;
	}

	async commit(): Promise<void> {
		const statements = [
			...(this.state === "new"
				? [this.boundary.begin, ...this.middleware.before]
				: []),
			...this.middleware.after,
			this.boundary.commit,
		];
		const settled = await this.flight(statements, "closed");
		throwFirstFailure(statements, settled);
	}

	/** Returns false if the rollback did not succeed. */
	async rollback(): Promise<boolean> {
		if (this.state === "new") {
			this.state = "closed";
			return true;
		}
		const settled = await this.flight(this.boundary.rollback, "closed");
		return settled.every((result) => result.status === "fulfilled");
	}

	/** After a failed commit of a savepoint: undoes the savepoint. */
	async undo(): Promise<void> {
		await this.connection.send(this.boundary.rollback);
	}
}

function isEmpty(middleware: CompiledMiddleware): boolean {
	return middleware.before.length === 0 && middleware.after.length === 0;
}

/** The text and the values that the cache key of a unit is made from. */
function unitKey(
	middleware: CompiledMiddleware,
	text: string,
	params: unknown[],
): [string, unknown[]] {
	const parts = [
		BEGIN,
		...middleware.before.map((s) => s.config.text),
		text,
		...middleware.after.map((s) => s.config.text),
		COMMIT,
	];
	const values = [
		...middleware.before.map((s) => s.values),
		params,
		...middleware.after.map((s) => s.values),
	];
	return [`drizzle-middleware:${JSON.stringify(parts)}`, values];
}

/**
 * A cache for which every read is a miss and nothing is stored, but a write
 * still invalidates. Used inside db.transaction(), and for `cache: false`.
 */
class WriteOnlyCache extends Cache {
	constructor(private readonly cache: Cache) {
		super();
	}
	override strategy() {
		return this.cache.strategy();
	}
	override async get(): Promise<undefined> {
		return undefined;
	}
	override async put(): Promise<void> {}
	override onMutate(params: Parameters<Cache["onMutate"]>[0]) {
		return this.cache.onMutate(params);
	}
}

type QueryWithCache = (
	queryString: string,
	params: unknown[],
	query: () => Promise<unknown>,
) => Promise<unknown>;

class MiddlewareSession extends NodePgSession<any, any, any> {
	/**
	 * The middleware that the next client.query() call must use. A cached
	 * query calls the middleware before the cache lookup; the unit that runs
	 * on a miss must use the same statements. Drizzle calls client.query()
	 * synchronously in the query callback, so the slot is set only during
	 * that call.
	 */
	private readonly slot: { next?: CompiledMiddleware };
	/** The app's query cache, or undefined if the db has none. */
	private readonly queryCache: Cache | undefined;

	constructor(
		private readonly pool: pg.Pool,
		private readonly middleware: Middleware,
		dialect: NodePgSession<any, any, any>["dialect"],
		private readonly relationsArg: any,
		private readonly schemaArg: any,
		private readonly optionsArg: any,
	) {
		const slot: { next?: CompiledMiddleware } = {};
		super(
			gate((config, values = []) => {
				const compiled = slot.next ?? compile(dialect, middleware);
				slot.next = undefined;
				if (isEmpty(compiled)) return pool.query(config, values);
				return runUnit(pool, compiled, config, values);
			}),
			dialect,
			relationsArg,
			schemaArg,
			optionsArg,
		);
		this.slot = slot;
		const cache = optionsArg?.cache;
		this.queryCache =
			cache && !is(cache, NoopCache) && !(cache instanceof WriteOnlyCache)
				? cache
				: undefined;
	}

	override prepareQuery(...args: any[]): any {
		return this.withUnitCache((super.prepareQuery as any)(...args));
	}

	override prepareRelationalQuery(...args: any[]): any {
		return this.withUnitCache((super.prepareRelationalQuery as any)(...args));
	}

	/** Makes the prepared query use the hash of the whole unit as its key. */
	private withUnitCache<T>(prepared: T): T {
		const cache = this.queryCache;
		if (cache === undefined) return prepared;
		const query = prepared as any;
		const original: QueryWithCache = query.queryWithCache;
		if (typeof original !== "function") {
			fail(
				"this Drizzle version has no queryWithCache; the cache is not supported.",
			);
		}
		const queryWithCache: QueryWithCache = async (queryString, params, run) => {
			const middleware = compile(this.dialect, this.middleware);
			const runUnitQuery = () => {
				this.slot.next = middleware;
				const pending = run();
				const used = this.slot.next === undefined;
				this.slot.next = undefined;
				if (!used) {
					// The query runs later with its own middleware call, but its result
					// must not be stored under this key.
					pending.catch(() => {});
					fail(
						"Drizzle did not call client.query() synchronously, so the cache cannot match the query to its middleware.",
					);
				}
				return pending;
			};
			if (isEmpty(middleware)) {
				return original.call(query, queryString, params, runUnitQuery);
			}
			if (query.cacheConfig?.tag !== undefined) {
				fail(
					"$withCache({ tag }) is not supported with middleware: a tag replaces the cache key, so the middleware would not be part of it.",
				);
			}
			const strategy = await strategyFor(
				queryString,
				params,
				query.queryMetadata,
				query.cacheConfig,
			);
			if (strategy.type !== "try") {
				return original.call(query, queryString, params, runUnitQuery);
			}
			const key = await hashQuery(...unitKey(middleware, queryString, params));
			const { tables, autoInvalidate, config } = strategy;
			const fromCache = await cache.get(key, tables, false, autoInvalidate);
			if (fromCache !== undefined) return fromCache;
			const result = await runUnitQuery().catch((error) => {
				throw new DrizzleQueryError(queryString, params, error);
			});
			await cache.put(key, result, autoInvalidate ? tables : [], false, config);
			return result;
		};
		query.queryWithCache = queryWithCache;
		return prepared;
	}

	private plainSession(
		client: unknown,
		options: any = this.optionsArg,
	): NodePgSession<any, any, any> {
		return new NodePgSession(
			client as any,
			this.dialect,
			this.relationsArg,
			this.schemaArg,
			options,
		);
	}

	override async transaction<T>(
		transaction: (tx: NodePgTransaction<any, any, any>) => Promise<T>,
		config?: PgTransactionConfig,
	): Promise<T> {
		const middleware = compile(this.dialect, this.middleware);
		if (isEmpty(middleware)) {
			return this.plainSession(this.pool).transaction((tx) => {
				// Nested transactions use the same session.
				plainTransactionSessions.add((tx as any).session);
				return transaction(tx);
			}, config);
		}
		const boundary = transactionBoundary(config ? beginText(config) : BEGIN);
		const lease = await Lease.checkout(this.pool);
		const scope = new TransactionScope(lease, middleware, boundary);
		try {
			const options = this.queryCache
				? { ...this.optionsArg, cache: new WriteOnlyCache(this.queryCache) }
				: this.optionsArg;
			const session = this.plainSession(
				gate((queryConfig, values) => scope.query(queryConfig, values)),
				options,
			);
			const tx = new NodePgTransaction(
				this.dialect,
				session,
				this.relationsArg,
				this.schemaArg,
			);
			let result: T;
			try {
				result = await transaction(tx);
			} catch (error) {
				if (!(await scope.rollback())) lease.failed = true;
				throw error;
			}
			await scope.commit();
			return result;
		} finally {
			await lease.giveBack();
		}
	}
}

/**
 * SAVEPOINT; before; query; after; RELEASE in one round trip, in the app's
 * transaction. On a failure, a second round trip rolls back to the
 * savepoint, so the unit is all or nothing and the app's transaction goes on.
 */
async function runSavepointUnit(
	borrowed: BorrowedClient,
	middleware: CompiledMiddleware,
	config: Statement["config"],
	values: unknown[],
): Promise<pg.QueryResult> {
	assertAllowed(config.text);
	assertNoSavepointControl(config.text);
	const boundary = savepointBoundary();
	const statements = [
		boundary.begin,
		...middleware.before,
		{ config, values, stage: "query" as const, index: 0 },
		...middleware.after,
		boundary.commit,
	];
	const settled = await borrowed.send(statements);
	if (settled.some((result) => result.status === "rejected")) {
		await borrowed.send(boundary.rollback).catch(() => {});
	}
	throwFirstFailure(statements, settled);
	const result = settled[1 + middleware.before.length] as Settled;
	return (result as PromiseFulfilledResult<pg.QueryResult>).value;
}

/** The session of a transaction of the app, with middleware. */
class SavepointSession extends NodePgSession<any, any, any> {
	constructor(
		private readonly borrowed: BorrowedClient,
		private readonly middleware: Middleware,
		dialect: NodePgSession<any, any, any>["dialect"],
		private readonly relationsArg: any,
		private readonly schemaArg: any,
		private readonly optionsArg: any,
		private readonly nestedIndex: number,
	) {
		super(
			gate((config, values = []) => {
				const compiled = compile(dialect, middleware);
				if (isEmpty(compiled)) {
					borrowed.assertOpen();
					return borrowed.client.query(config, values);
				}
				return runSavepointUnit(borrowed, compiled, config, values);
			}),
			dialect,
			relationsArg,
			schemaArg,
			optionsArg,
		);
	}

	private plainSession(client: unknown): NodePgSession<any, any, any> {
		return new NodePgSession(
			client as any,
			this.dialect,
			this.relationsArg,
			this.schemaArg,
			this.optionsArg,
		);
	}

	/**
	 * A savepoint in the app's transaction. A savepoint cannot change the
	 * isolation level, so the config is ignored, as in Drizzle's nested
	 * transactions.
	 */
	override async transaction<T>(
		transaction: (tx: NodePgTransaction<any, any, any>) => Promise<T>,
		_config?: PgTransactionConfig,
	): Promise<T> {
		const middleware = compile(this.dialect, this.middleware);
		if (isEmpty(middleware)) {
			this.borrowed.assertOpen();
			const session = this.plainSession(this.borrowed.client);
			plainTransactionSessions.add(session);
			const plain = new NodePgTransaction(
				this.dialect,
				session,
				this.relationsArg,
				this.schemaArg,
				this.nestedIndex,
			);
			return plain.transaction(transaction);
		}
		const scope = new TransactionScope(
			this.borrowed,
			middleware,
			savepointBoundary(),
		);
		const tx = new NodePgTransaction(
			this.dialect,
			this.plainSession(
				gate((queryConfig, values) => scope.query(queryConfig, values)),
			),
			this.relationsArg,
			this.schemaArg,
			this.nestedIndex + 1,
		);
		let result: T;
		try {
			result = await transaction(tx);
		} catch (error) {
			await scope.rollback();
			throw error;
		}
		try {
			await scope.commit();
		} catch (error) {
			await scope.undo().catch(() => {});
			throw error;
		}
		return result;
	}
}

/** A transaction of the app, with middleware. */
class MiddlewareTransaction extends NodePgTransaction<any, any, any> {
	override transaction<T>(
		transaction: (tx: NodePgTransaction<any, any, any>) => Promise<T>,
		config?: PgTransactionConfig,
	): Promise<T> {
		return ((this as any).session as SavepointSession).transaction(
			transaction,
			config,
		);
	}
}

function withTransactionMiddleware(
	tx: NodePgTransaction<any, any, any>,
	middleware: Middleware,
): any {
	const session = (tx as any).session;
	if (Object.getPrototypeOf(session) !== NodePgSession.prototype) {
		fail(
			`withMiddleware supports only a transaction from drizzle-orm/node-postgres. Its session is ${describe(session)}.`,
		);
	}
	const client = session.client;
	if (gates.has(client) || plainTransactionSessions.has(session)) {
		fail(
			"this transaction is from a db with middleware. A transaction can have only one middleware.",
		);
	}
	const supported =
		client instanceof pg.Client &&
		typeof (client as any).release === "function" &&
		typeof (client as any).pipeline === "boolean" &&
		typeof (client as any).connection?.parsedStatements === "object" &&
		typeof (client as any).connection?.submittedNamedStatements === "object";
	if (!supported) {
		fail(
			`withMiddleware supports only a transaction on a client from a pg.Pool. It got ${describe(client)}.`,
		);
	}
	const borrowed = new BorrowedClient(client as unknown as PgClient);
	borrowed.assertOpen();
	// Reads in a transaction do not use the cache; writes still invalidate.
	const sessionOptions = !is(session.cache, NoopCache)
		? { ...session.options, cache: new WriteOnlyCache(session.cache) }
		: session.options;
	const wrappedSession = new SavepointSession(
		borrowed,
		middleware,
		session.dialect,
		session.relations,
		session.schema,
		sessionOptions,
		(tx as any).nestedIndex,
	);
	return new MiddlewareTransaction(
		session.dialect,
		wrappedSession as any,
		session.relations,
		session.schema,
		(tx as any).nestedIndex,
	);
}

function describe(value: unknown): string {
	const name = (value as any)?.constructor?.name;
	return typeof name === "string" ? name : typeof value;
}

/**
 * Returns a new node-postgres db that runs the middleware around each query
 * in one round trip, and around each `db.transaction()`.
 *
 * Only a db from `drizzle-orm/node-postgres` with a `pg.Pool` is accepted,
 * or a transaction of such a db. In a transaction, each query runs in its own
 * savepoint: SAVEPOINT; before; query; after; RELEASE.
 * A db with a query cache uses it for reads unless the options have
 * `{ cache: false }`; see `MiddlewareOptions`.
 */
export function withMiddleware<
	TDb extends
		| (NodePgDatabase<any, any> & { $client: pg.Pool })
		| NodePgTransaction<any, any, any>,
>(db: TDb, middleware: Middleware, options: MiddlewareOptions = {}): TDb {
	if (typeof middleware !== "function") {
		fail("the middleware must be a function.");
	}
	if (options === null || typeof options !== "object") {
		fail("the options must be an object.");
	}
	if (options.cache !== undefined && typeof options.cache !== "boolean") {
		fail("the cache option must be a boolean.");
	}
	if (db instanceof MiddlewareTransaction) {
		fail(
			"this transaction already has middleware. A transaction can have only one middleware.",
		);
	}
	if (db != null && Object.getPrototypeOf(db) === NodePgTransaction.prototype) {
		return withTransactionMiddleware(db as any, middleware);
	}
	if (db == null || Object.getPrototypeOf(db) !== NodePgDatabase.prototype) {
		fail(
			`withMiddleware supports only a db from drizzle-orm/node-postgres. It got ${describe(db)}.`,
		);
	}
	const session = (db as any).session;
	if (session instanceof MiddlewareSession) {
		fail("this db already has middleware. A db can have only one middleware.");
	}
	if (Object.getPrototypeOf(session) !== NodePgSession.prototype) {
		fail(
			`withMiddleware supports only a db from drizzle-orm/node-postgres. Its session is ${describe(session)}.`,
		);
	}
	const pool = session.client;
	if (!(pool instanceof pg.Pool)) {
		fail(
			`withMiddleware supports only a db that uses a pg.Pool. It got ${describe(pool)}. A shared pg.Client could run the middleware's transaction inside another request's transaction.`,
		);
	}
	const sessionOptions =
		options.cache === false && !is(session.cache, NoopCache)
			? { ...session.options, cache: new WriteOnlyCache(session.cache) }
			: session.options;
	const wrappedSession = new MiddlewareSession(
		pool,
		middleware,
		session.dialect,
		session.relations,
		session.schema,
		sessionOptions,
	);
	const wrapped: any = new NodePgDatabase(
		session.dialect,
		wrappedSession as any,
		session.relations,
		session.schema,
	);
	wrapped.$client = (db as any).$client;
	wrapped.$cache = (db as any).$cache;
	return wrapped;
}
