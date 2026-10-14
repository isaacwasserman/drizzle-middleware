// Type tests: `bun run typecheck` checks the @ts-expect-error lines.
import { expect, test } from "bun:test";
import { drizzle as drizzleSqlite } from "drizzle-orm-beta/bun-sqlite";
import { drizzle } from "drizzle-orm-beta/node-postgres";
import pg from "pg";
import { withMiddleware } from "../src/node-postgres.ts";

test("withMiddleware keeps the db type and rejects other dbs", () => {
	const check = () => {
		const db = drizzle({ client: new pg.Pool() });
		const wrapped: typeof db = withMiddleware(db, () => ({}));
		void wrapped;

		// @ts-expect-error a pg.Client is not accepted
		withMiddleware(drizzle({ client: new pg.Client() }), () => ({}));
		// @ts-expect-error another driver is not accepted
		withMiddleware(drizzleSqlite(":memory:"), () => ({}));
		// @ts-expect-error the middleware must return statements
		withMiddleware(db, () => 1);
	};
	expect(check).toBeFunction();
});
