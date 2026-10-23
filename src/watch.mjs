// Independent limit observer. The hook-based trigger needs Codex to fire Stop
// when a turn ends at a real usage limit, which is neither documented nor yet
// observed. This polls the transcripts of recently active recorded sessions,
// applies the same classifier, and claims takeover through the same per-signal
// guard, so the hook and the watcher never both open a chat for one signal.
// It reads local files only and needs no Codex cooperation.
// usage: node src/watch.mjs [--once] [--interval=30]
import { fileURLToPath } from "node:url";
import { listSessionIds, readEvents } from "./store.mjs";
import { readUsageSignals } from "./source.mjs";
import { claimTakeover, openTakeover } from "./takeover.mjs";

const RECENT_MS = 24 * 3600_000;

/** One pass over recently active sessions; resolves to the sessions it opened takeover for. */
export const watchOnce = async () => {
  const opened = [];
  for (const { id, mtimeMs } of listSessionIds()) {
    if (Date.now() - mtimeMs > RECENT_MS) break; // newest first
    const transcript = readEvents(id).findLast((e) => e.transcript)?.transcript;
    if (!transcript) continue;
    const usage = readUsageSignals(transcript);
    if (usage.status !== "limit_reached") continue;
    if (!claimTakeover(id, `limit@${usage.signal.at}`)) continue;
    await openTakeover(id, `usage limit seen by the watcher (${usage.signal.kind} at ${usage.signal.at})`);
    opened.push(id);
  }
  return opened;
};

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const once = process.argv.includes("--once");
  const interval = Number(process.argv.find((a) => a.startsWith("--interval="))?.split("=")[1]) || 30;
  do {
    const opened = await watchOnce().catch((e) => (console.error(`watch: ${e.message}`), []));
    for (const id of opened) console.log(`${new Date().toISOString()} takeover opened for ${id}`);
    if (!once) await new Promise((r) => setTimeout(r, interval * 1000));
  } while (!once);
}
