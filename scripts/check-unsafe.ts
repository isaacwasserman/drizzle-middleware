// Fails when the source contains a comment that turns off type
// checking. Biome 1.9 has no rule for this.
import { Glob } from "bun";

const banned = /@ts-(ignore|nocheck)\b/;
const failures: string[] = [];
for (const dir of ["src"]) {
	for await (const path of new Glob("**/*.ts").scan({ cwd: dir })) {
		const lines = (await Bun.file(`${dir}/${path}`).text()).split("\n");
		lines.forEach((line, i) => {
			if (banned.test(line))
				failures.push(`${dir}/${path}:${i + 1}: ${line.trim()}`);
		});
	}
}
if (failures.length > 0) {
	console.error(
		`Use @ts-expect-error with a reason instead:\n${failures.join("\n")}`,
	);
	process.exit(1);
}
