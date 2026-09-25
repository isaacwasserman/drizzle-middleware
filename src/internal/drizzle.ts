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
