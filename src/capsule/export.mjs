// Export one recorded session as a portable handoff object for Session Capsule.
// It reuses the checkpoint as built for same-computer takeover (same sections,
// same outcome wording) plus the recorded events, redacted again at this boundary.
// The checkpoint's artifact list is a bounded summary, not a file inventory:
// Session Capsule enumerates and hashes project files itself when it packs.
//
// usage: node src/capsule/export.mjs <session_id | session_ref> [--out FILE] [--note FILE] [--max-events N] [--force]

import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCheckpoint } from "../checkpoint.mjs";
import { redactSecrets } from "../redact.mjs";
import { readEvents, resolveSession, sessionRef } from "../store.mjs";
import { HANDOFF_KIND, HANDOFF_VERSION, parseHandoff } from "./schema.mjs";

const VERSION = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;

const redactDeep = (value) =>
  typeof value === "string" ? redactSecrets(value)
    : Array.isArray(value) ? value.map(redactDeep)
      : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v)]))
        : value;

/**
 * Builds the handoff object. Refuses while the source may still be working
 * (Blocker's own sourceStatus gate), unless `force` is set; a forced export
 * says so in sourceStatusAtCapture.exportForced.
 */
export const exportHandoff = (sessionId, { note = null, maxEvents = 1000, force = false } = {}) => {
  const events = readEvents(sessionId);
  if (events.length === 0) throw new Error(`No events recorded for session ${sessionId}.`);
  const cp = buildCheckpoint(sessionId);
  const status = cp.sourceStatus;
  if (status.mayStillBeWorking && !force) {
    throw new Error(`The source may still be working on this task, so it was not exported. ${status.advice} Stop or pause it, wait until no files are changing, then export again (or pass --force to export anyway and have that recorded).`);
  }
  const items = events.slice(-maxEvents);
  const truncatedEvents = items.filter((e) => JSON.stringify(e).includes("…[truncated")).length;
  const { observed, agentNotes, inferred, missing } = cp;
  return parseHandoff(redactDeep({
    kind: HANDOFF_KIND,
    version: HANDOFF_VERSION,
    handoffId: randomUUID(),
    createdBy: { name: "desktop-continuity", version: VERSION },
    capturedAt: new Date().toISOString(),
    source: { tool: "codex", surface: "codex-desktop", platform: process.platform, toolVersion: null, model: cp.model ?? null },
    session: {
      originalId: sessionId,
      originalRef: sessionRef(sessionId),
      sourceProjectPath: cp.project ?? null,
      firstRecordedAt: cp.firstRecordedAt,
      lastRecordedAt: cp.lastRecordedAt
    },
    events: { totalRecorded: events.length, included: items.length, omittedBefore: events.length - items.length, lastIncludedSeq: items.at(-1).seq, items },
    checkpoint: { source: cp.source, recordedEvents: cp.recordedEvents, observed, agentNotes, inferred, missing },
    sourceStatusAtCapture: {
      historical: true,
      observedAt: status.checkedAt,
      note: "Observed on the source computer when this handoff was exported. It is not a live check, and a destination computer cannot tell whether the source is still working.",
      exportForced: Boolean(force && status.mayStillBeWorking),
      status
    },
    coverage: {
      history: "Recorded hook events: prompts, tool calls with their recorded results, and end-of-turn messages. This is not the full transcript.",
      truncation: [
        "At capture, Blocker truncated tool inputs to 2000 characters, and tool results, prompts and final messages to 4000.",
        `${truncatedEvents} of the ${items.length} included events contain a truncated field.`
      ],
      missing
    },
    notes: note,
    capsule: null
  }));
};

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const opt = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=") ?? (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : undefined);
  const target = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.match(/^--(out|note|max-events)$/));
  try {
    if (!target) throw new Error("usage: node src/capsule/export.mjs <session_id | session_ref> [--out FILE] [--note FILE] [--max-events N] [--force]");
    const sessionId = /^\d+$/.test(target) ? resolveSession({ session_ref: Number(target) }) : resolveSession({ session_id: target });
    const note = opt("note") ? readFileSync(opt("note"), "utf8") : null;
    const handoff = exportHandoff(sessionId, { note, maxEvents: Number(opt("max-events")) || 1000, force: args.includes("--force") });
    const out = path.resolve(opt("out") ?? `${sessionId}.handoff.json`);
    const tmp = `${out}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(handoff, null, 1)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(tmp, out);
    console.log(`Exported session ${sessionId}: ${handoff.events.included} of ${handoff.events.totalRecorded} events, last seq ${handoff.events.lastIncludedSeq}.`);
    console.log(handoff.sourceStatusAtCapture.exportForced ? "WARNING: exported with --force while the source may still be working." : "Source status at export: no sign of ongoing work (recorded as historical).");
    console.log(`Wrote ${out} (contains redacted conversation excerpts; treat it as sensitive).`);
    console.log(`Next, on this computer: capsule pack --project "${handoff.session.sourceProjectPath ?? "<project>"}" --handoff "${out}"`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
