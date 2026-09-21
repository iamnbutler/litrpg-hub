import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [sveltekit()],
	server: {
		// SvelteKit's default allow list omits the linked workspace package.
		fs: { allow: ['./packages/catalog-contract'] },
		proxy: {
			'/auth/': { target: 'http://localhost:8787', changeOrigin: false },
			'/api/': { target: 'http://localhost:8787', changeOrigin: false }
		}
	}
});
