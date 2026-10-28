import { defineConfig } from 'eslint/config';
import shared from '@zenfs/devel/eslint';

export default defineConfig(...shared, {
	files: ['src/**/*.ts'],
	name: 'Enable typed checking',
	languageOptions: {
		parserOptions: {
			projectService: true,
			tsconfigRootDir: import.meta.dirname,
		},
	},
});
