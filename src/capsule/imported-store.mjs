// Imported capsules, isolated from local recordings. Each lives under
// <store>/imports/<imported_id>/ with a copy of its handoff object and the
// project mapping the user chose on this computer. Nothing here reads the
// source computer's paths or transcripts, and nothing in sessions/ is touched.
//
// Identity: imported_id = "imp_" + the capsule id (deterministic, so importing
// the same capsule twice is one record). import_ref is a separate integer
// space from session_ref; source session refs are kept only as provenance.
//
// usage: node src/capsule/imported-store.mjs register <handoff folder> [--project DIR]
//        node src/capsule/imported-store.mjs list | remove <imported_id>

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { storeRoot } from "../store.mjs";
import { importRecordSchema, parseHandoff } from "./schema.mjs";

const IMPORTED_ID = /^imp_[0-9a-f]{32}$/;
const importsDir = () => path.join(storeRoot(), "imports");

export const importedIdFor = (capsuleId) => `imp_${capsuleId.replace(/-/g, "")}`;
export const importRef = (importedId) => Number.parseInt(importedId.slice(4, 16), 16);

const assertImportedId = (id) => {
  if (typeof id !== "string" || !IMPORTED_ID.test(id)) throw new Error(`Not an imported capsule id: ${JSON.stringify(String(id).slice(0, 80))}`);
  return id;
};

const writeJson = (file, value) => {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 1)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
};

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));

/**
 * Registers the handoff that Session Capsule wrote to <project>/.session-capsule/<capsule id>/.
 * Registering the same capsule again is a no-op; a different project folder for
 * the same capsule updates only the mapping; different content under the same
 * capsule id is refused.
 */
export const registerImport = (folder, { project } = {}) => {
  const dir = realpathSync(folder);
  const raw = readFileSync(path.join(dir, "handoff.json"), "utf8");
  const handoff = parseHandoff(JSON.parse(raw));
  if (!handoff.capsule) throw new Error("This handoff was never packed into a capsule; import the capsule with Session Capsule first.");
  const record = importRecordSchema.parse(readJson(path.join(dir, "import.json")));
  if (record.capsuleId !== handoff.capsule.id) throw new Error("handoff.json and import.json belong to different capsules.");
  const projectRoot = realpathSync(project ?? record.destinationRoot);
  if (!statSync(projectRoot).isDirectory()) throw new Error(`${projectRoot} is not a folder.`);

  const id = importedIdFor(handoff.capsule.id);
  const target = path.join(importsDir(), id);
  const handoffSha256 = createHash("sha256").update(JSON.stringify(handoff)).digest("hex");
  const entry = {
    imported_id: id,
    import_ref: importRef(id),
    capsuleId: handoff.capsule.id,
    handoffSha256,
    registeredAt: new Date().toISOString(),
    projectRoot,
    handoffFolder: dir,
    mode: record.mode,
    filesApplied: record.filesApplied,
    contextCheck: record.contextCheck ?? null
  };
  let existing;
  try {
    existing = readJson(path.join(target, "record.json"));
  } catch {}
  if (existing) {
    if (existing.handoffSha256 !== handoffSha256) throw new Error(`Capsule ${handoff.capsule.id} is already registered with different content; refusing to overwrite it.`);
    if (existing.projectRoot === projectRoot) return { status: "already registered", record: existing };
    writeJson(path.join(target, "record.json"), { ...existing, projectRoot, remappedAt: entry.registeredAt });
    return { status: "project folder updated", record: { ...existing, projectRoot } };
  }
  const clash = listImports().find((r) => r.import_ref === entry.import_ref);
  if (clash) throw new Error(`import_ref ${entry.import_ref} is already used by ${clash.imported_id}; use import_id for both.`);
  mkdirSync(target, { recursive: true });
  writeJson(path.join(target, "handoff.json"), handoff);
  writeJson(path.join(target, "record.json"), entry);
  return { status: "registered", record: entry };
};

