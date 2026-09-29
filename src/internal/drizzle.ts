// The only module that reads Drizzle's internal members.
//
// Drizzle marks most of the members this package needs as `@internal`, so its
// published types do not declare them. This module declares small interfaces
// with only those members. Each accessor checks the shape at runtime before it
// returns a typed value. If a Drizzle version changes a member, the accessor
// throws, so the package fails closed instead of misusing the member.

import type { Query, SQL } from "drizzle-orm-beta";
import { entityKind, is } from "drizzle-orm-beta";
import { NoopCache } from "drizzle-orm-beta/cache/core";

export type Dialect = "pg" | "sqlite";

/** A compiled query, as Drizzle passes it to `prepareQuery`. */
export type DrizzleQuery = Query;

export interface DrizzleDialect {
	sqlToQuery(sql: SQL): DrizzleQuery;
}

/**
 * The arguments Drizzle passes to `prepareQuery` (and to
 * `prepareRelationalQuery`). This package reads only the query. It passes the
 * other arguments back to Drizzle unchanged.
 */
export type PrepareArgs = readonly [query: DrizzleQuery, ...rest: unknown[]];

export interface DrizzlePreparedQuery {
	execute(placeholderValues?: Record<string, unknown>): unknown;
}

export interface DrizzleSession {
	readonly dialect: DrizzleDialect;
	prepareQuery(...args: PrepareArgs): DrizzlePreparedQuery;
	transaction(fn: (tx: unknown) => unknown, config?: unknown): unknown;
}

export interface DrizzleDb {
	readonly session: DrizzleSession;
	readonly dialect: DrizzleDialect;
}

/** Drizzle's internals do not have the shape this package expects. */
export class DrizzleInternalsError extends Error {
	constructor(what: string) {
		super(
			`drizzle-middleware: unexpected Drizzle internals (${what}). This Drizzle version is not supported.`,
		);
		this.name = "DrizzleInternalsError";
	}
}

type Members = Readonly<Record<PropertyKey, unknown>>;

function isObject(value: unknown): value is Members {
	return (
		(typeof value === "object" || typeof value === "function") && value !== null
	);
}

function hasMethods(
	value: unknown,
	names: readonly string[],
): value is Members {
	return (
		isObject(value) && names.every((name) => typeof value[name] === "function")
	);
}

/** Reads a member of an object, or `undefined` if `value` is not an object. */
export function readMember(value: unknown, name: PropertyKey): unknown {
	return isObject(value) ? value[name] : undefined;
}

/** Drizzle's entity kind of an object's class, e.g. `"NodePgSession"`. */
export function entityKindOf(value: unknown): string | undefined {
	const kind = readMember(readMember(value, "constructor"), entityKind);
	return typeof kind === "string" ? kind : undefined;
}

/**
 * True if any class in `value`'s prototype chain has the entity kind `kind`.
 * Driver classes subclass Drizzle's base classes, so an exact kind check would
 * miss them (e.g. `LibSQLTransaction` extends `SQLiteTransaction`).
 */
export function extendsEntityKind(value: unknown, kind: string): boolean {
	let proto: unknown = isObject(value) ? Object.getPrototypeOf(value) : null;
	while (isObject(proto)) {
		if (entityKindOf(proto) === kind) return true;
		proto = Object.getPrototypeOf(proto);
	}
	return false;
}

export function asDrizzleDialect(value: unknown): DrizzleDialect {
	if (!hasMethods(value, ["sqlToQuery"]))
		throw new DrizzleInternalsError("dialect has no sqlToQuery()");
	// Checked above: `sqlToQuery` is a function.
	return value as unknown as DrizzleDialect;
}

export function asDrizzleSession(value: unknown): DrizzleSession {
	if (!hasMethods(value, ["prepareQuery", "transaction"]))
		throw new DrizzleInternalsError(
			"session has no prepareQuery() or transaction()",
		);
	asDrizzleDialect(readMember(value, "dialect"));
	// Checked above: both methods exist and `dialect` has `sqlToQuery`.
	return value as unknown as DrizzleSession;
}

export function asDrizzleDb(value: unknown): DrizzleDb {
	if (!isObject(value))
		throw new DrizzleInternalsError("the db is not an object");
	asDrizzleSession(readMember(value, "session"));
	asDrizzleDialect(readMember(value, "dialect"));
	// Checked above: `session` and `dialect` have the expected shape.
	return value as unknown as DrizzleDb;
}

export function asPreparedQuery(value: unknown): DrizzlePreparedQuery {
	if (!hasMethods(value, ["execute"]))
		throw new DrizzleInternalsError("prepared query has no execute()");
	// Checked above: `execute` is a function.
	return value as unknown as DrizzlePreparedQuery;
}

/** Drizzle's entity kind of a session. Throws if the session has none. */
export function sessionKindOf(session: DrizzleSession): string {
	const kind = entityKindOf(session);
	if (kind === undefined)
		throw new DrizzleInternalsError("session has no entity kind");
	return kind;
}

/**
 * True if the session has a Drizzle query cache. A session without a `cache`
 * member, or with Drizzle's `NoopCache`, has none.
 */
export function hasQueryCache(session: DrizzleSession): boolean {
	const cache = readMember(session, "cache");
	return cache !== undefined && !is(cache, NoopCache);
}

// -----------------------------------------------------------------------
// Preparing and running queries
// -----------------------------------------------------------------------

/** The session methods through which Drizzle prepares a query. */
export type PrepareMethod = "prepareQuery" | "prepareRelationalQuery";

