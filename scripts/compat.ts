import type { Coverage, MarkEntry, Status } from '@zenfs/devel/node_compat';
import { Analysis, NodeRepository, zenfs } from '@zenfs/devel/node_compat';
import { savedRepo } from '@zenfs/devel/node_compat/config';
import * as io from 'ioium/node';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, sourcesDir, versions, type Staged } from './sources.ts';

export interface ReleaseCompat {
	version: string;
	/** ISO date */
	date: string;
	prs: { covered: number; total: number };
	apis: { covered: number; total: number };
}

export interface Compat {
	/** The version of `@zenfs/core` that was checked */
	zenfs: string;
	latest: ReleaseCompat;
	/** The newest fully covered release, when the latest one is not */
	lastComplete?: ReleaseCompat;
	/** APIs in the latest release that ZenFS has */
	implemented: number;
	/** Status counts for the PRs in the latest release */
	prs: Record<Status, number>;
	pending: { number: number; title: string }[];
	missing: string[];
	/** APIs that are deliberately not implemented */
	unsupported: { id: string; note?: string }[];
}

export const compatPath = join(sourcesDir, 'compat.json');

function nodeRepository(): string {
	const existing = process.env.NODE_REPO || savedRepo();
	if (existing) return existing;

	io.setCommandTimeout(300_000);

	const path = join(sourcesDir, 'node');
	if (existsSync(path)) {
		io.trackCommand('node: fetching', 'git', '-C', path, 'fetch', '--quiet', 'origin', 'main');
	} else {
		io.trackCommand(
			'node: cloning (without file contents)',
			'git',
			'clone',
			'--quiet',
			'--filter=blob:none',
			'--no-checkout',
			'--single-branch',
			'--branch',
			'main',
			'https://github.com/nodejs/node.git',
			path
		);
	}
	return path;
}

/** Make sure the installed `@zenfs/core`, which is what gets checked, is the staged version */
function matchInstalled(staged: Staged): void {
	const installed = JSON.parse(readFileSync(join(root, 'node_modules/@zenfs/core/package.json'), 'utf-8')).version;
	const version = /^v?(\d+\.\d+\.\d+)/.exec(staged.version)?.[1];
	if (!version || installed == version) return;

	if (staged.version.endsWith('(local)')) {
		io.warn(`core: checking compatibility of the installed v${installed}, not the local v${version}. Use \`npm i --no-save ../core\` to check the local checkout.`);
		return;
	}

	io.trackCommand(`core: installing v${version} to check compatibility`, 'npm', 'install', '--no-save', '--no-audit', '--no-fund', `@zenfs/core@${version}`);
}

export async function writeCompat(staged: Staged): Promise<Compat> {
	const repo = nodeRepository();
	matchInstalled(staged);

	const marksPath = join(sourcesDir, 'core/node-compat.json');
	if (!existsSync(marksPath)) io.exit(`No compatibility marks found at ${marksPath}`);
	const marks = new Map(Object.entries(JSON.parse(readFileSync(marksPath, 'utf-8')) as Record<string, MarkEntry>));

	const node = io.track('node: reading history', () => new NodeRepository({ repo }));
	const analysis = new Analysis(node, marks);
	if (!node.latest) io.exit('No Node.js releases found');
	const latest = analysis.coverage(node.latest.version)!;

	const summarize = (coverage: Coverage): ReleaseCompat => ({
		version: coverage.release.version,
		date: coverage.release.date,
		prs: { covered: coverage.prs.length - coverage.pending.length, total: coverage.prs.length },
		apis: { covered: coverage.apis.length - coverage.missing.length, total: coverage.apis.length },
	});

	const lastComplete = latest.complete ? undefined : analysis.lastComplete(latest.release.version);

	const prs: Compat['prs'] = { pending: 0, resolved: 0, ignored: 0, auto: 0 };
	for (const { status } of latest.prs) prs[status]++;

	const compat: Compat = {
		zenfs: zenfs.version,
		latest: summarize(latest),
		lastComplete: lastComplete && summarize(lastComplete),
		implemented: latest.apis.filter(({ present }) => present).length,
		prs,
		pending: latest.pending.map(({ pr }) => ({ number: pr.number, title: pr.title })).sort((left, right) => left.number - right.number),
		missing: latest.missing.map(({ api }) => api.id),
		unsupported: latest.apis.filter(({ present, mark }) => !present && mark).map(({ api, mark }) => ({ id: api.id, note: mark!.note })),
	};

	io.writeJSON(compatPath, compat);
	return compat;
}

if (import.meta.main) {
	io._setDebugOutput(!!process.env.DEBUG);

	const staged = versions().core;
	if (!staged) io.exit('@zenfs/core has not been staged, run `node scripts/sources.ts` first');

	const { latest, lastComplete, zenfs } = await writeCompat(staged);
	const percent = ({ covered, total }: { covered: number; total: number }) => Math.floor((covered / total) * 100) + '%';
	console.log(
		`\nZenFS v${zenfs} on Node.js v${latest.version}: ${percent(latest.apis)} of APIs, ${percent(latest.prs)} of PRs`,
		lastComplete ? `(fully supports v${lastComplete.version})` : ''
	);
}
