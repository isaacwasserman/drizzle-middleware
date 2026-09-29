// The wrapped db: a guarded session proxy whose prepared queries run as units.
// See docs/design.md, sections 4 and 8.

import type { SQL } from "drizzle-orm-beta";
import {
	type DbConstruction,
	type DrizzleDb,
	type DrizzlePreparedQuery,
	type DrizzleSession,
	type ExecMethod,
	type PrepareMethod,
	asDrizzleDb,
	asDrizzleSession,
	asPreparedQuery,
	asQueryBuilder,
	entityKindOf,
	extendsEntityKind,
	hasQueryCache,
	isQueryBuilder,
	prepareBuilderOn,
	readConstruction,
	readMember,
	runExec,
} from "../internal/drizzle.js";
import type { Driver } from "./driver.js";
import { assertSingleStatement } from "./sql-text.js";
import type { Middleware } from "./types.js";
import {
	type DialectRules,
	type QueryItem,
	type Statements,
	collectStatements,
	isEmpty,
	queryText,
	runUnit,
	transactionEnded,
} from "./unit.js";

/** Everything that differs between Postgres and SQLite. */
export interface DialectConfig {
	readonly rules: DialectRules;
	/** Drizzle's base transaction class, e.g. `PgAsyncTransaction`. */
	readonly transactionKind: string;
	readonly sessionMembers: ReadonlySet<string>;
	readonly preparedMembers: ReadonlySet<string>;
	/** Constructor arguments for a db (or transaction) of the input's class. */
	constructArgs(
		input: DrizzleDb,
		construction: DbConstruction,
		session: DrizzleSession,
		isTransaction: boolean,
	): unknown[];
	/** Picks the driver entry for a real session. Throws if none fits. */
	driverFor(session: DrizzleSession): Driver;
}

/**
 * Statements that run once per transaction: `before` with the first query,
 * `after` before the commit.
 */
interface Scope {
	readonly statements: Statements;
	/** Settles when `before` has run; `undefined` until the first query. */
	beforeDone: Promise<void> | "sync" | undefined;
	/**
	 * Set when the callback settles: from then on, work on `tx` throws. Work
	 * admitted before finishes first, so no statement of the scope reaches the
	 * connection after the COMMIT or ROLLBACK.
	 */
	ended: boolean;
	/** Units and savepoints admitted by the scope that have not settled. */
	open: number;
	/** Resolves `whenIdle`, when `open` goes back to 0. */
	onIdle: (() => void) | undefined;
}

/** Counts `result` as open work of the scope until it settles. */
function admit(scope: Scope, result: unknown): unknown {
	if (!isThenable(result)) return result;
	scope.open++;
	const settle = () => {
		scope.open--;
		if (scope.open === 0) scope.onIdle?.();
	};
	result.then(settle, settle);
	return result;
}

function whenIdle(scope: Scope): Promise<void> {
	if (scope.open === 0) return Promise.resolve();
	return new Promise((resolve) => {
		scope.onIdle = resolve;
	});
}

/**
 * The promise that `beforeDone` holds. It rejects when the first unit fails;
 * the handler stops that rejection from being reported as unhandled when
 * nothing else waits for it.
 */
function settlesBefore(result: PromiseLike<unknown>): Promise<void> {
	const done = Promise.resolve(result).then(() => undefined);
	done.catch(() => undefined);
	return done;
}

/**
 * A level of `wrapped.transaction(fn)`: the transaction, or a savepoint in
 * it. Middleware makes the transaction one unit, all or nothing: a failed
 * query fails its level, even when the callback catches the error. The
 * transaction then rolls back; a savepoint rolls back and throws to its
 * parent, which may catch that. `before` and `after` are outside every
 * savepoint, so a rolled-back savepoint leaves them complete.
 */
interface Level {
	/** The first query that failed at this level. */
	failed: { error: unknown } | undefined;
	readonly parent: Level | undefined;
}

/** Runs `run`; a failure marks the state's level as failed. */
function tracked(state: WrapState, run: () => unknown): unknown {
	const { level } = state;
	if (level === undefined) return run();
	const mark = (error: unknown) => {
		level.failed ??= { error };
	};
	let result: unknown;
	try {
		result = run();
	} catch (error) {
		mark(error);
		throw error;
	}
	if (isThenable(result)) result.then(undefined, mark);
	return result;
}

