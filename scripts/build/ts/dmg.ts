import BuildConfig from '@root/build.config';
import child_process from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Signale } from 'signale';
import { version } from '../../../package.json';
import { filterArchitectures, getArchitectureFilter } from './utils';

async function createDMG(sourceFolder: string, outputName: string, volumeName: string, backgroundPath: string) {
	const args = [
		'create-dmg',
		`--volname "${volumeName}"`,
		`--background "${backgroundPath}"`,
		'--window-pos 200 120',
		'--window-size 660 400',
		'--icon-size 160',
		`--icon "${BuildConfig.appName}.app" 180 170`,
		'--app-drop-link 480 170',
		`"${outputName}.dmg"`,
		`"${sourceFolder}"`,
	];

	const dmgPath = `${outputName}.dmg`;
	if (existsSync(dmgPath)) rmSync(dmgPath);

	const env = { ...process.env };
	env.PATH = env.PATH?.split(':').filter((p) => !p.includes('node_modules/.bin')).join(':');

	await new Promise<void>((resolve, reject) => {
		child_process.exec(args.join(' '), { env }, (error) => {
			if (error) reject(error);
			else resolve();
		});
	});
}

async function build() {
	const logger = new Signale({ scope: 'dmg-builder' });

	if (!BuildConfig.mac) {
		logger.fatal('No macOS configuration found in build.config.ts');
		return;
	}

	const architectureFilter = getArchitectureFilter();
	const targetArchs = filterArchitectures(BuildConfig.mac.architecture, architectureFilter);

	if (targetArchs.length === 0) {
		logger.fatal(`No valid architectures found for filter: ${architectureFilter}`);
		return;
	}

	const backgroundPath = resolve('./scripts/build/assets/bg.png');
	if (!existsSync(backgroundPath)) {
		logger.fatal(`Background image not found: ${backgroundPath}`);
		return;
	}

	logger.info(`Creating DMG files for architectures: ${targetArchs.join(', ')}`);

	const dmgPromises = targetArchs.map(async (arch) => {
		const appTime = performance.now();
		const archLogger = new Signale({ scope: `dmg-${arch}`, interactive: false });

		archLogger.await(`Creating DMG for ${arch}`);

		const appFolder = resolve(`./dist/mac_${arch}/${BuildConfig.appName}.app`);

		if (!existsSync(appFolder)) {
			archLogger.fatal(`App bundle not found: ${appFolder}`);
			throw new Error(`App bundle not found for ${arch}`);
		}

		const infoPlistPath = join(appFolder, 'Contents/Info.plist');
		const mainExecutablePath = join(appFolder, 'Contents/MacOS/main');

		if (!existsSync(infoPlistPath) || !existsSync(mainExecutablePath)) {
			archLogger.fatal(`Invalid app bundle: ${appFolder}`);
			throw new Error(`Invalid app bundle for ${arch}`);
		}

		try {
			const dmgName = `${BuildConfig.appName}-${version}_${arch}`;
			const dmgOutput = join(resolve('./dist'), dmgName);

			await createDMG(resolve(`./dist/mac_${arch}`), dmgOutput, BuildConfig.appName, backgroundPath);

			archLogger.complete(`DMG for ${arch} created in ${((performance.now() - appTime) / 1000).toFixed(3)}s`);
			return { arch, success: true };
		} catch (err) {
			archLogger.fatal(`Failed to create DMG for ${arch}: ${err}`);
			return { arch, success: false, error: err };
		}
	});

	const results = await Promise.allSettled(dmgPromises);
	const successful = results.filter((r) => r.status === 'fulfilled' && r.value.success);
	const failed = results.filter((r) => r.status === 'rejected' || (r.status === 'fulfilled' && !r.value.success));

	if (failed.length > 0) {
		logger.error(`${failed.length} DMG creation(s) failed, ${successful.length} succeeded`);
		process.exit(1);
	}

	logger.success(`DMG creation completed for ${successful.length} architecture(s)`);
}

if (import.meta.main) {
	build();
}
