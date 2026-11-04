import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';
import { createStarlightTypeDocPlugin } from 'starlight-typedoc';
import type { StarlightPlugin } from '@astrojs/starlight/types';
import { join } from 'node:path';
import { packages, sourcesDir, versions } from './scripts/sources.ts';

const staged = versions();

/** The placeholder a TypeDoc instance hands back, marking where its pages go in the sidebar. */
type SidebarGroup = ReturnType<typeof createStarlightTypeDocPlugin>[1];

/** A TypeDoc instance per package. */
const typedoc: StarlightPlugin[] = [];
const reference: Record<string, SidebarGroup> = {};

for (const pkg of packages) {
	const [plugin, sidebarGroup] = createStarlightTypeDocPlugin();
	reference[pkg.name] = sidebarGroup;

	typedoc.push(
		plugin({
			entryPoints: [`.sources/${pkg.name}/src/index.ts`],
			tsconfig: `.sources/${pkg.name}/tsconfig.json`,
			output: `${pkg.name}/reference`,
			sidebar: { label: 'Reference', collapsed: true },
			typeDoc: {
				name: pkg.title,
				excludeReferences: true,
				readme: 'none',
				excludeInternal: false,
				excludeProtected: false,
				entryFileName: 'index',
				skipErrorChecking: true,
				disableGit: true, // "Defined in" would otherwise expose the staging path under `.sources/`.
				basePath: join(sourcesDir, pkg.name),
				sourceLinkTemplate: `https://github.com/zen-fs/${pkg.repo}/blob/${staged[pkg.name]?.ref ?? 'main'}/src/{path}#L{line}`,
			},
		})
	);
}

/** A package's sidebar group: its own pages, then its generated reference. */
function group(name: string, label: string, pages: (string | { label: string; link: string })[] = []) {
	return {
		label,
		collapsed: true,
		items: [{ label: 'Overview', slug: name }, ...pages.map(page => (typeof page == 'string' ? { slug: `${name}/${page}` } : page)), reference[name]],
	};
}

export default defineConfig({
	site: 'https://zenfs.dev',
	redirects: {
		'/discord': 'https://discord.com/invite/CxYFAfsV5X',
		'/playground': 'https://playground.zenfs.dev',
		'/core/reference/classes/index': '/core/reference/classes/',
	},
	integrations: [
		starlight({
			title: 'ZenFS',
			description: 'A file system, anywhere',
			logo: { dark: './src/assets/logo.svg', light: './src/assets/logo-light.svg', alt: 'ZenFS' },
			favicon: '/logo.svg',
			customCss: ['./src/styles/theme.css', './src/styles/starlight.css'],
			social: [
				{ icon: 'github', label: 'GitHub', href: 'https://github.com/zen-fs' },
				{ icon: 'discord', label: 'Discord', href: 'https://discord.com/invite/CxYFAfsV5X' },
			],
			editLink: {
				baseUrl: 'https://github.com/zen-fs/docs/edit/main/',
			},
			components: {
				Footer: './src/components/Footer.astro',
			},
			plugins: typedoc,
			sidebar: [
				{
					label: 'Getting started',
					items: [{ slug: 'start/introduction' }, { slug: 'start/installation' }, { slug: 'start/quick-start' }, { slug: 'start/usage' }],
				},
				group('core', '@zenfs/core', [
					'configuration',
					{ label: 'Node.js compatibility', link: '/core/compatibility/' },
					'vfs',
					'backends',
					'architecture',
					'internal',
					'security',
					'testing',
					'backend-authoring',
				]),
				group('dom', '@zenfs/dom'),
				group('archives', '@zenfs/archives'),
				group('cloud', '@zenfs/cloud'),
				group('emscripten', '@zenfs/emscripten'),
				group('linux', '@zenfs/linux', ['modules', 'devices']),
				{
					label: 'More',
					items: [{ slug: 'bundle' }, { label: 'Playground', link: 'https://playground.zenfs.dev', attrs: { target: '_blank' } }],
				},
			],
		}),
	],
});
