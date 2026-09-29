// Lexing of SQL text: which characters are code, and which are inside a
// string literal, a quoted identifier, a dollar-quoted string or a comment.
// It finds the placeholders for the inline encoder and for Bun SQL's tagged
// calls, and it rejects a SQL text with more than one statement.

/**
 * Called for each character that is code. Returns how many characters it
 * consumed (at least 1).
 */
export type CodeVisitor = (index: number) => number;

/** Makes the error for a text that cannot be lexed. */
export type Fail = (problem: string) => Error;

/**
 * How a backslash in a plain Postgres string literal is read. With
 * standard_conforming_strings on it is literal; with it off it escapes the
 * next character. The string ends in the same place either way, except when
 * a quote follows an odd number of backslashes: "strict" throws there.
 */
export type Backslash = "strict" | "literal" | "escape";

export const isIdentifierChar = (c: string | undefined): boolean =>
	c !== undefined && /[A-Za-z0-9_$\u0080-\uffff]/.test(c);

/** Visits the code characters of a Postgres SQL text. */
export function scanPostgres(
	sql: string,
	visit: CodeVisitor,
	fail: Fail,
	backslash: Backslash,
): void {
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
				if (j >= n) throw fail("a string literal is not closed");
				const d = sql[j];
				if (d === "\\" && (escapeString || backslash === "escape")) {
					j += 2;
					continue;
				}
				if (d === "\\") {
					let k = j;
					while (sql[k] === "\\") k++;
					if (backslash === "strict" && sql[k] === "'" && (k - j) % 2 === 1)
						throw fail(
							"a quote after an odd number of backslashes ends a string literal in a place that depends on standard_conforming_strings",
						);
					j = k;
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
			i = afterQuoted(sql, i, '"', () =>
				fail("a quoted identifier is not closed"),
			);
		} else if (c === "-" && next === "-") {
			// Postgres ends a line comment at either line break.
			let j = i;
			while (j < n && sql[j] !== "\n" && sql[j] !== "\r") j++;
			i = j;
		} else if (c === "/" && next === "*") {
			let depth = 0;
			let j = i;
			do {
				if (j >= n) throw fail("a comment is not closed");
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
			const tag =
				/^\$([A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)?\$/.exec(
					sql.slice(i),
				);
			if (tag) {
				const end = sql.indexOf(tag[0], i + tag[0].length);
				if (end === -1) throw fail("a dollar-quoted string is not closed");
				i = end + tag[0].length;
			} else i += visit(i);
		} else i += visit(i);
	}
}

/** Visits the code characters of a SQLite SQL text. */
export function scanSqlite(sql: string, visit: CodeVisitor, fail: Fail): void {
	const n = sql.length;
	let i = 0;
	while (i < n) {
		const c = sql[i];
		const next = sql[i + 1];
		if (c === "'" || c === '"' || c === "`") {
			i = afterQuoted(sql, i, c, () =>
				fail("a string literal or quoted identifier is not closed"),
			);
		} else if (c === "[") {
			const end = sql.indexOf("]", i + 1);
			if (end === -1) throw fail("a quoted identifier is not closed");
			i = end + 1;
		} else if (c === "-" && next === "-") {
			const end = sql.indexOf("\n", i);
			i = end === -1 ? n : end;
		} else if (c === "/" && next === "*") {
			// SQLite comments do not nest, and may run to the end of the text.
			const end = sql.indexOf("*/", i + 2);
			i = end === -1 ? n : end + 2;
		} else i += visit(i);
	}
}

/** The index after a quoted run that starts at `start`; a doubled quote is part of it. */
function afterQuoted(
	sql: string,
	start: number,
	quote: string,
	notClosed: () => Error,
): number {
	let j = start + 1;
	for (;;) {
		const end = sql.indexOf(quote, j);
		if (end === -1) throw notClosed();
		if (sql[end + 1] === quote) {
			j = end + 2;
			continue;
		}
		return end + 1;
	}
}

class NotLexed extends Error {}

/**
 * Throws unless `sql` is one statement. A `;` after the statement may be
 * followed only by whitespace, more `;` and comments. For Postgres, the text
 * is read with backslashes literal and as escapes (standard_conforming_strings
 * on and off); a second statement in either reading throws. A reading in
 * which the text does not lex would fail on such a server anyway.
 */
export function assertSingleStatement(
	sql: string,
	dialect: "pg" | "sqlite",
): void {
	const multiple = () =>
		new TypeError(
			"drizzle-middleware: a SQL text with more than one statement is not allowed. Send each statement as its own query or middleware statement.",
		);
	const scan = (run: (visit: CodeVisitor, fail: Fail) => void) => {
		let ended = false;
		try {
			run(
				(index) => {
					const c = sql[index] ?? "";
					if (c === ";") ended = true;
					else if (ended && !/\s/.test(c)) throw multiple();
					return 1;
				},
				(problem) => new NotLexed(problem),
			);
		} catch (error) {
			if (!(error instanceof NotLexed)) throw error;
		}
	};
	if (dialect === "sqlite") scan((visit, fail) => scanSqlite(sql, visit, fail));
	else
		for (const backslash of ["literal", "escape"] as const)
			scan((visit, fail) => scanPostgres(sql, visit, fail, backslash));
}
