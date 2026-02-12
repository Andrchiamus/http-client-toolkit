// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// https://astro.build/config
export default defineConfig({
	site: 'https://allymurray.github.io',
	base: '/http-client-toolkit',
	integrations: [
		starlight({
			title: 'HTTP Client Toolkit',
			customCss: ['./src/styles/custom.css'],
			social: [
				{
					icon: 'github',
					label: 'GitHub',
					href: 'https://github.com/AllyMurray/http-client-toolkit',
				},
			],
			sidebar: [
				{
					label: 'Getting Started',
					items: [
						{ label: 'Introduction', slug: 'getting-started/introduction' },
						{ label: 'Installation', slug: 'getting-started/installation' },
						{ label: 'Quick Start', slug: 'getting-started/quick-start' },
					],
				},
				{
					label: 'Guides',
					items: [
						{ label: 'Caching', slug: 'guides/caching' },
						{ label: 'Deduplication', slug: 'guides/deduplication' },
						{ label: 'Rate Limiting', slug: 'guides/rate-limiting' },
						{ label: 'Interceptors', slug: 'guides/interceptors' },
						{ label: 'Error Handling', slug: 'guides/error-handling' },
						{
							label: 'Response Transformation',
							slug: 'guides/response-transformation',
						},
					],
				},
				{
					label: 'Store Backends',
					items: [
						{ label: 'Overview', slug: 'stores/overview' },
						{ label: 'Memory', slug: 'stores/memory' },
						{ label: 'SQLite', slug: 'stores/sqlite' },
						{ label: 'DynamoDB', slug: 'stores/dynamodb' },
					],
				},
				{
					label: 'API Reference',
					items: [
						{ label: 'HttpClient', slug: 'api/http-client' },
						{ label: 'Store Interfaces', slug: 'api/interfaces' },
						{ label: 'Utilities', slug: 'api/utilities' },
					],
				},
			],
		}),
	],
});