/** Throws when the scope takes no more work at the state's level. */
function assertOpen(state: WrapState): void {
	if (state.scope?.ended) throw transactionEnded();
	for (let level = state.level; level; level = level.parent)
		if (level.failed)
			throw new Error(
				"drizzle-middleware: a query in this transaction failed, so the transaction rolls back.",
				{ cause: level.failed.error },
			);
}

/** The error that fails `level`, if a query at that level failed. */
function throwIfFailed(level: Level): void {
	if (level.failed) throw level.failed.error;
}

/** The state that a wrapped session carries. */
interface WrapState {
	readonly config: DialectConfig;
	readonly driver: Driver;
	/** The real session: the db's, or its transaction's in `wrapped.transaction(fn)`. */
	readonly session: DrizzleSession;
	/**
	 * The unwrapped db or transaction that owns `session`. Savepoints and
	 * `setTransaction()` go to it, so no stacked layer runs twice.
	 */
	readonly rawDb: DrizzleDb;
	/** Layers that run around each unit, outermost first. */
	readonly layers: readonly Middleware[];
	/** Set inside `wrapped.transaction(fn)`. */
	readonly scope: Scope | undefined;
	/** The transaction or savepoint level, inside `wrapped.transaction(fn)`. */
	readonly level: Level | undefined;
	/** True when `session` is inside a transaction. */
	readonly inTransaction: boolean;
}

const STATE: unique symbol = Symbol.for("drizzle-middleware.v2.state");

function stateOf(session: unknown): WrapState | undefined {
	const state = readMember(session, STATE);
	return isWrapState(state) ? state : undefined;
}

function isWrapState(value: unknown): value is WrapState {
	return (
		typeof value === "object" &&
		value !== null &&
		Array.isArray(readMember(value, "layers"))
	);
}

// -----------------------------------------------------------------------
// Fail-closed proxies
// -----------------------------------------------------------------------

function blocked(member: string, what: string): Error {
	return new Error(
		`drizzle-middleware: blocked access to \`${member}\` on a wrapped ${what}. This member could send a query to the database without running the middleware. If you need this Drizzle API, please open an issue.`,
	);
}

/** `get` and descriptor traps that allow only the members in `allowed`. */
function guard<T extends object>(
	allowed: ReadonlySet<string>,
	what: string,
	get: (target: T, member: string, receiver: unknown) => unknown,
): ProxyHandler<T> {
	const check = (member: string | symbol) => {
		if (typeof member === "string" && !allowed.has(member))
			throw blocked(member, what);
	};
	return {
		get(target, member, receiver) {
			if (typeof member === "string") {
				const intercepted = get(target, member, receiver);
				if (intercepted !== NOT_INTERCEPTED) return intercepted;
			}
			check(member);
			return Reflect.get(target, member, receiver);
		},
		getOwnPropertyDescriptor(target, member) {
			check(member);
			return Reflect.getOwnPropertyDescriptor(target, member);
		},
	};
}

const NOT_INTERCEPTED: unique symbol = Symbol("not intercepted");

/** Session members that the wrapped session replaces. */
export const SESSION_INTERCEPTED: ReadonlySet<string> = new Set([
	"prepareQuery",
	"prepareRelationalQuery",
	"transaction",
]);

/** Prepared-query members that the wrapped prepared query replaces. */
export function preparedIntercepted(rules: DialectRules): ReadonlySet<string> {
	return new Set([...rules.execMethods, "setToken"]);
}

function wrapPrepared(
	state: WrapState,
	prepareMethod: PrepareMethod,
	prepareArgs: readonly unknown[],
	raw: DrizzlePreparedQuery,
): DrizzlePreparedQuery {
	let token: unknown;
	const execMethods: ReadonlySet<string> = state.config.rules.execMethods;
	const handler = guard<DrizzlePreparedQuery>(
		state.config.preparedMembers,
		"prepared query",
		(target, member, receiver) => {
			if (
				execMethods.has(member) &&
				typeof readMember(target, member) === "function"
			)
				return (...execArgs: unknown[]) =>
					inDriverStyle(state, () =>
						runQuery(state, raw, {
							prepareMethod,
							prepareArgs,
							// Checked above: `member` is one of the rules' exec methods.
							execMethod: member as ExecMethod,
							execArgs,
							token,
							joinsNotNullableMap: readMember(target, "joinsNotNullableMap"),
						}),
					);
			if (member === "setToken")
				return (value: unknown) => {
					token = value;
					return receiver;
				};
			return NOT_INTERCEPTED;
		},
	);
	return new Proxy(raw, handler);
}

