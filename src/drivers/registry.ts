// The driver registry: one explicit entry per supported Drizzle session kind.
// A kind without an entry throws; the package does not guess.

import {
	DRIVER_PLAN,
	type Driver,
	type DriverEntry,
	type DriverPlan,
} from "../core/driver.js";
import {
	type Dialect,
	type DrizzleSession,
	sessionKindOf,
} from "../internal/drizzle.js";
import { nodePostgres } from "./node-postgres.js";
import { bunSqlPostgres, postgresJs } from "./postgres-js.js";
import {
	drizzleAsyncTransaction,
	drizzleSyncTransaction,
} from "./transactions.js";

const pglite: DriverEntry = {
	sessionKind: "PgliteSession",
	dialect: "pg",
	driverFor: () => drizzleAsyncTransaction("local-transaction"),
};

const bunSqlite: DriverEntry = {
	sessionKind: "SQLiteBunSession",
	dialect: "sqlite",
	driverFor: () => drizzleSyncTransaction,
};

const betterSqlite3: DriverEntry = {
	sessionKind: "BetterSQLiteSession",
	dialect: "sqlite",
	driverFor: () => drizzleSyncTransaction,
};

const ENTRIES: ReadonlyMap<string, DriverEntry> = new Map(
	[
		nodePostgres,
		postgresJs,
		bunSqlPostgres,
		pglite,
		bunSqlite,
		betterSqlite3,
	].map((entry) => [entry.sessionKind, entry]),
);

/** The session kinds that have a driver entry. */
export const SUPPORTED_SESSION_KINDS: ReadonlySet<string> = new Set(
	ENTRIES.keys(),
);

function planOf(kind: string): DriverPlan | undefined {
	return Object.entries(DRIVER_PLAN).find(([k]) => k === kind)?.[1];
}

/** The driver for a real session. Throws if the session's driver is not supported. */
export function driverFor(dialect: Dialect, session: DrizzleSession): Driver {
	const kind = sessionKindOf(session);
	const entry = ENTRIES.get(kind);
	if (entry !== undefined && entry.dialect === dialect) {
		const driver = entry.driverFor(session);
		if (driver.kind === "rejected")
			throw new TypeError(
				`drizzle-middleware: withMiddleware is not compatible with ${kind}: ${driver.reason}.`,
			);
		return driver;
	}
	const plan = planOf(kind);
	if (plan !== undefined && "rejected" in plan)
		throw new TypeError(
			`drizzle-middleware: withMiddleware is not compatible with ${kind}: ${plan.rejected}.`,
		);
	if (plan !== undefined)
		throw new TypeError(
			`drizzle-middleware: ${kind} is planned but not supported yet.`,
		);
	throw new TypeError(
		`drizzle-middleware: withMiddleware is not compatible with ${kind}: it is not a known Drizzle driver session.`,
	);
}
