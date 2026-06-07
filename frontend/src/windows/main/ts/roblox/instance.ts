import { events, filesystem, os } from '@neutralinojs/lib';
import path from 'path-browserify';
import { getValue } from '../../components/settings';
import { Notification } from '../tools/notifications';
import { shell } from '../tools/shell';
import { isProcessAlive, sleep } from '../utils';
import { RobloxDelegate } from './delegate';
import { RobloxUtils } from './utils';
import Roblox from './index';
import Logger from '@/windows/main/ts/utils/logger';

type EventHandler = (data?: any) => void;
type Event = 'exit' | 'gameInfo' | 'gameEvent';
export interface GameEventInfo {
	event: string;
	data: string;
}

interface Entry {
	event: string;
	match: string;
}

// code adapted from https://github.com/pizzaboxer/bloxstrap/blob/main/Bloxstrap/Integrations/ActivityWatcher.cs
const Entries: Entry[] = [
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

// NOTE: these regexes intentionally omit the /g flag. With /g, RegExp.test()
// advances and persists lastIndex on the shared regex object, making it stateful
// across lines and silently skipping matches. Without /g, .test() is stateless
// and .match() still returns match[0] (the full match), so emitted data is unchanged.
const Patterns: Pattern[] = [
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

export class RobloxInstance {
	private events: { [key: string]: EventHandler[] } = {};
	private gameInstance: number | null = null;
	private latestLogPath: string | null = null;
	private watcherId: number | null = null;
	private isWatching = false;
	private lastPosition = 0;
	private lastFileSize = 0;
	private logsDirectory: string | null = null;
	private watchHandler: (evt: any) => void = () => {};
	private pollInterval: NodeJS.Timeout | null = null;

	// The directory watcher is the primary trigger for reading new log content; a
	// slow interval acts only as a safety net in case the watcher misses an event.
	private readonly SAFETY_POLL_INTERVAL = 1000;
	private readonly BATCH_SIZE = 32 * 1024; // 32KB max read per pass
	private readonly PROCESSING_QUEUE_SIZE = 10; // Max queued processing tasks

	// Reentrancy guard so the watcher and the safety poll can't read concurrently
	// and race on lastPosition / lastFileSize.
	private isReading = false;

	// Non-blocking processing queue
	private processingQueue: string[][] = [];
	private isProcessing = false;

	watchLogs: boolean;
	constructor(watch: boolean) {
		this.watchLogs = watch;
	}

	public on(event: Event, handler: EventHandler) {
		if (!this.events[event]) {
			this.events[event] = [];
		}
		this.events[event].push(handler);
	}

	public off(event: Event, handler: EventHandler) {
		if (!this.events[event]) return;
		const index = this.events[event].indexOf(handler);
		if (index !== -1) {
			this.events[event].splice(index, 1);
		}
	}

	public emit(event: Event, data?: any) {
		if (!this.events[event]) return;
		this.events[event].forEach((handler) => handler(data));
	}

	public async init() {
		if (!(await RobloxUtils.hasRoblox())) return;
	}

	public async start(url?: string) {
		if (this.gameInstance) throw new Error('An instance is already running');

		Logger.info('Opening Roblox instance');
		await RobloxDelegate.toggle(false);

		// Get the configured Roblox path (either custom or auto-detected)
		const robloxPath = Roblox.path;
		if (!robloxPath) {
			throw new Error('Roblox installation not found. Cannot launch.');
		}

		// Check if legacy resolution is enabled
		const useLegacyResolution = (await getValue<boolean>('mods.general.fix_res')) === true;

		if (useLegacyResolution) {
			// Launch binary directly with -AppleMagnifiedMode YES for legacy resolution
			// Note: This may break voice chat as we're not using deeplink
			const binaryPath = path.join(robloxPath, 'Contents/MacOS/RobloxPlayer');

			if (url) {
				// Launch with URL and legacy resolution argument
				await shell('open', ['-a', binaryPath, '--args', '-AppleMagnifiedMode', 'YES', url]);
				Logger.info('Opening Roblox from URL with legacy resolution (may break voice chat).');
			} else {
				// Launch with legacy resolution argument only
				await shell('open', ['-a', binaryPath, '--args', '-AppleMagnifiedMode', 'YES']);
				Logger.info('Opening Roblox with legacy resolution (may break voice chat).');
			}
		} else {
			// Normal launch via deeplink (supports voice chat)
			// Use -a flag to ensure we launch the correct Roblox installation
			if (url) {
				await shell('open', ['-a', robloxPath, url]);
				Logger.info(`Opening Roblox from URL using: ${robloxPath}`);
			} else {
				await shell('open', ['-a', robloxPath, 'roblox-player:']);
				Logger.info(`Opening Roblox from deeplink using: ${robloxPath}`);
			}
		}

		await sleep(1000);
		if ((await getValue<boolean>('roblox.behavior.delegate')) === true) {
			await RobloxDelegate.toggle(true);
		}

		const robloxProcess = (await shell('pgrep', ['-f', 'Roblox'])).stdOut.trim().split('\n');
		const processInfos = await Promise.all(
			robloxProcess.map(async (pid) => ({
				pid,
				info: (
					await shell(`ps -p ${pid} -o command=`, [], { completeCommand: true, skipStderrCheck: true })
				).stdOut.trim(),
			}))
		);
		for (const { pid, info } of processInfos) {
			if (info.length < 2) continue;
			const processFileName = path.basename(info);
			if (processFileName.includes('RobloxPlayer')) {
				this.gameInstance = Number.parseInt(pid);
			}
		}

		if (this.gameInstance == null) {
			throw new Error("Couldn't find the RobloxPlayer process. Exiting launch.");
		}

		const quitEventHandler = () => {
			events.off('instance:quit', quitEventHandler);
			this.emit('exit');
			this.quit();
		};

		events.off('instance:quit', quitEventHandler);
		events.on('instance:quit', quitEventHandler);

		this.isWatching = true;
		if (this.watchLogs) {
			await this.setupLogsWatcher().catch(async (err) => {
				Logger.error("Couldn't start logs watcher:", err);
				new Notification({
					title: 'Unable to start Roblox',
					content: 'AppleBlox was unable to monitor your logs due to an error. Roblox has been closed.',
					sound: 'hero',
				}).show();
				this.emit('exit');
				await this.quit();
				return;
			});
		}

		const intervalId = setInterval(async () => {
			if (this.gameInstance && !(await isProcessAlive(this.gameInstance))) {
				this.emit('exit');
				await this.cleanup();
				Logger.info('Instance is null, stopping.');
				clearInterval(intervalId);
			}
		}, 1000);
	}

	private async checkForNewContent() {
		if (!this.isWatching || !this.latestLogPath || this.isReading) return;

		this.isReading = true;
		try {
			// Get file stats (fast operation)
			const stats = await filesystem.getStats(this.latestLogPath);
			this.lastFileSize = stats.size;

			// Drain all new content in batch-sized chunks so a large burst is fully
			// caught up within a single invocation (the watcher may fire only once).
			while (stats.size > this.lastPosition) {
				const availableBytes = stats.size - this.lastPosition;
				const readSize = Math.min(availableBytes, this.BATCH_SIZE);

				const content = await filesystem.readFile(this.latestLogPath, {
					pos: this.lastPosition,
					size: readSize,
				});

				this.lastPosition += readSize;

				// Queue processing asynchronously (non-blocking)
				if (content.length > 0) {
					const lines = content.split('\n');
					this.queueProcessing(lines);
				}
			}
		} catch (err) {
			Logger.error('Error checking log file:', err);
		} finally {
			this.isReading = false;
		}
	}

	private queueProcessing(lines: string[]) {
		// Add to queue, but limit queue size to prevent memory issues
		if (this.processingQueue.length < this.PROCESSING_QUEUE_SIZE) {
			this.processingQueue.push(lines);
		} else {
			Logger.warn('Processing queue full, dropping lines');
		}

		// Start processing if not already running
		if (!this.isProcessing) {
			this.processQueueAsync();
		}
	}

	private async processQueueAsync() {
		if (this.isProcessing) return;
		this.isProcessing = true;

		// Use requestIdleCallback or setTimeout to process during idle time
		const processNext = () => {
			if (this.processingQueue.length === 0) {
				this.isProcessing = false;
				return;
			}

			const lines = this.processingQueue.shift();
			if (lines) {
				this.processLines(lines);
			}

			// Continue processing in next tick (non-blocking)
			setTimeout(processNext, 0);
		};

		// Start processing in next tick
		setTimeout(processNext, 0);
	}

	private async setupLogsWatcher() {
		this.logsDirectory = path.join(await os.getEnv('HOME'), 'Library/Logs/Roblox');
		let tries = 10;

		// Wait for log file to appear
		while (this.latestLogPath == null) {
			if (tries < 1) {
				throw new Error(
					`Couldn't find a .log file created less than 3 seconds ago in "${this.logsDirectory}". Stopping.`
				);
			}
			const latestFile = (
				await shell(`cd "${this.logsDirectory}" && ls -t | head -1`, [], { completeCommand: true })
			).stdOut.trim();
			const latestFilePath = path.join(this.logsDirectory, latestFile);
			const createdAt = (await filesystem.getStats(latestFilePath)).createdAt;
			const timeDifference = (Date.now() - createdAt) / 1000;
			if (timeDifference < 3) {
				Logger.info(`Found latest log file: "${latestFilePath}"`);
				this.latestLogPath = latestFilePath;
			} else {
				tries--;
				Logger.info(
					`[Roblox.Instance] Couldn't find a .log file created less than 3 seconds ago in "${this.logsDirectory}" (${tries}). Retrying in 1 second.`
				);
				await sleep(1000);
			}
		}

		// Read initial content immediately after finding the file
		try {
			const initialStats = await filesystem.getStats(this.latestLogPath);
			if (initialStats.size > 0) {
				// Read initial content in chunks to avoid blocking
				const chunkSize = this.BATCH_SIZE;
				let position = 0;

				while (position < initialStats.size) {
					const readSize = Math.min(chunkSize, initialStats.size - position);
					const chunk = await filesystem.readFile(this.latestLogPath, {
						pos: position,
						size: readSize,
					});

					const lines = chunk.split('\n');
					this.queueProcessing(lines);

					position += readSize;

					// Yield control to prevent blocking
					await new Promise((resolve) => setTimeout(resolve, 0));
				}

				// Set position after processing initial content
				this.lastPosition = initialStats.size;
				this.lastFileSize = initialStats.size;
			} else {
				this.lastPosition = 0;
				this.lastFileSize = 0;
			}
		} catch (err) {
			Logger.error('Error reading initial log content:', err);
			this.lastPosition = 0;
			this.lastFileSize = 0;
		}

		// Set up the directory watcher as the primary, event-driven trigger.
		this.watcherId = await filesystem.createWatcher(this.logsDirectory);
		Logger.info(`Created directory watcher with ID: ${this.watcherId}`);

		this.watchHandler = async (evt: any) => {
			if (!this.isWatching || !this.latestLogPath || evt.detail.id !== this.watcherId) return;

			// Trigger immediate check if file changed
			if (evt.detail.path === this.latestLogPath) {
				// Use setTimeout to make it non-blocking
				setTimeout(() => {
					this.checkForNewContent().catch(Logger.error);
				}, 0);
			}
		};

		events.off('watchFile', this.watchHandler);
		events.on('watchFile', this.watchHandler);

		// Slow safety-net poll: only catches content the watcher might have missed.
		this.pollInterval = setInterval(() => {
			this.checkForNewContent().catch((err) => {
				Logger.error('Error in safety poll:', err);
			});
		}, this.SAFETY_POLL_INTERVAL);
	}

	private processLines(lines: string[]) {
		try {
			// Single pass over the batch: each line is checked against every string
			// Entry and every regex Pattern, emitting the same events (and same data
			// shape) the previous multi-pass version did, in log order.
			for (const line of lines) {
				for (const entry of Entries) {
					if (line.includes(entry.match)) {
						this.emit('gameEvent', { event: entry.event, data: line });
					}
				}

				for (const pattern of Patterns) {
					const match = line.match(pattern.regex);
					if (match) {
						this.emit('gameEvent', { event: pattern.event, data: match[0] });
					}
				}
			}
		} catch (err) {
			Logger.error('Error processing lines:', err);
		}
	}

	public async cleanup() {
		this.isWatching = false;
		this.gameInstance = null;
		this.watchLogs = false;

		// Clear polling interval
		if (this.pollInterval) {
			clearInterval(this.pollInterval);
			this.pollInterval = null;
		}

		// Clear processing queue
		this.processingQueue = [];
		this.isProcessing = false;
		this.isReading = false;

		if (this.watcherId) {
			try {
				await filesystem.removeWatcher(this.watcherId);
				events.off('watchFile', this.watchHandler);
			} catch (err) {
				Logger.error('Error removing file watcher:', err);
			}
			this.watcherId = null;
		}

		this.latestLogPath = null;
		this.lastPosition = 0;
		this.lastFileSize = 0;
		this.logsDirectory = null;
	}

	public async quit(withoutRoblox = false) {
		if (this.gameInstance == null) throw new Error("The instance hasn't be started yet");
		const gameInstancePid = this.gameInstance;
		await this.cleanup();
		if (withoutRoblox) {
			Logger.info('Closing this instance');
		} else {
			Logger.info('Quitting Roblox');
			await shell('kill', ['-9', gameInstancePid]);
		}
	}
}
