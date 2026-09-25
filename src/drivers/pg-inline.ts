// The strict inline encoder, for postgres-js with `prepare: false`
// (docs/design.md, section 6). postgres-js waits for a round trip to learn
// the parameter types of every query that has parameters, which breaks the
// pipeline. A query without parameters needs no such round trip, so the
// values are written into the SQL text instead, as literals that behave like
// the parameters the driver would have sent.

/** How the driver types a parameter: untyped, or one Postgres type. */
export type ParamType = "unknown" | "boolean" | "int8" | "bytea";

/** The parameter type that a driver infers from a JavaScript value. */
export type Inference = (value: unknown) => ParamType;

/** postgres-js: `inferType` in postgres/src/types.js (a Date is rejected). */
export const postgresJsInference: Inference = (value) =>
	value === true || value === false
		? "boolean"
		: typeof value === "bigint"
			? "int8"
			: value instanceof Uint8Array
				? "bytea"
				: "unknown";

export class InlineError extends TypeError {
	constructor(problem: string) {
		super(
			`drizzle-middleware: cannot inline this query for a driver with \`prepare: false\`: ${problem}.`,
		);
		this.name = "InlineError";
	}
}

/**
 * A value as an untyped (or cast) `E'…'` literal. `E'…'` strings do not
 * depend on `standard_conforming_strings`. Only a closed set of values is
 * accepted; anything else throws.
 */
export function literal(value: unknown, inference: Inference): string {
	if (value === null || value === undefined) return "NULL";
	let text: string;
	if (typeof value === "string") text = value;
	else if (typeof value === "number" || typeof value === "bigint")
		text = String(value);
	else if (typeof value === "boolean") text = value ? "t" : "f";
	else if (value instanceof Uint8Array)
		text = `\\x${Array.from(value, (b) => b.toString(16).padStart(2, "0")).join("")}`;
	else
		throw new InlineError(
			`a value of type ${Object.prototype.toString.call(value)} has no literal form (pass a string, number, bigint, boolean, bytes or null)`,
		);
	if (text.includes("\0"))
		throw new InlineError("a string contains a NUL character");
	// Escape with functions, not replacement strings: in a replacement string,
	// `$$` would become `$`.
	const escaped = text.replace(/\\/g, () => "\\\\").replace(/'/g, () => "''");
	const type = inference(value);
	return type === "unknown" ? `E'${escaped}'` : `(E'${escaped}'::${type})`;
}

const isIdentifierChar = (c: string | undefined) =>
	c !== undefined && /[A-Za-z0-9_$\u0080-\uffff]/.test(c);

/** One `$n` placeholder: where it is in the SQL text, and its number. */
interface Placeholder {
	readonly start: number;
	readonly end: number;
	readonly index: number;
}

/**
 * Finds the `$n` placeholders in `sql`. Placeholders inside string literals,
 * quoted identifiers, dollar-quoted strings and comments are skipped. Throws
 * if the SQL is ambiguous, or if the placeholders do not match `paramCount`.
 */
export function findPlaceholders(
	sql: string,
	paramCount: number,
): Placeholder[] {
	const found: Placeholder[] = [];
	const n = sql.length;
	let i = 0;
	while (i < n) {
		const c = sql[i];
		const next = sql[i + 1];
		if (c === "'") {
			const prev = sql[i - 1];
			const escapeString =
				(prev === "E" || prev === "e") && !isIdentifierChar(sql[i - 2]);
			let j = i + 1;
			for (;;) {
				if (j >= n) throw new InlineError("a string literal is not closed");
				const d = sql[j];
				if (d === "\\") {
					if (!escapeString)
						throw new InlineError(
							"a string literal contains a backslash, whose meaning depends on standard_conforming_strings",
						);
					j += 2;
					continue;
				}
				if (d === "'") {
					if (sql[j + 1] === "'") {
						j += 2;
						continue;
					}
					break;
				}
				j++;
			}
			i = j + 1;
		} else if (c === '"') {
			let j = i + 1;
			for (;;) {
				const end = sql.indexOf('"', j);
				if (end === -1)
					throw new InlineError("a quoted identifier is not closed");
				if (sql[end + 1] === '"') {
					j = end + 2;
					continue;
				}
				i = end + 1;
				break;
			}
		} else if (c === "-" && next === "-") {
			const end = sql.indexOf("\n", i);
			i = end === -1 ? n : end;
		} else if (c === "/" && next === "*") {
			let depth = 0;
			let j = i;
			do {
				if (j >= n) throw new InlineError("a comment is not closed");
				if (sql[j] === "/" && sql[j + 1] === "*") {
					depth++;
					j += 2;
				} else if (sql[j] === "*" && sql[j + 1] === "/") {
					depth--;
					j += 2;
				} else j++;
			} while (depth > 0);
			i = j;
		} else if (c === "$" && !isIdentifierChar(sql[i - 1])) {
			const rest = sql.slice(i);
			const placeholder = /^\$(\d+)/.exec(rest);
			const tag =
				/^\$([A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)?\$/.exec(rest);
			if (placeholder) {
				const index = Number(placeholder[1]);
				if (index < 1 || index > paramCount)
					throw new InlineError(
						`the query uses $${index}, but has ${paramCount} parameters`,
					);
				found.push({ start: i, end: i + placeholder[0].length, index });
				i += placeholder[0].length;
			} else if (tag) {
				const end = sql.indexOf(tag[0], i + tag[0].length);
				if (end === -1)
					throw new InlineError("a dollar-quoted string is not closed");
				i = end + tag[0].length;
			} else i++;
		} else i++;
	}
	const used = new Set(found.map((p) => p.index));
	for (let index = 1; index <= paramCount; index++)
		if (!used.has(index))
			throw new InlineError(`parameter $${index} is not used in the query`);
	return found;
}

/** Replaces each `$n` placeholder in `sql` with `literal(params[n - 1])`. */
export function inlineParams(
	sql: string,
	params: readonly unknown[],
	inference: Inference,
): string {
	let out = "";
	let last = 0;
	for (const p of findPlaceholders(sql, params.length)) {
		out += sql.slice(last, p.start) + literal(params[p.index - 1], inference);
		last = p.end;
	}
	return out + sql.slice(last);
}

/**
 * Splits `sql` at its placeholders, for a tagged-template call:
 * `client(strings, ...params)`. The placeholders must be `$1`…`$n` in order,
 * each once, as Drizzle writes them; otherwise this throws.
 */
export function splitAtPlaceholders(sql: string, paramCount: number): string[] {
	const found = findPlaceholders(sql, paramCount);
	found.forEach((p, i) => {
		if (p.index !== i + 1)
			throw new InlineError(
				"the placeholders are not $1…$n in order, once each",
			);
	});
	const strings: string[] = [];
	let last = 0;
	for (const p of found) {
		strings.push(sql.slice(last, p.start));
		last = p.end;
	}
	strings.push(sql.slice(last));
	return strings;
}