function wrapSession(state: WrapState): DrizzleSession {
	const handler = guard<DrizzleSession>(
		state.config.sessionMembers,
		"session",
		(target, member) => {
			if (member === "prepareQuery" || member === "prepareRelationalQuery") {
				const fn = readMember(target, member);
				if (typeof fn !== "function") return NOT_INTERCEPTED;
				return (...args: unknown[]) => {
					const raw = asPreparedQuery(Reflect.apply(fn, target, args));
					return wrapPrepared(state, member, args, raw);
				};
			}
			if (member === "transaction")
				return (fn: (tx: unknown) => unknown, config?: unknown) =>
					inDriverStyle(state, () => runTransaction(state, fn, config));
			return NOT_INTERCEPTED;
		},
	);
	return new Proxy(state.session, {
		...handler,
		get(target, member, receiver) {
			if (member === STATE) return state;
			return handler.get?.(target, member, receiver);
		},
	});
}

// -----------------------------------------------------------------------
// Running queries
// -----------------------------------------------------------------------

function target(state: WrapState) {
	return {
		driver: state.driver,
		session: state.session,
		inTransaction: state.inTransaction,
		rules: state.config.rules,
	};
}

const isSync = (state: WrapState) =>
	state.driver.kind === "transaction" && state.driver.mode === "sync";

/**
 * On an async driver, a throw from the package becomes a rejected promise,
 * as Drizzle's own API gives. A sync driver throws, as Drizzle's sync API
 * does.
 */
function inDriverStyle(state: WrapState, run: () => unknown): unknown {
	if (isSync(state)) return run();
	return new Promise((resolve) => {
		resolve(run());
	});
}

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
	typeof readMember(value, "then") === "function";

/**
 * A sync driver commits when the transaction callback returns. With an async
 * callback, the queries after an `await` would run after the commit. Throwing
 * rolls the transaction back; the scope's `ended` flag, or the driver's own
 * check, stops the queries that the callback still sends.
 */
function rejectAsyncCallback(state: WrapState, result: unknown): void {
	if (!isSync(state) || !isThenable(result)) return;
	// The caller gets the TypeError; the callback's own later error is expected.
	Promise.resolve(result).catch(() => undefined);
	throw new TypeError(
		"drizzle-middleware: a transaction callback on a sync SQLite driver must not be async. The driver commits when the callback returns, so the queries after an `await` would run outside the transaction, without the middleware.",
	);
}

/**
 * Runs `body` alone on the connection, when the driver needs that. Work
 * inside a transaction is already alone, and waiting there would deadlock.
 */
/**
 * Sync clients with an open `wrapped.transaction(fn)`. A sync transaction
 * runs to its end without interruption, so a unit on such a client from a
 * db outside the transaction comes from inside `fn`, where it would run in
 * the transaction and its `after` could undo the scope's `before`.
 */
const openSyncScopes = new WeakMap<object, number>();

function syncClientOf(state: WrapState): object | undefined {
	if (!isSync(state)) return undefined;
	const client = readMember(state.session, "client");
	return typeof client === "object" && client !== null ? client : undefined;
}

function exclusive(state: WrapState, body: () => unknown): unknown {
	const client = state.inTransaction ? undefined : syncClientOf(state);
	if (client !== undefined && (openSyncScopes.get(client) ?? 0) > 0)
		throw new Error(
			"drizzle-middleware: a query on the wrapped db inside its own transaction. Use the transaction's `tx`.",
		);
	const { driver } = state;
	const serialize =
		driver.kind === "batch" ||
		(driver.kind === "transaction" && driver.mode === "async")
			? driver.serialize
			: undefined;
	if (state.inTransaction || serialize === undefined) return body();
	return serialize(state.session, async () => body());
}

function first(values: unknown[] | Promise<unknown[]>): unknown {
	return values instanceof Promise ? values.then((v) => v[0]) : values[0];
}

/** Runs one query of a wrapped session: as a unit, or directly. */
function runQuery(
	state: WrapState,
	raw: DrizzlePreparedQuery,
	item: QueryItem,
): unknown {
	const direct = () => {
		const text = queryText(item);
		if (text !== undefined)
			assertSingleStatement(text, state.config.rules.name);
		return runExec(raw, item.execMethod, item.execArgs);
	};
	return exclusive(state, () =>
		withScope(state, (scopeBefore) => {
			const own = collectStatements(state.layers);
			const statements: Statements = {
				before: [...scopeBefore, ...own.before],
				after: own.after,
			};
			if (isEmpty(statements)) return direct();
			return first(runUnit(target(state), statements, [item]));
		}),
	);
}

