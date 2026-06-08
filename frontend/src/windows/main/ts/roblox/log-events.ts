// Pure Roblox-log event matching. No Neutralino/runtime imports so it can be unit-tested
// in isolation and reused by both the live log stream (instance.ts) and tests.

export interface GameEventInfo {
	event: string;
	data: string;
}

interface Entry {
	event: string;
	match: string;
}

// code adapted from https://github.com/pizzaboxer/bloxstrap/blob/main/Bloxstrap/Integrations/ActivityWatcher.cs
export const Entries: Entry[] = [
	{
		event: 'GameJoining',
		match: '[FLog::Output] ! Joining game',
	},
	{
		event: 'GameStartJoining',
		match: '[FLog::SingleSurfaceApp] launchUGCGameInternal',
	},
	{
		event: 'GameJoiningPrivateServer',
		match: '[FLog::GameJoinUtil] GameJoinUtil::joinGamePostPrivateServer',
	},
	{
		event: 'GameJoiningReservedServer',
		match: '[FLog::GameJoinUtil] GameJoinUtil::initiateTeleportToReservedServer',
	},
	{
		event: 'GameJoiningUDMUX',
		match: '[FLog::Network] UDMUX Address = ',
	},
	{
		event: 'GameJoined',
		match: '[FLog::Network] serverId:',
	},
	{
		event: 'GameDisconnected',
		match: '[FLog::Network] Time to disconnect replication data:',
	},
	{
		event: 'GameTeleporting',
		match: '[FLog::SingleSurfaceApp] initiateTeleport',
	},
	{
		event: 'GameMessage',
		match: '[FLog::Output] [BloxstrapRPC]',
	},
	{
		event: 'GameLeaving',
		match: '[FLog::SingleSurfaceApp] leaveUGCGameInternal',
	},
	{
		event: 'ReturnToLuaApp',
		match: '[FLog::SingleSurfaceApp] returnToLuaApp',
	},
];

interface Pattern {
	event: string;
	regex: RegExp;
}

// NOTE: these regexes intentionally omit the /g flag. With /g, RegExp.test()/match()
// advance and persist lastIndex on the shared regex object, making matching stateful
// across lines and silently skipping matches.
export const Patterns: Pattern[] = [
	{
		event: 'GameJoiningEntry',
		regex: /! Joining game '([0-9a-f\-]{36})' place ([0-9]+) at ([0-9\.]+)/,
	},
	{
		event: 'GameJoiningUDMUX',
		regex: /UDMUX Address = ([0-9\.]+), Port = [0-9]+ \| RCC Server Address = ([0-9\.]+), Port = [0-9]+/,
	},
	{
		event: 'GameJoinedEntry',
		regex: /serverId: ([0-9\.]+)\|[0-9]+/,
	},
	{
		event: 'GameMessageEntry',
		regex: /\[BloxstrapRPC\] (.*)/,
	},
	{
		event: 'GameCrashEntry',
		regex: /\[FLog::CrashReportLog\] (.*)/,
	},
];

/**
 * Extracts every game event a single log line produces. This is the exact matching the
 * live log reader uses; emitted data shapes are: full line for string Entries, match[0]
 * for regex Patterns.
 */
export function extractEvents(line: string): GameEventInfo[] {
	const out: GameEventInfo[] = [];
	for (const entry of Entries) {
		if (line.includes(entry.match)) {
			out.push({ event: entry.event, data: line });
		}
	}
	for (const pattern of Patterns) {
		const match = line.match(pattern.regex);
		if (match) {
			out.push({ event: pattern.event, data: match[0] });
		}
	}
	return out;
}

/**
 * Fixed-string set used as the `grep -F` pre-filter for the log stream. It must be a
 * superset of every line `extractEvents` produces output for: it includes every Entry
 * substring plus a literal prefix for each Pattern (CrashReportLog is the only Pattern
 * with no corresponding Entry). Correctness is enforced by log-events.test.ts.
 */
export const MATCH_LITERALS: string[] = Array.from(
	new Set([
		...Entries.map((e) => e.match),
		'! Joining game',
		'UDMUX Address =',
		'serverId:',
		'[BloxstrapRPC]',
		'[FLog::CrashReportLog]',
	])
);

/** True if a line contains any MATCH_LITERALS substring (i.e. `grep -F` would pass it). */
export function matchesAnyLiteral(line: string): boolean {
	return MATCH_LITERALS.some((literal) => line.includes(literal));
}
