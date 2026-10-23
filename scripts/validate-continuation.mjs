// Checks that a continued Markdown artifact kept its finished sections and completed the rest.
// usage: node scripts/validate-continuation.mjs <before.md> <after.md>
// A section is the text under one "## " heading. Finished before (no TODO) => must be unchanged.
// Unfinished before (TODO) => must now have no TODO, a definition, and an "Example:" line.
// The heading list and order must be the same. Exit code 0 only when every rule holds.
import { readFileSync } from "node:fs";

const sections = (file) => {
  const text = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const parts = text.split(/^(?=## )/m);
  const preamble = parts[0].startsWith("## ") ? "" : parts.shift();
  return { preamble: preamble.trim(), list: parts.map((p) => ({ heading: p.split("\n")[0].trim(), body: p.split("\n").slice(1).join("\n").trim() })) };
};

const [beforeFile, afterFile] = process.argv.slice(2);
const before = sections(beforeFile);
const after = sections(afterFile);
const report = [];
let ok = true;
const check = (cond, line) => {
  report.push(`${cond ? "PASS" : "FAIL"} ${line}`);
  ok &&= cond;
};

check(before.preamble === after.preamble, "title/preamble unchanged");
check(JSON.stringify(before.list.map((s) => s.heading)) === JSON.stringify(after.list.map((s) => s.heading)), `same ${before.list.length} headings in the same order`);
for (const [i, b] of before.list.entries()) {
  const a = after.list[i] ?? { body: "" };
  if (/TODO/.test(b.body)) {
    const done = !/TODO/.test(a.body) && /^Example:/m.test(a.body) && a.body.replace(/^Example:.*$/m, "").trim().length >= 40;
    check(done, `${b.heading}: was unfinished, now has a definition and an Example line`);
  } else {
    check(a.body === b.body, `${b.heading}: was finished, unchanged byte-for-byte`);
  }
}
const finished = before.list.filter((s) => !/TODO/.test(s.body)).length;
console.log(report.join("\n"));
console.log(`${ok ? "VALID" : "INVALID"}: ${finished} finished section(s) preserved check, ${before.list.length - finished} unfinished section(s) completion check`);
process.exit(ok ? 0 : 1);