/**
 * Runs `body` in a transaction scope's order: the first unit in a scope also
 * sends the scope's `before`, and later units wait until that has run.
 */
function withScope(
	state: WrapState,
	body: (scopeBefore: readonly SQL[]) => unknown,
): unknown {
	const { scope } = state;
	if (scope === undefined) return body([]);
	assertOpen(state);
	if (scope.beforeDone === undefined) {
		const result = tracked(state, () => body(scope.statements.before));
		scope.beforeDone = isThenable(result) ? settlesBefore(result) : "sync";
		return admit(scope, result);
	}
	const done = scope.beforeDone;
	return admit(
		scope,
		tracked(state, () =>
			done === "sync" ? body([]) : done.then(() => body([])),
		),
	);
}

/**
 * Opens a nested transaction (a savepoint). In a scope, the scope's `before`
 * must not run inside the savepoint: if the savepoint rolls back, it undoes
 * `before`, and the later queries of the transaction run without it. So if
 * `before` has not run yet, it runs first, on this transaction.
 */
function openNested(state: WrapState, open: () => unknown): unknown {
	const { scope } = state;
	if (scope === undefined) return open();
	assertOpen(state);
	if (scope.beforeDone === undefined) {
		const { before } = scope.statements;
		if (before.length === 0) scope.beforeDone = "sync";
		else {
			const ran = tracked(state, () =>
				runUnit(target(state), { before, after: [] }, []),
			);
			scope.beforeDone = isThenable(ran) ? settlesBefore(ran) : "sync";
		}
	}
	const done = scope.beforeDone;
	return admit(scope, done === "sync" ? open() : done.then(open));
}

/** `wrapped.transaction(fn)`: the middleware runs once for the transaction. */
function runTransaction(
	state: WrapState,
	fn: (tx: unknown) => unknown,
	config: unknown,
): unknown {
	const statements = collectStatements(state.layers);
	const scope: Scope = {
		statements,
		beforeDone: undefined,
		ended: false,
		open: 0,
		onIdle: undefined,
	};
	const root: Level = { failed: undefined, parent: undefined };
	const finish = (txSession: DrizzleSession): unknown => {
		if (isEmpty(statements)) return undefined;
		const remaining: Statements = {
			before: scope.beforeDone === undefined ? statements.before : [],
			after: statements.after,
		};
		if (isEmpty(remaining)) return undefined;
		return runUnit(
			{ ...target(state), session: txSession, inTransaction: true },
			remaining,
			[],
		);
	};
	const end = () => {
		scope.ended = true;
	};
	const open = () =>
		state.session.transaction((rawTx) => {
			const txDb = asDrizzleDb(rawTx);
			const scoped = wrapDb(txDb, {
				...state,
				session: txDb.session,
				rawDb: txDb,
				layers: [],
				scope,
				level: root,
				inTransaction: true,
			});
			if (isSync(state)) {
				const client = syncClientOf(state);
				if (client !== undefined)
					openSyncScopes.set(client, (openSyncScopes.get(client) ?? 0) + 1);
				let result: unknown;
				try {
					result = fn(scoped);
				} finally {
					if (client !== undefined)
						openSyncScopes.set(client, (openSyncScopes.get(client) ?? 1) - 1);
				}
				rejectAsyncCallback(state, result);
				end();
				throwIfFailed(root);
				finish(txDb.session);
				return result;
			}
			return (async () => {
				let outcome: { value: unknown } | { error: unknown };
				try {
					outcome = { value: await fn(scoped) };
				} catch (error) {
					outcome = { error };
				}
				// No new work on `tx` from here. Work admitted before finishes
				// before `after` and the COMMIT or ROLLBACK are sent.
				end();
				await whenIdle(scope);
				if ("error" in outcome) throw outcome.error;
				throwIfFailed(root);
				if (scope.beforeDone instanceof Promise) await scope.beforeDone;
				await finish(txDb.session);
				return outcome.value;
			})();
		}, config);
	return exclusive(state, () => {
		let result: unknown;
		try {
			result = open();
		} catch (error) {
			end();
			throw error;
		}
		if (!isThenable(result)) {
			end();
			return result;
		}
		return Promise.resolve(result).finally(end);
	});
}

