import { events, filesystem, os } from '@neutralinojs/lib';
import path from 'path-browserify';
import { getValue } from '../../components/settings';
import { Notification } from '../tools/notifications';
import { escapeShellArg, shell, spawn, type SpawnEventEmitter } from '../tools/shell';
import { isProcessAlive, sleep } from '../utils';
import { RobloxDelegate } from './delegate';
import { RobloxUtils } from './utils';
import Roblox from './index';
import Logger from '@/windows/main/ts/utils/logger';
import { extractEvents, MATCH_LITERALS } from './log-events';

export type { GameEventInfo } from './log-events';

type EventHandler = (data?: any) => void;
type Event = 'exit' | 'gameInfo' | 'gameEvent';

export class RobloxInstance {
	private events: { [key: string]: EventHandler[] } = {};
	private gameInstance: number | null = null;
	private latestLogPath: string | null = null;
	private isWatching = false;

	// Long-lived `sh -c 'tail -f LOG | grep -F …'` process; only event-relevant log lines
	// are streamed back over stdout, which we reassemble into whole lines.
	private logStreamProcess: SpawnEventEmitter | null = null;
	private stdoutBuffer = '';

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
			await this.setupLogStream().catch(async (err) => {
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

	/**
	 * Finds the current session's Roblox log and streams its event-relevant lines via
	 * `tail -f | grep`. The OS handles change-detection; grep ships only matching lines.
	 */
	private async setupLogStream() {
		const logsDirectory = path.join(await os.getEnv('HOME'), 'Library/Logs/Roblox');
		let tries = 10;

		// Wait for this session's log file to appear (created less than 3 seconds ago).
		while (this.latestLogPath == null) {
			if (tries < 1) {
				throw new Error(`Couldn't find a .log file created less than 3 seconds ago in "${logsDirectory}". Stopping.`);
			}
			const latestFile = (
				await shell(`cd "${logsDirectory}" && ls -t | head -1`, [], { completeCommand: true })
			).stdOut.trim();
			const latestFilePath = path.join(logsDirectory, latestFile);
			const createdAt = (await filesystem.getStats(latestFilePath)).createdAt;
			const timeDifference = (Date.now() - createdAt) / 1000;
			if (timeDifference < 3) {
				Logger.info(`Found latest log file: "${latestFilePath}"`);
				this.latestLogPath = latestFilePath;
			} else {
				tries--;
				Logger.info(
					`[Roblox.Instance] Couldn't find a .log file created less than 3 seconds ago in "${logsDirectory}" (${tries}). Retrying in 1 second.`
				);
				await sleep(1000);
			}
		}

		// `tail -n +1 -f` backfills the (fresh) session log then follows; `grep -F` (fixed
		// strings, --line-buffered to avoid pipe buffering) pre-filters to event-relevant
		// lines. Precise matching still happens in JS via processLines, so this is just a
		// superset filter and emitted events are unchanged.
		const literalArgs = MATCH_LITERALS.map((literal) => `-e ${escapeShellArg(literal)}`).join(' ');
		const pipe = `tail -n +1 -f ${escapeShellArg(this.latestLogPath)} | grep -F --line-buffered ${literalArgs}`;

		this.stdoutBuffer = '';
		this.logStreamProcess = await spawn('sh', ['-c', pipe], { skipStderrCheck: true });
		Logger.info(`Started log stream for: "${this.latestLogPath}"`);

		this.logStreamProcess.on('stdOut', (data: string) => {
			this.stdoutBuffer += data;
			const lines = this.stdoutBuffer.split('\n');
			// Keep the last (possibly partial) segment buffered until its newline arrives.
			this.stdoutBuffer = lines.pop() ?? '';
			if (lines.length > 0) {
				this.processLines(lines);
			}
		});

		this.logStreamProcess.on('stdErr', (data: string) => {
			Logger.error('[LogStream]', data);
		});

		this.logStreamProcess.on('exit', (code: number) => {
			if (this.isWatching) {
				Logger.warn(`Log stream exited unexpectedly with code ${code}`);
			}
		});
	}

	private processLines(lines: string[]) {
		try {
			for (const line of lines) {
				for (const event of extractEvents(line)) {
					this.emit('gameEvent', event);
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

		const logPath = this.latestLogPath;

		// Kill the tracked `sh`. That orphans its `tail`/`grep` children, so also pkill the
		// `tail` by the (unique) log path; once `tail` dies, `grep` hits EOF and exits too.
		if (this.logStreamProcess) {
			try {
				await this.logStreamProcess.kill(true);
			} catch (err) {
				Logger.error('Error killing log stream:', err);
			}
			this.logStreamProcess = null;
		}
		if (logPath) {
			try {
				await shell('pkill', ['-f', logPath], { skipStderrCheck: true });
			} catch {
				// pkill exits non-zero when nothing matched (already gone) - ignore.
			}
		}

		this.stdoutBuffer = '';
		this.latestLogPath = null;
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