export const listImports = () => {
  let names = [];
  try {
    names = readdirSync(importsDir()).filter((n) => IMPORTED_ID.test(n));
  } catch {
    return [];
  }
  return names.flatMap((n) => {
    try {
      return [readJson(path.join(importsDir(), n, "record.json"))];
    } catch {
      return [];
    }
  }).sort((a, b) => String(b.registeredAt).localeCompare(String(a.registeredAt)));
};

/** The one import named by import_id or import_ref; never a guess. */
export const resolveImport = ({ import_id, import_ref } = {}) => {
  if (typeof import_id === "string" && import_id) return assertImportedId(import_id);
  if (Number.isSafeInteger(import_ref)) {
    const matches = listImports().filter((r) => r.import_ref === import_ref);
    if (matches.length === 1) return matches[0].imported_id;
    throw new Error(matches.length ? `import_ref ${import_ref} is ambiguous; pass import_id.` : `No imported capsule has import_ref ${import_ref}.`);
  }
  throw new Error("Pass import_ref (an integer from list_imports) or import_id.");
};

export const readImport = (id) => {
  const dir = path.join(importsDir(), assertImportedId(id));
  try {
    return { record: readJson(path.join(dir, "record.json")), handoff: parseHandoff(readJson(path.join(dir, "handoff.json"))) };
  } catch (error) {
    throw new Error(`Imported capsule ${id} is not registered here (${error instanceof Error ? error.message : error}).`);
  }
};

export const removeImport = (id) => {
  rmSync(path.join(importsDir(), assertImportedId(id)), { recursive: true, force: true });
};

/** The destination folder chosen for this import: the only tree imported file tools may read. */
export const importProjectRoot = (id) => {
  const { record } = readImport(id);
  try {
    return realpathSync(record.projectRoot);
  } catch {
    throw new Error(`The project folder chosen for this import (${record.projectRoot}) no longer exists. Register the import again with --project.`);
  }
};

/**
 * A recorded path mapped onto the destination folder, for file access only. The
 * historical text is never rewritten. Relative paths map directly; absolute paths
 * map only when they start with the source project folder. Anything else (or
 * anything that would leave the folder) is not mapped.
 */
export const mapToDestination = (recordedPath, sourceProjectPath) => {
  if (typeof recordedPath !== "string" || !recordedPath) return null;
  let rel = recordedPath.replace(/\\/g, "/");
  const src = (sourceProjectPath ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
  const isAbs = /^([A-Za-z]:)?\//.test(rel);
  if (isAbs) {
    if (!src || !rel.toLowerCase().startsWith(`${src.toLowerCase()}/`)) return null;
    rel = rel.slice(src.length + 1);
  }
  const parts = rel.split("/").filter((p) => p && p !== ".");
  if (!parts.length || parts.includes("..")) return null;
  return parts.join("/");
};

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [cmd, arg, ...rest] = process.argv.slice(2);
  try {
    if (cmd === "register" && arg) {
      const projectArg = rest.find((a) => a.startsWith("--project="))?.slice(10) ?? (rest[0] === "--project" ? rest[1] : undefined);
      const { status, record } = registerImport(arg, { project: projectArg });
      console.log(`${status}: ${record.imported_id} (import_ref ${record.import_ref}) for capsule ${record.capsuleId}`);
      console.log(`Project folder on this computer: ${record.projectRoot}`);
      console.log("Claude Desktop can now read it with list_imports / get_imported_checkpoint. Continue with:");
      console.log(`  node src/capsule/continue.mjs ${record.imported_id} --to cowork|chat|claude-code|codex|manual`);
    } else if (cmd === "list") {
      const all = listImports();
      if (!all.length) console.log("No imported capsules.");
      for (const r of all) console.log(`${r.imported_id}  import_ref ${r.import_ref}  ${r.mode}  ${r.projectRoot}  (registered ${r.registeredAt})`);
    } else if (cmd === "remove" && arg) {
      removeImport(arg);
      console.log(`Removed ${arg} from Blocker's imported store. Project files and Session Capsule backups were not touched.`);
    } else {
      console.error("usage: imported-store.mjs register <handoff folder> [--project DIR] | list | remove <imported_id>");
      process.exit(1);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
