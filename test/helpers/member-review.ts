import { readFileSync } from "node:fs";

// Reviews the compiled Drizzle session modules of one dialect against the
// fail-closed member lists in src/*-guard.ts.

type MemberLists = {
	allowed: ReadonlySet<string>;
	denied: ReadonlySet<string>;
	// Members that the proxy replaces. Their bodies are not checked, because
	// the original never runs through the proxy.
	intercepted: ReadonlySet<string>;
};

type ReviewConfig = {
	// Directory of the dialect's core module, e.g. "pg-core".
	coreDir: string;
	// Base classes whose members are reviewed, and whose subclasses are too.
	sessionBases: string[];
	preparedBases: string[];
	// Base classes whose members are reviewed, but whose subclasses are not
	// (for example `PgSession`, which the unsupported Effect sessions extend).
	sessionAncestors?: string[];
	preparedAncestors?: string[];
	session: MemberLists;
	prepared: MemberLists;
};

type ParsedClass = {
	name: string;
	parent: string | undefined;
	file: string;
	members: Set<string>;
	methods: Map<string, string>;
};

const ROOT = "node_modules/drizzle-orm-beta";

const CLASS_PATTERN =
	/^var ([\w$]+) = class(?: [\w$]+)?(?: extends ([\w$]+))? \{\n([\s\S]*?)^\};/gm;

// A module can import a base class under an alias such as `SQLiteSession$1`.
function stripAlias(name: string): string {
	return name.replace(/\$\d+$/, "");
}

// Parse the compiled class bodies in every session module of the dialect.
// A member is a method, a `this.x = ...` field, or a class field declaration.
// Private `#x` members are skipped: a proxy cannot expose them.
function parseSessionModules(coreDir: string): {
	classes: ParsedClass[];
	unparsed: string[];
} {
	const classes: ParsedClass[] = [];
	const unparsed: string[] = [];
	for (const file of new Bun.Glob("**/session.js").scanSync(ROOT)) {
		const source = readFileSync(`${ROOT}/${file}`, "utf8");
		// Other dialects reuse class names such as `PreparedQuery`.
		if (!file.startsWith(`${coreDir}/`) && !source.includes(`/${coreDir}/`))
			continue;

		const declared = source.match(/^var [\w$]+ = class\b/gm)?.length ?? 0;
		let parsed = 0;
		for (const match of source.matchAll(CLASS_PATTERN)) {
			parsed++;
			const body = match[3] as string;
			const methods = new Map<string, string>();
			for (const head of body.matchAll(
				/^\t(?:static |async |get |set |\*)*([\w$]+)\s*\(/gm,
			)) {
				const start = head.index as number;
				const end = body.indexOf("\n\t}", start);
				methods.set(head[1] as string, body.slice(start, end));
			}
			const members = new Set(methods.keys());
			for (const field of body.matchAll(/this\.([\w$]+)\s*=[^=]/g))
				members.add(field[1] as string);
			for (const field of body.matchAll(/^\t([\w$]+)\s*[=;]/gm))
				members.add(field[1] as string);
			classes.push({
				name: match[1] as string,
				parent: match[2] && stripAlias(match[2]),
				file,
				members,
				methods,
			});
		}
		// The parser must not skip a class silently.
		if (parsed !== declared)
			unparsed.push(`${file}: parsed ${parsed} of ${declared} classes`);
	}
	return { classes, unparsed };
}

// The `this.x` members that a method body reads, including destructuring
// such as `const { stmt, fields } = this`.
function thisMembers(body: string): Set<string> {
	const used = new Set<string>();
	for (const ref of body.matchAll(/this\.([\w$]+)/g))
		used.add(ref[1] as string);
	for (const destructure of body.matchAll(
		/(?:const|let|var)\s*\{([^}]*)\}\s*=\s*this\b/g,
	)) {
		for (const part of (destructure[1] as string).split(",")) {
			const name = part.split(":")[0]?.trim();
			if (name) used.add(name);
		}
	}
	return used;
}

export function reviewDrizzleMembers(config: ReviewConfig) {
	const { classes, unparsed } = parseSessionModules(config.coreDir);
	const byFile = new Map<string, Map<string, ParsedClass>>();
	for (const c of classes) {
		const inFile = byFile.get(c.file) ?? new Map<string, ParsedClass>();
		inFile.set(c.name, c);
		byFile.set(c.file, inFile);
	}

	const isCore = (c: ParsedClass) => c.file.startsWith(`${config.coreDir}/`);
	const kindOf = (c: ParsedClass): "session" | "prepared" | undefined => {
		if (isCore(c)) {
			const reviewed = (bases: string[], ancestors: string[] = []) =>
				bases.includes(c.name) || ancestors.includes(c.name);
			if (reviewed(config.sessionBases, config.sessionAncestors))
				return "session";
			if (reviewed(config.preparedBases, config.preparedAncestors))
				return "prepared";
		}
		if (!c.parent) return undefined;
		// Walk to the parent: a class in the same module, or a core base class.
		const local = byFile.get(c.file)?.get(c.parent);
		if (local && local !== c && !isCore(local)) return kindOf(local);
		if (config.sessionBases.includes(c.parent)) return "session";
		if (config.preparedBases.includes(c.parent)) return "prepared";
		return undefined;
	};

	const unknown: string[] = [];
	const leakyMethods: string[] = [];
	const classNames: string[] = [];
	for (const c of classes) {
		const kind = kindOf(c);
		if (!kind) continue;
		classNames.push(c.name);
		const lists = kind === "session" ? config.session : config.prepared;

		for (const member of c.members) {
			if (!lists.allowed.has(member) && !lists.denied.has(member))
				unknown.push(`${c.name}.${member} (${c.file})`);
		}
		// An allowed method that the proxy does not replace runs with the proxy
		// as `this`. It is safe only if it reads allowed members alone.
		for (const [method, body] of c.methods) {
			if (
				method === "constructor" ||
				!lists.allowed.has(method) ||
				lists.intercepted.has(method)
			)
				continue;
			for (const used of thisMembers(body)) {
				if (!lists.allowed.has(used))
					leakyMethods.push(`${c.name}.${method} reads ${used} (${c.file})`);
			}
		}
	}

	const overlap = [
		...[...config.session.allowed].filter((m) => config.session.denied.has(m)),
		...[...config.prepared.allowed].filter((m) =>
			config.prepared.denied.has(m),
		),
	];
	return { unknown, overlap, leakyMethods, classNames, unparsed };
}
