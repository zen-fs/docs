#!/usr/bin/env node
/**
 * Populates `.sources/` with the source of each `@zenfs` package, which the API reference is
 * generated from. Run automatically before `astro dev` and `astro build`.
 *
 * By default each package is cloned from GitHub at its latest release tag. Set
 * `ZENFS_LOCAL_SOURCES=1` to symlink sibling checkouts (`../core`, `../dom`, ...) instead, which
 * lets the reference be previewed against uncommitted work.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as io from 'ioium/node';

export interface Package {
	/** Directory under `.sources/`, and the URL segment the package's docs live at. */
	name: string;
	/** Repository within the `zen-fs` organization. */
	repo: string;
	/** Display name, used for the reference's TypeDoc project name. */
	title: string;
}

/** Packages the API reference is generated for, in sidebar order. */
export const packages: Package[] = [
	{ name: 'core', repo: 'core', title: 'ZenFS' },
	{ name: 'dom', repo: 'dom', title: 'ZenFS DOM' },
	{ name: 'archives', repo: 'archives', title: 'ZenFS Archives' },
	{ name: 'cloud', repo: 'cloud', title: 'ZenFS Cloud' },
	{ name: 'emscripten', repo: 'emscripten', title: 'ZenFS Emscripten' },
	{ name: 'linux', repo: 'linux', title: 'ZenFS Linux' },
];

export const root = resolve(import.meta.dirname, '..');

export const sourcesDir = join(root, '.sources');

export interface Staged {
	/** Human-readable version, e.g. `v2.7.1` or `v2.7.1 (local)`. */
	version: string;
	/** The git ref the source came from, used to build links to GitHub. */
	ref: string;
	/** The repository the source came from. */
	repo: string;
}

/** Where the versions each reference was built from are recorded. */
export const versionsPath = join(sourcesDir, 'versions.json');

/** Read what was staged. Returns an empty object when sources have not been fetched yet. */
export function versions(): Record<string, Staged> {
	if (!existsSync(versionsPath)) return {};
	return JSON.parse(readFileSync(versionsPath, 'utf-8')) as Record<string, Staged>;
}

function git(label: string, cwd: string, ...args: string[]): string {
	using _ = io.withCWD(cwd);
	return io.trackCommand(label, 'git', ...args).trim();
}

/** The most recent release tag for a repository. */
function latestTag(pkg: Package): string {
	const url = `https://github.com/zen-fs/${pkg.repo}`;
	const output = git(`${pkg.name}: finding latest release`, root, '-c', 'versionsort.suffix=-', 'ls-remote', '--tags', '--refs', '--sort=-v:refname', url, 'v*');
	const tag = output.split('\n')[0]?.split('refs/tags/')[1];
	if (!tag) io.exit(`No release tags found for zen-fs/${pkg.repo}`);
	return tag;
}

/** The tag a staged clone is checked out at, or nothing if it is not at one. */
function currentTag(path: string): string | undefined {
	try {
		return execFileSync('git', ['describe', '--tags', '--exact-match'], {
			cwd: path,
			encoding: 'utf-8',
			stdio: ['ignore', 'pipe', 'ignore'],
		}).trim();
	} catch {
		return undefined;
	}
}

function install(pkg: Package, dir: string): void {
	if (existsSync(join(dir, 'node_modules'))) return;
	using _ = io.withCWD(dir);
	const command = existsSync(join(dir, 'package-lock.json')) ? 'ci' : 'install';
	io.trackCommand(`${pkg.name}: installing dependencies`, 'npm', command, '--ignore-scripts', '--no-audit', '--no-fund');
}

/** Rewrites a staged package's `tsconfig.json` without its `typedocOptions`. */
function writeTsconfig(from: string, to: string): void {
	const config = JSON.parse(readFileSync(join(from, 'tsconfig.json'), 'utf-8')) as Record<string, unknown>;
	delete config['typedocOptions'];
	io.writeJSON(join(to, 'tsconfig.json'), config);
}

function remove(path: string): void {
	const stats = lstatSync(path, { throwIfNoEntry: false });
	if (stats?.isSymbolicLink()) unlinkSync(path);
	else if (stats) rmSync(path, { recursive: true, force: true });
}

/** Stages a sibling checkout without writing anything into it */
function link(pkg: Package): Staged {
	const target = resolve(root, '..', pkg.name);
	if (!existsSync(target)) io.exit(`ZENFS_LOCAL_SOURCES is set but ${target} does not exist`);

	const { version } = JSON.parse(readFileSync(join(target, 'package.json'), 'utf-8')) as { version: string };

	io.track(`${pkg.name}: linking ${target}`, () => {
		const path = join(sourcesDir, pkg.name);
		remove(path);
		mkdirSync(path);
		symlinkSync(join(target, 'src'), join(path, 'src'), 'dir');
		if (existsSync(join(target, 'node_modules'))) symlinkSync(join(target, 'node_modules'), join(path, 'node_modules'), 'dir');
		writeTsconfig(target, path);
	});

	if (!existsSync(join(target, 'node_modules'))) io.warn(`${pkg.name}: no node_modules in ${target}, imports may not resolve`);

	return { version: `v${version} (local)`, ref: 'main', repo: pkg.repo };
}

function clone(pkg: Package): Staged {
	const tag = latestTag(pkg);
	const path = join(sourcesDir, pkg.name);

	if (existsSync(join(path, '.git')) && currentTag(path) === tag) {
		io.debug(`${pkg.name}: already at ${tag}`);
	} else {
		remove(path);
		git(`${pkg.name}: cloning ${tag}`, root, 'clone', '--quiet', '--depth', '1', '--branch', tag, `https://github.com/zen-fs/${pkg.repo}`, path);
	}

	install(pkg, path);
	writeTsconfig(path, path);
	return { version: tag, ref: tag, repo: pkg.repo };
}

if (import.meta.main) {
	io.setCommandTimeout(600_000);
	io._setDebugOutput(!!process.env.DEBUG);

	const local = process.env.ZENFS_LOCAL_SOURCES === '1';
	mkdirSync(sourcesDir, { recursive: true });

	const staged: Record<string, Staged> = {};
	for (const pkg of packages) {
		staged[pkg.name] = local ? link(pkg) : clone(pkg);
	}

	io.writeJSON(versionsPath, staged);

	console.log();
	io.table<[string, Staged]>(
		[
			{ name: 'Package', text: ([name]) => `@zenfs/${name}`, grow: 0 },
			{ name: 'Version', text: ([, source]) => source.version, grow: 0 },
			{ name: 'Source', text: ([, source]) => `zen-fs/${source.repo}@${source.ref}` },
		],
		{ indent: 1 },
		Object.entries(staged)
	);
}
