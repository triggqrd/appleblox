import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Entries, Patterns, extractEvents, MATCH_LITERALS, matchesAnyLiteral } from './log-events';

// Representative real-form log lines: one per event type, plus noise that must be ignored.
const SAMPLE_LINES = [
	"2026-06-08T00:00:00.000Z,0.0,abc,6 [FLog::Output] ! Joining game '5b8e1c2a-3f4d-4a5b-8c9d-0e1f2a3b4c5d' place 123456 at 12.34.56.78",
	'2026-06-08T00:00:00.000Z,0.0,abc,6 [FLog::SingleSurfaceApp] launchUGCGameInternal',
	'2026-06-08T00:00:00.000Z,0.0,abc,6 [FLog::GameJoinUtil] GameJoinUtil::joinGamePostPrivateServer',
	'2026-06-08T00:00:00.000Z,0.0,abc,6 [FLog::GameJoinUtil] GameJoinUtil::initiateTeleportToReservedServer',
	'2026-06-08T00:00:00.000Z,0.0,abc,6 [FLog::Network] UDMUX Address = 12.34.56.78, Port = 49152 | RCC Server Address = 98.76.54.32, Port = 53640',
	'2026-06-08T00:00:00.000Z,0.0,abc,6 [FLog::Network] serverId: 12.34.56.78|49152',
	'2026-06-08T00:00:00.000Z,0.0,abc,6 [FLog::Network] Time to disconnect replication data: 42',
	'2026-06-08T00:00:00.000Z,0.0,abc,6 [FLog::SingleSurfaceApp] initiateTeleport',
	'2026-06-08T00:00:00.000Z,0.0,abc,6 [FLog::Output] [BloxstrapRPC] {"command":"SetRichPresence"}',
	'2026-06-08T00:00:00.000Z,0.0,abc,6 [FLog::SingleSurfaceApp] leaveUGCGameInternal',
	'2026-06-08T00:00:00.000Z,0.0,abc,6 [FLog::SingleSurfaceApp] returnToLuaApp',
	'2026-06-08T00:00:00.000Z,0.0,abc,6 [FLog::CrashReportLog] something bad happened',
	// noise: must produce no events and be filtered out by the literal pre-filter
	'2026-06-08T00:00:00.000Z,0.0,abc,6 [FLog::Output] Loading asset 123',
	'2026-06-08T00:00:00.000Z,0.0,abc,6 [FLog::Network] Sending packet to peer',
	'',
];

const eventsOf = (lines: string[]) => lines.flatMap(extractEvents);

describe('log-events MATCH_LITERALS coverage', () => {
	it('covers every Entry substring', () => {
		for (const entry of Entries) {
			expect(matchesAnyLiteral(entry.match)).toBe(true);
		}
	});

	it('exercises every Pattern and any event-producing line passes the pre-filter', () => {
		const firedEvents = new Set(eventsOf(SAMPLE_LINES).map((e) => e.event));
		for (const pattern of Patterns) {
			expect(firedEvents.has(pattern.event)).toBe(true);
		}
		for (const line of SAMPLE_LINES) {
			if (extractEvents(line).length > 0) {
				expect(matchesAnyLiteral(line)).toBe(true);
			}
		}
	});
});

describe('grep pre-filter preserves all events (replay-diff)', () => {
	it('embedded sample: filtered === unfiltered', () => {
		const unfiltered = eventsOf(SAMPLE_LINES);
		const filtered = eventsOf(SAMPLE_LINES.filter(matchesAnyLiteral));
		expect(filtered).toEqual(unfiltered);
		expect(unfiltered.length).toBeGreaterThan(0);
	});

	it('noise produces no events and is filtered out', () => {
		const noise = '2026-06-08T00:00:00.000Z,0.0,abc,6 [FLog::Output] Loading asset 123';
		expect(extractEvents(noise)).toEqual([]);
		expect(matchesAnyLiteral(noise)).toBe(false);
	});

	it('real Roblox log (if present): filtered === unfiltered', () => {
		const dir = join(homedir(), 'Library', 'Logs', 'Roblox');
		let files: string[] = [];
		try {
			files = readdirSync(dir).filter((f) => f.endsWith('.log'));
		} catch {
			return; // no logs available (e.g. CI) - embedded sample already proves the invariant
		}
		if (files.length === 0) return;
		const largest = files.map((f) => ({ f, size: statSync(join(dir, f)).size })).sort((a, b) => b.size - a.size)[0].f;
		const lines = readFileSync(join(dir, largest), 'utf8').split('\n');
		const unfiltered = eventsOf(lines);
		const filtered = eventsOf(lines.filter(matchesAnyLiteral));
		expect(filtered).toEqual(unfiltered);
	});
});