// -----------------------------------------------------------------------
// executeBatchTransaction
// -----------------------------------------------------------------------

/** Records how a builder prepares itself, without running anything. */
function collectItem(
	builder: unknown,
	session: DrizzleSession,
	rules: DialectRules,
): QueryItem {
	const query = asQueryBuilder(builder);
	let captured: { method: PrepareMethod; args: readonly unknown[] } | undefined;
	const stub: { joinsNotNullableMap: unknown; setToken(): unknown } = {
		joinsNotNullableMap: undefined,
		setToken: () => stub,
	};
	const collector = new Proxy(session, {
		get(t, member, receiver) {
			if (member === "prepareQuery" || member === "prepareRelationalQuery")
				return (...args: unknown[]) => {
					captured = { method: member, args };
					return stub;
				};
			return Reflect.get(t, member, receiver);
		},
	});
	prepareBuilderOn(query, collector);
	if (captured === undefined)
		throw new TypeError(
			"drizzle-middleware: executeBatchTransaction could not prepare a query. Pass Drizzle query builders, not awaited results.",
		);
	const executeMethod = captured.args[2];
	const execMethod: ExecMethod =
		rules.name === "pg"
			? "execute"
			: executeMethod === "all" ||
					executeMethod === "get" ||
					executeMethod === "values" ||
					executeMethod === "run"
				? executeMethod
				: "all";
	return {
		prepareMethod: captured.method,
		prepareArgs: captured.args,
		execMethod,
		execArgs: [],
		token: undefined,
		joinsNotNullableMap: stub.joinsNotNullableMap,
	};
}

/**
 * Runs the batch at once (a sync driver runs it inside the caller's sync
 * transaction), and reports every error as a rejected promise.
 */
export function executeBatchTransactionWith(
	configs: readonly DialectConfig[],
	queries: readonly unknown[],
): Promise<unknown[]> {
	return new Promise((resolve) => {
		resolve(runBatch(configs, queries));
	});
}

function runBatch(
	configs: readonly DialectConfig[],
	queries: readonly unknown[],
): Promise<unknown[]> {
	if (queries.length === 0) return Promise.resolve([]);
	queries.forEach((q, i) => {
		if (!isQueryBuilder(q))
			throw new TypeError(
				`drizzle-middleware: executeBatchTransaction accepts only Drizzle query builders, such as db.select() or db.insert(); the query at index ${i} is not one. Pass the builders, not awaited results. db.execute() is not supported.`,
			);
	});
	const builders = queries.map(asQueryBuilder);
	const session = builders[0]?.session;
	if (session === undefined) return Promise.resolve([]);
	builders.forEach((b, i) => {
		if (b.session !== session)
			throw new TypeError(
				`drizzle-middleware: executeBatchTransaction: all queries must come from the same database instance (query at index ${i} does not match the first).`,
			);
	});
	const state = stateOf(session) ?? unwrappedState(configs, session);
	const items = queries.map((q) =>
		collectItem(q, state.session, state.config.rules),
	);
	const result = exclusive(state, () =>
		withScope(state, (scopeBefore) => {
			const own = collectStatements(state.layers);
			return runUnit(
				target(state),
				{ before: [...scopeBefore, ...own.before], after: own.after },
				items,
			);
		}),
	);
	return Promise.resolve(result).then((values) =>
		Array.isArray(values) ? values : [],
	);
}

function unwrappedState(
	configs: readonly DialectConfig[],
	session: DrizzleSession,
): WrapState {
	const kind = entityKindOf(session.dialect) ?? "";
	const config = configs.find((c) =>
		kind === "PgDialect" ? c.rules.name === "pg" : c.rules.name === "sqlite",
	);
	if (config === undefined)
		throw new TypeError("drizzle-middleware: unknown Drizzle dialect");
	return {
		config,
		driver: config.driverFor(session),
		session,
		rawDb: { session, dialect: session.dialect },
		layers: [],
		scope: undefined,
		level: undefined,
		inTransaction: false,
	};
}

// -----------------------------------------------------------------------
// withMiddleware
// -----------------------------------------------------------------------

