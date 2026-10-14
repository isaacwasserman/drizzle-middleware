// The first keywords of a statement, read the same way as the Postgres lexer:
// whitespace, `--` comments and nested `/* */` comments are skipped. Postgres
// also drops empty statements, so `;` before the first word is skipped too.

function isSpace(c: string): boolean {
	return (
		c === " " ||
		c === "\t" ||
		c === "\n" ||
		c === "\r" ||
		c === "\f" ||
		c === "\v"
	);
}

function skipIgnored(text: string, i: number, semicolons: boolean): number {
	while (i < text.length) {
		const c = text[i] as string;
		if (isSpace(c) || (semicolons && c === ";")) {
			i++;
		} else if (c === "-" && text[i + 1] === "-") {
			i += 2;
			while (i < text.length && text[i] !== "\n" && text[i] !== "\r") i++;
		} else if (c === "/" && text[i + 1] === "*") {
			let depth = 1;
			i += 2;
			while (i < text.length && depth > 0) {
				if (text[i] === "/" && text[i + 1] === "*") {
					depth++;
					i += 2;
				} else if (text[i] === "*" && text[i + 1] === "/") {
					depth--;
					i += 2;
				} else {
					i++;
				}
			}
		} else {
			break;
		}
	}
	return i;
}

const WORD_START = /[A-Za-z_\u0080-￿]/;
const WORD_PART = /[A-Za-z0-9_$\u0080-￿]/;

/**
 * Returns the first `count` words of the statement in lower case. A word
 * with a character that is not ASCII is returned as "" because it cannot be
 * a keyword. The list stops at the first token that is not a word.
 */
export function leadingWords(text: string, count: number): string[] {
	const words: string[] = [];
	let i = 0;
	while (words.length < count) {
		i = skipIgnored(text, i, words.length === 0);
		if (i >= text.length || !WORD_START.test(text[i] as string)) break;
		const start = i;
		while (i < text.length && WORD_PART.test(text[i] as string)) i++;
		const word = text.slice(start, i);
		words.push(/^[A-Za-z0-9_$]+$/.test(word) ? word.toLowerCase() : "");
	}
	return words;
}

const ENDS_OR_STARTS_TRANSACTION = new Set([
	"begin",
	"start",
	"commit",
	"end",
	"abort",
]);

/**
 * Returns a description of the statement if it starts, ends or prepares a
 * transaction. SAVEPOINT, RELEASE and ROLLBACK TO do not end the
 * transaction, so they are not reported.
 */
export function transactionControl(text: string): string | undefined {
	const [first, second, third] = leadingWords(text, 3);
	if (first === undefined) return undefined;
	if (ENDS_OR_STARTS_TRANSACTION.has(first)) return first.toUpperCase();
	if (first === "rollback") {
		const next = second === "work" || second === "transaction" ? third : second;
		return next === "to" ? undefined : "ROLLBACK";
	}
	if (first === "prepare" && second === "transaction") {
		return "PREPARE TRANSACTION";
	}
	return undefined;
}
