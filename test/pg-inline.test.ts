// The strict inline encoder (postgres-js with `prepare: false`).

import { describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm-beta/postgres-js";
import postgres from "postgres";
import {
	InlineError,
	findPlaceholders,
	postgresJsInference as infer,
	inlineParams,
	literal,
} from "../src/drivers/pg-inline.ts";

describe("inline encoder: placeholders", () => {
	test("replaces each placeholder with its literal", () => {
		expect(inlineParams("select $1, $2::int", ["a", 5], infer)).toBe(
			"select E'a', E'5'::int",
		);
	});

	test("leaves placeholders in strings, identifiers, dollar quotes and comments", () => {
		const sql = [
			"select $1",
			"'$1 in a string'",
			"E'$1 \\' still in an E-string'",
			'"$1 in an identifier"',
			"$$ $1 in dollar quotes $$",
			"$tag$ $1 $$ in a tagged dollar quote $tag$",
			"-- $1 in a line comment\n",
			"/* $1 /* nested */ in a block comment */",
			"a$1",
		].join(" ");
		expect(findPlaceholders(sql, 1).map((p) => p.index)).toEqual([1]);
		expect(inlineParams(sql, ["x"], infer).startsWith("select E'x' ")).toBe(
			true,
		);
	});

	test("throws when the SQL is ambiguous or does not match the parameters", () => {
		const cases: [string, unknown[]][] = [
			["select '\\' || $1", ["x"]],
			["select 'not closed", []],
			['select "not closed', []],
			["select $$ not closed", []],
			["select /* not closed", []],
			["select $2", ["x"]],
			["select 1", ["unused"]],
		];
		for (const [sql, params] of cases)
			expect(() => inlineParams(sql, params, infer)).toThrow(InlineError);
	});
});

describe("inline encoder: literals", () => {
	test("escapes quotes and backslashes, and keeps `$$`", () => {
		expect(literal("it's \\ $$", infer)).toBe("E'it''s \\\\ $$'");
	});

	test("types the values the way postgres-js types parameters", () => {
		expect(literal(true, infer)).toBe("(E't'::boolean)");
		expect(literal(12n, infer)).toBe("(E'12'::int8)");
		expect(literal(new Uint8Array([0, 39, 255]), infer)).toBe(
			"(E'\\\\x0027ff'::bytea)",
		);
		expect(literal(1.5, infer)).toBe("E'1.5'");
		expect(literal(null, infer)).toBe("NULL");
	});

	test("rejects every value outside the closed set", () => {
		for (const value of [
			{ a: 1 },
			[1, 2],
			new Date(0),
			Symbol("s"),
			() => 1,
			"nul \0 char",
		])
			expect(() => literal(value, infer)).toThrow(InlineError);
	});
});

const url = process.env.TEST_PG_URL;

describe.skipIf(!url)("inline encoder against Postgres (postgres-js)", () => {
	const pool = [
		"'",
		"\\",
		"''",
		"\\'",
		"$$",
		"$1",
		"--",
		"/*",
		";",
		"\n",
		"é",
		"☃",
		"😀",
		"E'",
		"\\x",
		"{",
		'"',
		"a",
		" ",
		"\u0001",
	];
	const randomString = () =>
		Array.from(
			{ length: Math.floor(Math.random() * 12) },
			() => pool[Math.floor(Math.random() * pool.length)],
		).join("");

	test("an inlined value behaves like the parameter postgres-js sends", async () => {
		const sql = postgres(url as string, { max: 1, onnotice: () => {} });
		// Drizzle configures the client it wraps: json, jsonb and date values
		// pass through unchanged, because Drizzle encodes them itself.
		drizzle({ client: sql });
		const mismatches: string[] = [];
		const check = async (expr: string, value: unknown) => {
			const asParam = await sql
				.unsafe(`select (${expr.replace("?", () => "$1")}) as v`, [
					value as never,
				])
				.then(
					(r) => r[0]?.v,
					(e: { code?: string }) => `error ${e.code}`,
				);
			const asLiteral = await sql
				.unsafe(
					`select (${inlineParams(
						expr.replace("?", () => "$1"),
						[value],
						infer,
					)}) as v`,
				)
				.then(
					(r) => r[0]?.v,
					(e: { code?: string }) => `error ${e.code}`,
				);
			const show = (x: unknown) =>
				JSON.stringify(x, (_, y) => (typeof y === "bigint" ? `${y}n` : y));
			if (show(asParam) !== show(asLiteral))
				mismatches.push(
					`${expr} ${show(value)}: param ${show(asParam)}, literal ${show(asLiteral)}`,
				);
		};
		try {
			for (const scs of ["on", "off"]) {
				await sql.unsafe(`set standard_conforming_strings = ${scs}`);
				for (let k = 0; k < 150; k++) {
					const s = randomString();
					await check("?::text", s);
					await check("'<' || ? || '>'", s);
					await check("to_jsonb(?::text)", s);
				}
				for (const v of [
					0,
					-1,
					42,
					3.5,
					1e21,
					Number.NaN,
					Number.POSITIVE_INFINITY,
				])
					for (const e of ["?::numeric", "?::double precision", "?::text"])
						await check(e, v);
				for (const v of [0n, -1n, 9007199254740993n]) await check("?", v);
				for (const v of [true, false]) await check("?", v);
				for (let k = 0; k < 20; k++)
					await check(
						"encode(?, 'hex')",
						Buffer.from(
							Array.from({ length: Math.floor(Math.random() * 16) }, () =>
								Math.floor(Math.random() * 256),
							),
						),
					);
				await check("?::jsonb", '{"a":"x\'y\\\\z"}');
				await check("5 = ?", "5");
			}
		} finally {
			await sql.end();
		}
		expect(mismatches).toEqual([]);
	});
});