/** The prepared-query methods that send a query to the driver. */
export type ExecMethod = "execute" | "run" | "all" | "get" | "values";

/** Calls `session[method](...args)`: Drizzle prepares the query on `session`. */
export function prepareOn(
	session: DrizzleSession,
	method: PrepareMethod,
	args: readonly unknown[],
): DrizzlePreparedQuery {
	const fn = readMember(session, method);
	if (typeof fn !== "function")
		throw new DrizzleInternalsError(`session has no ${method}()`);
	return asPreparedQuery(Reflect.apply(fn, session, args));
}

/** Calls `prepared[method](...args)`: Drizzle sends the query and maps the result. */
export function runExec(
	prepared: DrizzlePreparedQuery,
	method: ExecMethod,
	args: readonly unknown[],
): unknown {
	const fn = readMember(prepared, method);
	if (typeof fn !== "function")
		throw new DrizzleInternalsError(`prepared query has no ${method}()`);
	return Reflect.apply(fn, prepared, args);
}

/**
 * Copies what Drizzle sets on a prepared query after `prepareQuery` returns:
 * the auth token (`setToken`) and the nullability map of joined tables.
 */
export function copyPreparedState(
	to: DrizzlePreparedQuery,
	state: { token: unknown; joinsNotNullableMap: unknown },
): void {
	const setToken = readMember(to, "setToken");
	if (state.token !== undefined && typeof setToken === "function")
		Reflect.apply(setToken, to, [state.token]);
	if (state.joinsNotNullableMap !== undefined)
		Reflect.set(to, "joinsNotNullableMap", state.joinsNotNullableMap);
}

// -----------------------------------------------------------------------
// Query builders (executeBatchTransaction)
// -----------------------------------------------------------------------

/** A Drizzle query builder: a thenable with `_prepare()` and a `session`. */
export interface DrizzleQueryBuilder {
	readonly session: DrizzleSession;
}

/**
 * True for a value that looks like a Drizzle query builder: it can prepare
 * itself, and it has a session. Awaited results and `db.execute()` do not.
 */
export function isQueryBuilder(value: unknown): boolean {
	return (
		hasMethods(value, ["_prepare", "then"]) &&
		isObject(readMember(value, "session"))
	);
}

export function asQueryBuilder(value: unknown): DrizzleQueryBuilder {
	if (!hasMethods(value, ["_prepare", "then"]))
		throw new DrizzleInternalsError(
			"not a Drizzle query builder (no _prepare())",
		);
	asDrizzleSession(readMember(value, "session"));
	// Checked above: `_prepare` exists and `session` has the expected shape.
	return value as unknown as DrizzleQueryBuilder;
}

/**
 * Runs the builder's `_prepare()` with `session` in place of its own, and
 * puts its own session back. The builder compiles its SQL and calls
 * `session.prepareQuery` (or `prepareRelationalQuery`) with the exact
 * arguments Drizzle would use.
 */
export function prepareBuilderOn(
	builder: DrizzleQueryBuilder,
	session: DrizzleSession,
): unknown {
	const own = builder.session;
	const prepare = readMember(builder, "_prepare");
	if (typeof prepare !== "function")
		throw new DrizzleInternalsError("query builder has no _prepare()");
	Reflect.set(builder, "session", session);
	try {
		return Reflect.apply(prepare, builder, []);
	} finally {
		Reflect.set(builder, "session", own);
	}
}

// -----------------------------------------------------------------------
// Rebuilding a db around a wrapped session
// -----------------------------------------------------------------------

/** What a Drizzle db or transaction was constructed with. */
export interface DbConstruction {
	readonly relations: unknown;
	/** The legacy relational schema, or `undefined` without one. */
	readonly schema:
		| {
				readonly schema: unknown;
				readonly fullSchema: unknown;
				readonly tableNamesMap: unknown;
		  }
		| undefined;
	readonly nestedIndex: unknown;
	/** SQLite only: "sync" or "async". */
	readonly resultKind: unknown;
	/** SQLite only. */
	readonly rowModeRQB: unknown;
	/** SQLite only. */
	readonly forbidJsonb: unknown;
	/** Postgres only. Drizzle keeps it on the relational query builders. */
	readonly parseRqbJson: unknown;
}

export function readConstruction(db: DrizzleDb): DbConstruction {
	const underscore = readMember(db, "_");
	if (!isObject(underscore))
		throw new DrizzleInternalsError("db has no `_` member");
	const schema = readMember(underscore, "schema");
	const builders = readMember(db, "query");
	const firstBuilder = isObject(builders)
		? Object.values(builders)[0]
		: undefined;
	return {
		relations: readMember(underscore, "relations"),
		schema:
			schema === undefined
				? undefined
				: {
						schema,
						fullSchema: readMember(underscore, "fullSchema"),
						tableNamesMap: readMember(underscore, "tableNamesMap"),
					},
		nestedIndex: readMember(db, "nestedIndex"),
		resultKind: readMember(db, "resultKind"),
		rowModeRQB: readMember(db, "rowModeRQB"),
		forbidJsonb: readMember(db, "forbidJsonb"),
		parseRqbJson: readMember(firstBuilder, "parseJson"),
	};
}

/**
 * A copy of `session` with some members replaced, e.g. its driver client. The
 * copy prepares queries exactly as the session does, on the replaced members.
 */
export function copySession(
	session: DrizzleSession,
	members: Readonly<Record<string, unknown>>,
): DrizzleSession {
	const copy: unknown = Object.assign(
		Object.create(Object.getPrototypeOf(session)),
		session,
		members,
	);
	return asDrizzleSession(copy);
}