function wrapDb(input: DrizzleDb, state: WrapState): unknown {
	const { config } = state;
	const session = wrapSession(state);
	const isTransaction = extendsEntityKind(input, config.transactionKind);
	const construction = readConstruction(input);
	const ctor = readMember(input, "constructor");
	if (typeof ctor !== "function")
		throw new TypeError("drizzle-middleware: the db has no constructor");
	const db: unknown = Reflect.construct(
		ctor,
		config.constructArgs(input, construction, session, isTransaction),
		ctor,
	);
	// A class with its own constructor signature would build its own session.
	if (
		readMember(db, "session") !== session ||
		readMember(db, "dialect") !== input.dialect
	)
		throw new TypeError(
			`drizzle-middleware: cannot wrap ${entityKindOf(input) ?? "this db"}. Its constructor does not take the session and dialect that withMiddleware passes, so the result would not run the middleware.`,
		);

	Object.defineProperty(db, "__drizzleMiddlewareId", {
		value: globalThis.crypto.randomUUID(),
		enumerable: false,
		writable: false,
	});
	if ("$client" in input)
		Object.defineProperty(db, "$client", {
			get() {
				throw new Error(
					"drizzle-middleware: blocked access to `$client` on a wrapped db. A query sent on the driver client does not run the middleware. Use the unwrapped db's `$client` if you need the driver.",
				);
			},
			enumerable: false,
		});

	if (isTransaction) {
		// A nested transaction (savepoint): the driver opens it on the unwrapped
		// transaction, and the nested transaction gets the same middleware.
		// Using the unwrapped one means no stacked layer runs twice.
		const { rawDb } = state;
		const nested = readMember(rawDb, "transaction");
		if (typeof nested === "function")
			Object.defineProperty(db, "transaction", {
				value: (fn: (tx: unknown) => unknown, ...rest: unknown[]) =>
					inDriverStyle(state, () =>
						openNested(state, () =>
							Reflect.apply(nested, rawDb, [
								(rawNested: unknown) => {
									const nestedDb = asDrizzleDb(rawNested);
									const level: Level = {
										failed: undefined,
										parent: state.level,
									};
									const result = fn(
										wrapDb(nestedDb, {
											...state,
											session: nestedDb.session,
											rawDb: nestedDb,
											level,
										}),
									);
									rejectAsyncCallback(state, result);
									// A failed query rolls the savepoint back, even when the
									// callback caught it.
									if (!isThenable(result)) {
										throwIfFailed(level);
										return result;
									}
									return Promise.resolve(result).then((value) => {
										throwIfFailed(level);
										return value;
									});
								},
								...rest,
							]),
						),
					),
			});
		// `SET TRANSACTION` must be the first statement of a transaction, so it
		// runs without middleware. It reads no data (docs/design.md, section 4).
		const setTransaction = readMember(rawDb, "setTransaction");
		if (typeof setTransaction === "function")
			Object.defineProperty(db, "setTransaction", {
				value: (...args: unknown[]) =>
					inDriverStyle(state, () => {
						assertOpen(state);
						return Reflect.apply(setTransaction, rawDb, args);
					}),
			});
	}
	return db;
}

export function withMiddlewareWith(
	config: DialectConfig,
	input: unknown,
	middleware: Middleware,
): unknown {
	if (typeof middleware !== "function")
		throw new TypeError(
			"drizzle-middleware: the middleware must be a function that returns { before?: SQL[]; after?: SQL[] }",
		);
	const db = asDrizzleDb(input);
	// Most drivers do not show when a transaction ends. A wrapped transaction
	// kept after its end would send units outside it, or into another
	// request's transaction on the same connection.
	if (extendsEntityKind(db, config.transactionKind))
		throw new TypeError(
			"drizzle-middleware: withMiddleware accepts a db, not a transaction. Wrap the db, and open the transaction on the wrapped db: withMiddleware(db, middleware).transaction(fn).",
		);
	const inner = stateOf(db.session);
	const session = inner?.session ?? asDrizzleSession(db.session);
	if (inner === undefined && hasQueryCache(session))
		throw new TypeError(
			"drizzle-middleware: this db has a Drizzle query cache. A cache key has no middleware context, so a cached result could reach a caller whose middleware gives a different result. Remove the cache to use withMiddleware.",
		);
	const state: WrapState = {
		config,
		driver: inner?.driver ?? config.driverFor(session),
		session,
		rawDb: inner?.rawDb ?? db,
		layers: [middleware, ...(inner?.layers ?? [])],
		scope: undefined,
		level: undefined,
		inTransaction: false,
	};
	return wrapDb(db, state);
}
