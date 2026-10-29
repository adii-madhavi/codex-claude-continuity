// The portable handoff object shared with Session Capsule
// (kind "session-capsule.handoff", version 1.x). This mirrors Session Capsule's
// schemas/v1/handoff.schema.json; scripts/check-capsule.mjs checks that the two
// accept the same document. Recorder sections (checkpoint, events) keep
// Blocker's own shape.

import { z } from "zod";

export const HANDOFF_KIND = "session-capsule.handoff";
export const HANDOFF_VERSION = "1.0";

const sha = z.string().regex(/^[0-9a-f]{64}$/);
const uuid = z.string().regex(/^[0-9a-f-]{36}$/);
const iso = z.string().max(40);
const strings = z.array(z.string().max(2000)).max(200);

export const handoffSchema = z.strictObject({
  kind: z.literal(HANDOFF_KIND),
  version: z.string().regex(/^1\.[0-9]+$/),
  handoffId: uuid,
  createdBy: z.strictObject({ name: z.string().max(100), version: z.string().max(50) }),
  capturedAt: iso,
  source: z.strictObject({
    tool: z.enum(["codex", "claude-code", "manual"]),
    surface: z.enum(["codex-desktop", "codex-cli", "claude-desktop-chat", "claude-desktop-cowork", "claude-code-desktop", "claude-code-cli", "claude-code-ide", "unknown"]),
    platform: z.string().max(40),
    toolVersion: z.string().max(100).nullable(),
    model: z.string().max(200).nullable()
  }),
  session: z.strictObject({
    originalId: z.string().max(200).nullable(),
    originalRef: z.number().int().nullable(),
    sourceProjectPath: z.string().max(4096).nullable(),
    firstRecordedAt: iso.nullable(),
    lastRecordedAt: iso.nullable()
  }),
  events: z.strictObject({
    totalRecorded: z.number().int().min(0),
    included: z.number().int().min(0),
    omittedBefore: z.number().int().min(0),
    lastIncludedSeq: z.number().int().min(0),
    items: z.array(z.looseObject({})).max(5000)
  }).nullable(),
  checkpoint: z.looseObject({
    observed: z.looseObject({}),
    agentNotes: z.looseObject({}),
    inferred: z.looseObject({}),
    missing: strings
  }).nullable(),
  sourceStatusAtCapture: z.strictObject({
    historical: z.literal(true),
    observedAt: iso,
    note: z.string().max(1000),
    exportForced: z.boolean(),
    status: z.looseObject({})
  }).nullable(),
  coverage: z.strictObject({ history: z.string().max(1000), truncation: strings, missing: strings }),
  notes: z.string().max(200_000).nullable(),
  capsule: z.strictObject({
    id: uuid,
    formatVersion: z.string().max(10),
    mode: z.enum(["full", "context-only"]),
    createdAt: iso,
    encrypted: z.boolean(),
    fingerprint: sha,
    files: z.array(z.strictObject({
      path: z.string().min(1).max(1024),
      sha256: sha,
      size: z.number().int().min(0),
      status: z.enum(["unchanged", "modified", "added", "untracked", "unknown"])
    })).max(65_000),
    deletions: z.array(z.string().max(1024)).max(65_000)
  }).nullable()
});

/** Validates a handoff object; throws with the first few problems. */
export const parseHandoff = (value) => {
  const result = handoffSchema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "/"}: ${i.message}`).join("; ");
    throw new Error(`Not a valid ${HANDOFF_KIND} 1.x object: ${issues}`);
  }
  return value;
};

// What Session Capsule writes next to the handoff on the destination (import.json).
export const importRecordSchema = z.looseObject({
  kind: z.literal("session-capsule.import"),
  version: z.string().regex(/^1\.[0-9]+$/),
  capsuleId: uuid,
  importedAt: iso,
  destinationRoot: z.string().max(4096),
  mode: z.enum(["full", "context-only"]),
  importId: uuid.nullable(),
  filesApplied: z.boolean(),
  contextCheck: z.looseObject({}).nullable(),
  sourceStatus: z.literal("historical-only")
});
