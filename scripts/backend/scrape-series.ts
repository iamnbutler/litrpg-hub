import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { closeDb } from './db.js';
import { runMigrations } from './migrate.js';
import { repairSeriesIdentities } from './db/index.js';
import { fetchSeries, type SeriesReference } from './fetchers/series.js';

try {
	const { values } = parseArgs({ options: { series: { type: 'string' }, all: { type: 'boolean' }, limit: { type: 'string', default: '40' }, 'dry-run': { type: 'boolean' }, help: { type: 'boolean' } } });
	const config = JSON.parse(readFileSync(join(import.meta.dirname, 'config/audible-series.json'), 'utf8')) as { series: SeriesReference[] };
	if (values.help) {
		console.log('npm run pipeline:series -- --series <id> [--limit 40] [--dry-run]\nUse --all to refresh all configured series. The limit applies per series.\n' + config.series.map(s => s.id).join('\n'));
	} else {
		if (!values.series && !values.all) throw new Error('Choose --series <id> or explicitly use --all. See --help for IDs.');
		if (values.series && values.all) throw new Error('Choose either --series or --all.');
		const limit = Number(values.limit);
		if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('--limit must be an integer between 1 and 100.');
		const selected = values.all ? config.series : config.series.filter(s => s.id === values.series);
		if (!selected.length) throw new Error(`Unknown series: ${values.series}. See --help.`);
		if (!values['dry-run']) { runMigrations(); repairSeriesIdentities(); }
		for (const series of selected) {
			console.log(`\n${series.title}`);
			const result = await fetchSeries(series, { limit, dryRun: values['dry-run'] });
			if (!values['dry-run']) console.log(`${result.updated} verified books saved. ${result.complete ? 'All discovered pages processed.' : 'Budget reached; series still needs follow-up.'}`);
		}
	}
} catch (error) {
	console.error(error instanceof Error ? error.message : 'Series refresh failed.');
	process.exitCode = 1;
} finally { closeDb(); }
