<script lang="ts">
	import { onMount } from 'svelte';
	import { AccountSync, type AccountState } from '$lib/account-sync';
	import { base } from '$app/paths';
	import { collapsePlaceholderDuplicates, defaultFilters, displayDate, genreLabels, searchBooks, tasteLabels, type Catalog, type CatalogBook, type ReaderFilters, type Taste, type TasteWeights } from '$lib/catalog';
	import { buildSeriesContentIndex, passesDiscoveryFilters } from '$lib/series-content';
	import {
		emptyLibrary, followSeries, isFollowing, libraryExport, markSeriesRead, mergeLibraries, migrateLibrary, parseFilters,
		markReadThrough, parseLibrary, parseLibraryExport, parseSeriesLibrary, seriesProgress, setWorkRating, setWorkStatus, shelfLabels,
		storageKeys, workEntry, type Library, type SeriesLibrary, type SeriesState, type ShelfStatus
	} from '$lib/library';
	import { groupSeries, latestAudioRelease, searchSeries, matchingAudiobooks, resolveSeriesRef, seriesPopularity, seriesStarter, seriesTitle, workIndex, workRelease, type CatalogSeries, type CatalogWork } from '$lib/series';
	import { eligibleSeriesEntries, recommendSeries } from '$lib/recommendations';
	import { explicitEditionKind } from '$lib/edition';
	import Icon from '$lib/components/Icon.svelte';
	import BookTile from '$lib/components/BookTile.svelte';
	import BookDetail from '$lib/components/BookDetail.svelte';
	import SeriesTile from '$lib/components/SeriesTile.svelte';
	import SeriesDetail from '$lib/components/SeriesDetail.svelte';
	import UpNextRow from '$lib/components/UpNextRow.svelte';

	type View = 'index' | 'series' | 'releases' | 'library' | 'similar';
	const navigation: { id: View; label: string }[] = [
		{ id: 'index', label: 'Series index' }, { id: 'similar', label: 'Similar series' },
		{ id: 'releases', label: 'Releases' }, { id: 'library', label: 'My library' }
	];
	const stateLabels: Record<SeriesState, string> = { 'in-progress': 'In progress', 'caught-up': 'Up to date', 'caught-up-partial': 'All known audio read', 'not-started': 'Not started' };
	let catalog = $state.raw<Catalog | null>(null);
	let loading = $state(true), error = $state('');
	let view: View = $state('index');
	let query = $state(''), genre = $state('all');
	let bookLayout: 'grid' | 'list' = $state('grid');
	let sort = $state('popular'), includeUnclassified = $state(false), visibleCount = $state(24);
	let filters: ReaderFilters = $state({ ...defaultFilters }), filtersOpen = $state(false);
	let library = $state<SeriesLibrary>(emptyLibrary()), storageWarning = $state('');
	let account = $state<AccountState>({ user: null, status: 'Checking sign-in…', ready: false, needsLogin: false, canImport: false });
	let accountSync: AccountSync | undefined;
	let signingOut = $state(false);
	let legacyShelf: Library = {}, storedLibrary: SeriesLibrary | null = null, migrated = false, unreadableRecord: string | null = null;
	let selectedId: string | null = $state(null), seriesId = $state(''), seedId = $state(''), seedQuery = $state('');
	let weights: TasteWeights = $state({});
	let libraryState = $state('all');
	let releaseMode = $state('upcoming'), releaseMonth = $state('all'), releaseYear = $state(String(new Date().getUTCFullYear())), followedOnly = $state(false);
	let toast = $state('');
	let toastTimer: ReturnType<typeof setTimeout>;
	// Coverage freshness is an instant, not a date: a date-only value can never be current, and
	// a value frozen at load would keep claiming currency past an expiry on a long-open tab.
	let nowIso = $state(new Date().toISOString());
	const today = $derived(nowIso.slice(0, 10));

	const books = $derived(catalog?.books ?? []);
	const bookIndex = $derived(new Map(books.map((b) => [b.id, b])));
	/** Series structure is built from the whole catalog. Content filters decide what is shown,
	 * never what a series contains, so hiding a volume can never fake being up to date.
	 * Kept as a plain function so migration can use the exact same list without depending on
	 * when a derived value happens to recompute. */
	const seriesFor = (data: Catalog) => (data.series?.length ? data.series : groupSeries(data.books));
	// Normalise titles once, at the edge: 1796 of the supplied series are standalone books with
	// no series name, and they would otherwise render as blank cards everywhere downstream.
	const allSeries = $derived(catalog ? seriesFor(catalog).map((s) => (s.title?.trim() ? s : { ...s, title: seriesTitle(s, bookIndex) })) : []);
	const works = $derived(workIndex(allSeries, books));
	const seriesContent = $derived(buildSeriesContentIndex(allSeries, bookIndex));
	const catalogBooks = $derived(collapsePlaceholderDuplicates(books).filter((b) => (includeUnclassified || b.scope === 'indexed') && passesDiscoveryFilters(b, filters, seriesContent)));
	/** Discovery eligibility resolves volume 1 BEFORE applying preferences, so a later unflagged
	 * volume can never pull a series with a blocked first book into the grid. Each entry carries
	 * the exact book that passed, and that is the book rendered. */
	const entries = $derived(eligibleSeriesEntries(allSeries, bookIndex, { filters, includeUnclassified, seriesContent }));
	const entryBySeries = $derived(new Map(entries.map((e) => [e.series.id, e])));
	const browsable = $derived(entries.map((e) => e.series));
	const seriesById = $derived(new Map(allSeries.map((s) => [s.id, s])));
	// Accepts an alias from a link shared before a rename; see resolveSeriesRef for collisions.
	const currentSeries = $derived(resolveSeriesRef(allSeries, seriesId));
	const selectedBook = $derived(books.find((b) => b.id === selectedId) ?? null);
	const followed = $derived(allSeries.filter((s) => isFollowing(library, s.id)));
	const followedCount = $derived(followed.length);
	const years = $derived([...new Set(books.flatMap((b) => (b.releaseDate ? [b.releaseDate.slice(0, 4)] : [])))].sort().reverse());

	/** The library view, its tab counts and the up-next queue each want progress for every
	 * followed series, so compute it once. Index tiles fall through and compute on demand. */
	const followedProgress = $derived(new Map(followed.map((s) => [s.id, seriesProgress(library, s, nowIso)])));
	const progressOf = (series: CatalogSeries) => followedProgress.get(series.id) ?? seriesProgress(library, series, nowIso);
	/** Always the vetted starter, so the rendered cover is the book discovery actually checked. */
	const coverOf = (series: CatalogSeries) => entryBySeries.get(series.id)?.book ?? seriesStarter(series, bookIndex);

	const sortSeries = (list: CatalogSeries[]) => [...list].sort((a, b) =>
		sort === 'title' ? a.title.localeCompare(b.title) :
		sort === 'volumes' ? b.works.length - a.works.length || seriesPopularity(b, bookIndex) - seriesPopularity(a, bookIndex) :
		sort === 'new' ? (latestAudioRelease(b, today) ?? '').localeCompare(latestAudioRelease(a, today) ?? '') :
		seriesPopularity(b, bookIndex) - seriesPopularity(a, bookIndex));
	const indexSeries = $derived.by(() => {
		let result = searchSeries(browsable, bookIndex, query);
		if (genre !== 'all') result = result.filter((s) => s.genres.includes(genre));
		return sortSeries(result);
	});
	const librarySeries = $derived.by(() => {
		let result = searchSeries(followed, bookIndex, query);
		// 'up-next' is a different presentation of the same library, not a series state.
		if (libraryState !== 'all' && libraryState !== 'up-next') result = result.filter((s) => progressOf(s).state === libraryState);
		return sortSeries(result);
	});
	/** Only when a non-empty search returns no series. Same filtered pool the index uses, so
	 * every content, genre and review preference still applies. Editions, never starters. */
	const searchFallback = $derived.by(() => {
		if (view !== 'index' || !query.trim() || indexSeries.length) return [];
		return matchingAudiobooks(catalogBooks, query, genre);
	});
	const libraryCounts = $derived(followed.reduce((acc, s) => { const key = progressOf(s).state; acc[key] = (acc[key] ?? 0) + 1; return acc; }, {} as Record<string, number>));

	const seedOptions = $derived(searchBooks(entries.map((e) => e.book), seedQuery).slice(0, 60));
	const defaultSeedSeries = $derived(indexSeries[0] ?? browsable[0] ?? null);
	const seed = $derived(books.find((b) => b.id === seedId) ?? (defaultSeedSeries ? coverOf(defaultSeedSeries) : null) ?? entries[0]?.book ?? null);
	const similarLimit = 12;
	/** Ranked over canonical starting works, each keeping the eligible edition it was scored on. */
	const similarSeries = $derived(seed ? recommendSeries(seed, allSeries, bookIndex, { filters, includeUnclassified, seriesContent, weights, limit: similarLimit }) : []);

	const releaseBooks = $derived(searchBooks(catalogBooks, query).filter((b) => {
		// A podcast feed is not an audiobook release. Collections and full-cast editions stay.
		if (explicitEditionKind(b) === 'podcast') return false;
		if (followedOnly) { const parent = seriesOf(b); if (!parent || !isFollowing(library, parent.id)) return false; }
		if (releaseMode === 'unknown') return !b.releaseDate;
		if (!b.releaseDate) return false;
		if (releaseMode === 'upcoming') return b.releaseDate >= today;
		return b.releaseDate.startsWith(releaseYear) && (releaseMonth === 'all' || b.releaseDate.slice(5, 7) === releaseMonth);
	}).sort((a, b) => (a.releaseDate ?? '').localeCompare(b.releaseDate ?? '') || a.title.localeCompare(b.title)));
	const activePreferenceCount = $derived(Object.values(filters).filter(Boolean).length);
	const semanticCount = $derived(similarSeries.filter((m) => m.method === 'taste').length);
	const coverCoverage = $derived(catalogBooks.filter((b) => b.coverAssessment).length);
	/** The direct lookup still matters: a reconciled id is deliberately absent from the work's
	 * alias list, so `workEntry` cannot see a read saved against it. */
	const entryOf = (book: CatalogBook) => { const hit = works.get(book.id); return (hit ? workEntry(library, hit.work) : undefined) ?? library.books[book.id]; };
	/** Collections and full-cast editions are not works, so fall back to the series they belong to. */
	const seriesOf = (book: CatalogBook) => works.get(book.id)?.series ?? seriesById.get(book.seriesKey) ?? null;
	/** What to listen to next, across everything the reader follows, oldest release first. */
	const upNext = $derived(followed.flatMap((series) => {
		const progress = progressOf(series);
		if (!progress.nextUnread) return [];
		// Sort on the resolved release, not the catalogued row, so the queue order matches the dates shown.
		return [{ series, work: progress.nextUnread, remaining: progress.remaining, date: workRelease(series, progress.nextUnread, nowIso).date ?? '' }];
	}).sort((a, b) => a.date.localeCompare(b.date) || a.series.title.localeCompare(b.series.title)));

	function announce(message: string) { toast = message; clearTimeout(toastTimer); toastTimer = setTimeout(() => (toast = ''), 3500); }
	function persist(key: string, value: unknown) {
		try { localStorage.setItem(key, JSON.stringify(value)); }
		catch { storageWarning = 'Browser storage is unavailable. Export your library to keep a copy.'; }
	}
	/** v1 is never written again, so it stays a recoverable backup of the original shelf. */
	function save(next: SeriesLibrary) {
		if (accountSync && !accountSync.canEdit()) return announce('Load your account library before editing. Use Retry sync.');
		library = next;
		try { if (accountSync) accountSync.save(next); else persist(storageKeys.library, next); }
		catch { storageWarning = 'Changes could not be saved on this device. Export your library to keep a copy.'; }
	}
	function signIn() {
		window.location.assign(`${base}/auth/login/?returnTo=${encodeURIComponent(window.location.pathname + window.location.search)}`);
	}
	async function signOut() {
		signingOut = true;
		if (await accountSync?.logout()) window.location.reload();
		else signingOut = false;
	}

	function writeUrl(push = false) {
		const url = new URL(window.location.href);
		url.search = '';
		if (view !== 'index') url.searchParams.set('view', view);
		if (view === 'series' && seriesId) url.searchParams.set('series', seriesId);
		if (query) url.searchParams.set('q', query);
		if (view === 'similar' && seedId) url.searchParams.set('like', seedId);
		if (selectedId) url.searchParams.set('book', selectedId);
		if (push) window.history.pushState({}, '', url); else window.history.replaceState({}, '', url);
	}
	function readUrl() {
		const params = new URLSearchParams(window.location.search);
		const requested = params.get('view') === 'shelf' ? 'library' : params.get('view');
		view = ['index', 'series', 'releases', 'library', 'similar'].includes(requested ?? '') ? (requested as View) : 'index';
		query = params.get('q') ?? ''; selectedId = params.get('book'); seedId = params.get('like') ?? ''; seriesId = params.get('series') ?? '';
		visibleCount = 24;
		healSeriesUrl();
	}
	function navigate(next: View) {
		view = next; query = ''; genre = 'all'; visibleCount = 24; selectedId = null;
		if (next !== 'series') seriesId = '';
		writeUrl(true); window.scrollTo({ top: 0, behavior: 'instant' });
	}
	function openSeries(series: CatalogSeries) {
		seriesId = series.id; view = 'series'; query = ''; visibleCount = 24; selectedId = null;
		writeUrl(true); window.scrollTo({ top: 0, behavior: 'instant' });
	}
	function openBook(book: CatalogBook) { selectedId = book.id; writeUrl(true); }
	function closeBook() { selectedId = null; writeUrl(); }
	function findSimilar(book: CatalogBook) { seedId = book.id; weights = {}; seedQuery = ''; navigate('similar'); }

	function toggleFollow(series: CatalogSeries) {
		const next = !isFollowing(library, series.id);
		save(followSeries(library, series.id, next));
		announce(next ? `Following ${series.title}` : `Unfollowed ${series.title} · your reading history is kept`);
	}
	function markAll(series: CatalogSeries) {
		const next = markSeriesRead(library, series, nowIso);
		const added = seriesProgress(next, series, nowIso).read - progressOf(series).read;
		save(next);
		announce(`Marked ${added} released audiobook${added === 1 ? '' : 's'} as read`);
	}
	function setWorkRead(series: CatalogSeries, work: CatalogWork, read: boolean) {
		save(setWorkStatus(library, series, work, read ? 'read' : ''));
	}
	function markThrough(series: CatalogSeries, work: CatalogWork) {
		const next = markReadThrough(library, series, work, nowIso);
		const added = seriesProgress(next, series, nowIso).read - progressOf(series).read;
		save(next);
		announce(`Marked ${added} audiobook${added === 1 ? '' : 's'} as read through ${work.number != null ? `Book ${work.number}` : work.title}`);
	}
	function setShelf(book: CatalogBook, status: ShelfStatus | '') {
		const hit = works.get(book.id);
		if (hit) {
			save(setWorkStatus(library, hit.series, hit.work, status));
			return announce(status ? `Saved as ${shelfLabels[status].toLowerCase()}` : 'Removed from your library');
		}
		// Full-cast, collection and unmatched editions are not mainline works, so follow the series
		// instead. Clearing this control must never unfollow it — that is a series-level action.
		const parent = seriesOf(book);
		if (!parent) return announce('This edition isn’t part of a series we track yet.');
		if (!status) return announce(`${parent.title} is followed as a series. Open the series to stop following it.`);
		save(followSeries(library, parent.id, true));
		announce(`Following ${parent.title} · full-cast and collection editions are tracked through the series`);
	}
	function saveBook(book: CatalogBook) { if (entryOf(book)) openBook(book); else setShelf(book, 'want'); }
	function rateBook(book: CatalogBook, rating: number) {
		const hit = works.get(book.id);
		if (!hit) return announce('Only the numbered audiobooks in a series can be rated.');
		save(setWorkRating(library, hit.series, hit.work, rating));
	}
	function setFilter(key: keyof ReaderFilters, value: boolean) { filters = { ...filters, [key]: value }; visibleCount = 24; persist(storageKeys.filters, filters); }
	function resetFilters() { filters = { ...defaultFilters }; genre = 'all'; includeUnclassified = false; persist(storageKeys.filters, filters); }
	/** The empty state's own action: resetFilters never touched the query, so offering only
	 * "Reset filters" after a fruitless search did nothing visible. */
	function clearSearch() { query = ''; visibleCount = 24; writeUrl(); }
	function searchChanged() { if (view === 'similar') view = 'index'; visibleCount = 24; writeUrl(); }

	function downloadLibrary() {
		const blob = new Blob([JSON.stringify(libraryExport(library), null, 2)], { type: 'application/json' });
		const url = URL.createObjectURL(blob); const link = document.createElement('a');
		link.href = url; link.download = `litrpg-hub-library-${today}.json`; link.click(); URL.revokeObjectURL(url);
	}
	async function importLibrary(event: Event) {
		const input = event.currentTarget as HTMLInputElement, file = input.files?.[0];
		if (!file) return;
		try {
			if (file.size > 5_000_000) throw new Error('File too large');
			const imported = parseLibraryExport(JSON.parse(await file.text()), allSeries, bookIndex);
			if (!imported) throw new Error('Invalid export');
			save(mergeLibraries(library, imported));
			announce(`Imported ${Object.keys(imported.books).length} books and ${Object.keys(imported.series).length} series`);
		} catch { announce('That file is not a valid LitRPG Hub library export.'); }
		input.value = '';
	}

	/** Runs once the catalog is known, because following a series needs the series list.
	 * Takes the list explicitly: this writes the reader's history, so it must never race. */
	function applyMigration(series: CatalogSeries[]) {
		if (migrated) return;
		migrated = true;
		if (unreadableRecord) {
			try { localStorage.setItem(`${storageKeys.library}:unreadable:${today}`, unreadableRecord); } catch { /* nothing more we can do */ }
			unreadableRecord = null;
		}
		save(migrateLibrary(account.user ? {} : legacyShelf, series, account.user ? library : storedLibrary, bookIndex));
	}
	async function loadCatalog(signal?: AbortSignal) {
		loading = true; error = '';
		try {
			const response = await fetch(`${base}/data/catalog.json`, { signal });
			if (!response.ok) throw new Error('Catalog request failed');
			const data = await response.json();
			// Accept the current shape and the next one: `series` is feature-detected, not version-gated,
			// so a catalog that gains an authoritative series list does not require a UI deploy.
			if (![1, 2].includes(data.version) || !Array.isArray(data.books)) throw new Error('Unsupported catalog');
			catalog = data;
			applyMigration(seriesFor(data as Catalog));
			healSeriesUrl();
		} catch (e) { if (!(e instanceof DOMException && e.name === 'AbortError')) error = 'The catalog couldn’t be loaded. Please try again.'; }
		finally { loading = false; }
	}
	/** Another tab edited the library: adopt it rather than overwrite it on the next action. */
	function syncStorage(event: StorageEvent) {
		if (account.user) { void accountSync?.sync(); return; }
		if (event.key !== storageKeys.library) return;
		try {
			const parsed = parseSeriesLibrary(JSON.parse(event.newValue ?? 'null'));
			if (parsed) library = parsed;
		} catch { /* a tab wrote something unreadable; keep what we have */ }
	}
	// A link shared before a rename should heal itself rather than stay stale.
	function healSeriesUrl() {
		if (view === 'series' && currentSeries && seriesId && seriesId !== currentSeries.id) {
			seriesId = currentSeries.id;
			writeUrl();
		}
	}
	onMount(() => {
		readUrl();
		if (new URLSearchParams(window.location.search).get('auth') === 'failed') {
			storageWarning = 'GitHub sign-in did not complete. Please try again.';
			const url = new URL(window.location.href); url.searchParams.delete('auth'); window.history.replaceState({}, '', url);
		}
		let raw: string | null = null;
		try {
			legacyShelf = parseLibrary(JSON.parse(localStorage.getItem(storageKeys.legacyLibrary) ?? '{}'));
			raw = localStorage.getItem(storageKeys.library);
			filters = parseFilters(JSON.parse(localStorage.getItem(storageKeys.filters) ?? '{}'));
		} catch { storageWarning = 'Your saved preferences could not be loaded. You can import a library backup.'; }
		try { storedLibrary = parseSeriesLibrary(JSON.parse(raw ?? 'null')); } catch { storedLibrary = null; }
		// A record we cannot read is still the reader's only copy. Never overwrite it silently.
		if (raw && raw !== 'null' && !storedLibrary) {
			unreadableRecord = raw;
			storageWarning = 'Your saved library could not be read, so a copy has been set aside before anything was rewritten. Your original shelf backup is untouched.';
		}
		// Show saved reads immediately; series follows are filled in once the catalog arrives.
		library = storedLibrary ?? { ...emptyLibrary(), books: { ...legacyShelf } };
		const controller = new AbortController();
		void loadCatalog(controller.signal).then(async () => {
			if (controller.signal.aborted) return;
			try {
				accountSync = new AccountSync(base, localStorage, (state, synced) => { account = state; if (synced) library = synced; });
				await accountSync.start(library);
			} catch { account = { ...account, ready: true, status: 'Browser storage is unavailable' }; }
		});
		const refreshAccount = () => { if (document.visibilityState === 'visible') void accountSync?.sync(); };
		window.addEventListener('online', refreshAccount);
		document.addEventListener('visibilitychange', refreshAccount);
		const syncClock = setInterval(refreshAccount, 60_000);
		// Re-evaluate coverage freshness periodically so an expiry takes effect without a reload.
		const clock = setInterval(() => (nowIso = new Date().toISOString()), 300_000);
		return () => {
			controller.abort(); accountSync?.dispose(); clearTimeout(toastTimer); clearInterval(clock); clearInterval(syncClock);
			window.removeEventListener('online', refreshAccount); document.removeEventListener('visibilitychange', refreshAccount);
		};
	});
</script>

<svelte:head>
	<title>{selectedBook ? `${selectedBook.title} · ` : currentSeries ? `${currentSeries.title} · ` : ''}LitRPG Hub</title>
	<meta name="description" content="Follow LitRPG and progression fantasy series, track the audiobooks you have read, find similar series, and check release dates."/>
</svelte:head>
<svelte:window onpopstate={readUrl} onstorage={syncStorage}/>
<a class="skip-link" href="#main">Skip to series</a>
<header class="site-header">
	<button class="brand" onclick={() => navigate('index')}><span class="brand-mark"><Icon name="book" size={18}/></span>LitRPG Hub</button>
	<nav aria-label="Main navigation">
		{#each navigation as item (item.id)}<button class:active={view === item.id || (item.id === 'index' && view === 'series')} aria-current={view === item.id ? 'page' : undefined} onclick={() => navigate(item.id)}>{item.label}{#if item.id === 'library' && followedCount}<span class="nav-count">{followedCount}</span>{/if}</button>{/each}
	</nav>
	<form class="global-search" onsubmit={(e) => { e.preventDefault(); searchChanged(); }} role="search">
		<Icon name="search" size={16}/><input aria-label="Search series, authors, or narrators" placeholder="Search series, authors…" bind:value={query} oninput={searchChanged}/>
		{#if query}<button type="button" class="icon-button" aria-label="Clear search" onclick={() => { query = ''; writeUrl(); }}><Icon name="close" size={14}/></button>{/if}
	</form>
	<div class="account-controls">
		{#if account.user && !account.needsLogin}
			<span class="account-name" title={account.user.displayName}>@{account.user.username}</span>
			<button class="subtle-button" disabled={signingOut} onclick={signOut}>{signingOut ? 'Signing out…' : 'Sign out'}</button>
		{:else}<button class="secondary-button" disabled={!account.ready} onclick={signIn}>{account.needsLogin ? 'Sign in again' : 'Sign in with GitHub'}</button>{/if}
	</div>
</header>
<main id="main" class="main-shell">
	{#if view !== 'series'}
		<div class="page-heading">
			<h1>{view === 'similar' ? 'Similar series' : view === 'releases' ? 'Audiobook releases' : view === 'library' ? 'My library' : 'Series index'}</h1>
			{#if view === 'library'}<span class="small-note" role="status">{account.status}</span><div class="shelf-tools">{#if account.user}<button class="secondary-button" onclick={() => accountSync?.sync()}>Retry sync</button>{/if}<button class="secondary-button" onclick={downloadLibrary}>Export</button><label class="secondary-button import-library-label" for="library-import">Import</label><input class="visually-hidden" type="file" accept="application/json,.json" id="library-import" onchange={importLibrary} aria-label="Import a library backup"/></div>{/if}
		</div>
	{/if}
	{#if storageWarning}<p class="notice" role="status">{storageWarning}</p>{/if}
	{#if account.canImport}<div class="notice browser-library-notice"><span>You have a library saved in this browser.</span><button class="secondary-button" onclick={() => accountSync?.importGuest()}>Add it to my account</button></div>{/if}
	{#if account.user && (account.status.includes('paused') || account.status.includes('Could not') || account.needsLogin)}<p class="notice" role="status">{account.status}</p>{/if}
	{#if error}<div class="empty-state" role="alert"><p>{error}</p><button class="secondary-button" onclick={() => loadCatalog()}>Retry</button></div>
	{:else if loading}<p class="loading" role="status">Loading catalog…</p>
	{:else if view === 'series'}
		{#if currentSeries}
			{#key currentSeries.id}
				<SeriesDetail series={currentSeries} books={bookIndex} {library} {today} now={nowIso} progress={progressOf(currentSeries)} starter={coverOf(currentSeries)}
					following={isFollowing(library, currentSeries.id)} onback={() => navigate('index')} onfollow={toggleFollow}
					onmarkall={markAll} onwork={setWorkRead} onthrough={markThrough} onopenbook={openBook} onlike={findSimilar}/>
			{/key}
		{:else}<div class="empty-state"><p>That series isn’t in the catalog.</p><button class="secondary-button" onclick={() => navigate('index')}>Browse series</button></div>{/if}
	{:else if view === 'similar'}
		<div class="match-layout">
			<aside class="taste-controls" aria-label="Similarity settings">
				<label for="seed-search">Starting series</label><input id="seed-search" bind:value={seedQuery} placeholder="Search series…"/>
				<label class="visually-hidden" for="seed-select">Choose a starting series</label>
				<select id="seed-select" value={seed?.id ?? ''} onchange={(e) => { seedId = e.currentTarget.value; writeUrl(); }}>
					{#if seed && !seedOptions.some((b) => b.id === seed.id)}<option value={seed.id}>{seed.series || seed.title}</option>{/if}
					{#each seedOptions as book (book.id)}<option value={book.id}>{book.series || book.title} — {book.author}</option>{/each}
				</select>
				{#if seed}<button class="seed-book" onclick={() => { const hit = works.get(seed.id); return hit ? openSeries(hit.series) : openBook(seed); }}>{#if seed.coverUrl}<img src={seed.coverUrl} alt=""/>{/if}<span><strong>{seed.series || seed.title}</strong><small>{seed.author}</small></span></button>{/if}
				<div class="weight-heading"><h2>Match priorities</h2><button class="subtle-button" onclick={() => (weights = {})}>Reset</button></div>
				{#each Object.keys(tasteLabels) as key (key)}<label class="weight-control"><span>{tasteLabels[key as Taste]}<small>{(weights[key as Taste] ?? 1) === 0 ? 'Ignore' : `${weights[key as Taste] ?? 1}×`}</small></span><input type="range" min="0" max="3" step="0.5" value={weights[key as Taste] ?? 1} oninput={(e) => (weights = { ...weights, [key]: Number(e.currentTarget.value) })}/></label>{/each}
				<p class="small-note">{seed?.assessment ? 'Matches compare reading traits estimated from publisher descriptions. Books without profiles use genre overlap.' : 'This book has no reading profile yet. Results use genre overlap.'}</p>
			</aside>
			<section class="match-results" aria-label="Similar series">
				<div class="browse-toolbar"><span>{similarSeries.length} series <span class="muted">· {semanticCount} matched by reading traits</span></span>{@render layoutControls()}{@render filterButton()}</div>
				{@render preferences()}
				{#if similarSeries.length}<div class="book-list" class:cover-grid={bookLayout === 'grid'} role="list">{#each similarSeries as match (match.series.id)}{@render seriesTile(match.series, `${match.method === 'taste' ? 'Shared traits' : 'Shared genres'}: ${match.reasons.join(', ')}`, match.book)}{/each}</div>
				{:else}<div class="empty-state"><p>No matches with these filters.</p><button class="secondary-button" onclick={resetFilters}>Reset filters</button></div>{/if}
			</section>
		</div>
	{:else if view === 'releases'}
		<div class="browse-toolbar">
			<div class="segmented" aria-label="Release period">{#each [{ id: 'upcoming', label: 'Upcoming' }, { id: 'year', label: 'By year' }, { id: 'unknown', label: 'Date unknown' }] as mode (mode.id)}<button class:chosen={releaseMode === mode.id} onclick={() => { releaseMode = mode.id; visibleCount = 24; }}>{mode.label}</button>{/each}</div>
			{#if releaseMode === 'year'}<select aria-label="Release year" bind:value={releaseYear} onchange={() => (visibleCount = 24)}>{#each years as year (year)}<option value={year}>{year}</option>{/each}</select><select aria-label="Release month" bind:value={releaseMonth} onchange={() => (visibleCount = 24)}><option value="all">All months</option>{#each Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, '0')) as month (month)}<option value={month}>{new Intl.DateTimeFormat('en', { month: 'long', timeZone: 'UTC' }).format(new Date(`2026-${month}-15T12:00:00Z`))}</option>{/each}</select>{/if}
			<label class="checkbox-label"><input type="checkbox" bind:checked={followedOnly} onchange={() => (visibleCount = 24)}/>Only series I follow</label>
			{@render filterButton()}
		</div>
		{@render preferences()}
		<div class="results-meta"><span>{releaseBooks.length.toLocaleString()} audiobook editions{query ? ` matching “${query}”` : ''}</span><span>US Audible · {@render freshness()}</span></div>
		{#if releaseBooks.length}{@render listHeading()}<div class="book-list" role="list">{#each releaseBooks.slice(0, visibleCount) as book (book.id)}<BookTile layout="list" {book} entry={entryOf(book)} onopen={openBook} onsave={saveBook} onlike={findSimilar}/>{/each}</div>{#if releaseBooks.length > visibleCount}<button class="load-more" onclick={() => (visibleCount += 24)}>Show 24 more</button>{/if}
		{:else}<div class="empty-state"><p>No releases found. The source snapshot may be out of date.</p><button class="secondary-button" onclick={() => { releaseMode = 'year'; releaseYear = '2026'; }}>View 2026 releases</button></div>{/if}
	{:else}
		{@const list = view === 'library' ? librarySeries : indexSeries}
		{#if view === 'library'}
			<div class="shelf-tabs" aria-label="Library status">
				<button class:chosen={libraryState === 'up-next'} onclick={() => { libraryState = 'up-next'; visibleCount = 24; }}>Up next <span>{upNext.length}</span></button>
				<button class:chosen={libraryState === 'all'} onclick={() => { libraryState = 'all'; visibleCount = 24; }}>All <span>{followedCount}</span></button>
				{#each Object.entries(stateLabels) as [key, label] (key)}<button class:chosen={libraryState === key} onclick={() => { libraryState = key; visibleCount = 24; }}>{label}<span>{libraryCounts[key] ?? 0}</span></button>{/each}
			</div>
		{/if}
		{#if view === 'library' && libraryState === 'up-next'}
			<div class="results-meta"><span>{upNext.length} audiobook{upNext.length === 1 ? '' : 's'} waiting across {followedCount} series</span></div>
			{#if upNext.length}
				<div class="book-list" role="list">{#each upNext.slice(0, visibleCount) as item (item.series.id)}<UpNextRow series={item.series} work={item.work} book={bookIndex.get(item.work.bookId)} remaining={item.remaining} now={nowIso} onopen={openSeries} onread={(s, w) => setWorkRead(s, w, true)} onopenbook={openBook}/>{/each}</div>
				{#if upNext.length > visibleCount}<button class="load-more" onclick={() => (visibleCount += 24)}>Show 24 more · {upNext.length - visibleCount} remaining</button>{/if}
			{:else}<div class="empty-state"><p>{followedCount ? 'Nothing waiting. You’re current on every series you follow.' : 'Follow a series and the next audiobook to listen to shows up here.'}</p><button class="secondary-button" onclick={() => navigate('index')}>Browse series</button></div>{/if}
		{:else}
		<div class="browse-toolbar">
			<label class="inline-field">Sort<select bind:value={sort} aria-label="Sort series"><option value="popular">Popular</option><option value="new">Latest audiobook</option><option value="volumes">Most books</option><option value="title">Title A–Z</option></select></label>
			<select bind:value={genre} aria-label="Filter by genre" onchange={() => (visibleCount = 24)}><option value="all">All genres</option>{#each Object.entries(genreLabels) as [key, label] (key)}<option value={key}>{label}</option>{/each}</select>
			{#if view === 'index'}<label class="checkbox-label"><input type="checkbox" checked={filters.hideSexualized} onchange={(e) => setFilter('hideSexualized', e.currentTarget.checked)}/>Hide sexualized content</label>{@render filterButton()}{/if}
		</div>
		{@render preferences()}
		{#if list.length || !searchFallback.length}<div class="results-meta"><span>{list.length.toLocaleString()} series{query ? ` matching “${query}”` : ''}</span><div class="results-controls">{@render layoutControls()}</div></div>{/if}
		{#if list.length}
			{#if bookLayout === 'list'}{@render seriesHeading()}{/if}
			<div class="book-list" class:cover-grid={bookLayout === 'grid'} role="list">{#each list.slice(0, visibleCount) as series (series.id)}{@render seriesTile(series)}{/each}</div>
			{#if list.length > visibleCount}<button class="load-more" onclick={() => (visibleCount += 24)}>Show 24 more · {list.length - visibleCount} remaining</button>{/if}
		{:else if searchFallback.length}
			<div class="results-meta"><span>No series match “{query}”, but {searchFallback.length} matching audiobook{searchFallback.length === 1 ? '' : 's'} did.</span><span class="muted">Individual editions, not series starts</span></div>
			{@render listHeading()}
			<div class="book-list" role="list">{#each searchFallback as book (book.id)}<BookTile layout="list" {book} entry={entryOf(book)} onopen={openBook} onsave={saveBook} onlike={findSimilar}/>{/each}</div>
		{:else}<div class="empty-state"><p>{view === 'library' ? (followedCount ? 'No series with this status.' : 'You aren’t following any series yet. Use “Follow” on a series to start.') : query ? `Nothing matches “${query}” with your current filters.` : 'No series match your filters.'}</p><button class="secondary-button" onclick={() => (view === 'library' ? navigate('index') : query ? clearSearch() : resetFilters())}>{view === 'library' ? 'Browse series' : query ? 'Clear search' : 'Reset filters'}</button></div>{/if}
		{/if}
	{/if}
	<footer>{@render freshness()}<a href="https://github.com/iamnbutler/litrpg-hub" target="_blank" rel="noreferrer">Source</a></footer>
</main>
{#snippet seriesTile(series: CatalogSeries, reason = '', cover: CatalogBook | undefined = undefined)}
	<SeriesTile layout={bookLayout} {series} cover={cover ?? coverOf(series)} progress={progressOf(series)} {reason}
		following={isFollowing(library, series.id)} latest={latestAudioRelease(series, nowIso)} upcoming={progressOf(series).upcoming}
		onopen={openSeries} onfollow={toggleFollow}/>
{/snippet}
{#snippet layoutControls()}<div class="view-controls" aria-label="Layout"><button aria-pressed={bookLayout === 'grid'} class:chosen={bookLayout === 'grid'} onclick={() => (bookLayout = 'grid')}>Grid</button><button aria-pressed={bookLayout === 'list'} class:chosen={bookLayout === 'list'} onclick={() => (bookLayout = 'list')}>List</button></div>{/snippet}
{#snippet filterButton()}<button class="secondary-button filter-button" onclick={() => (filtersOpen = !filtersOpen)} aria-expanded={filtersOpen}><Icon name="filter" size={15}/>Filters <span class="muted">{activePreferenceCount}</span></button>{/snippet}
{#snippet listHeading()}<div class="list-heading" aria-hidden="true"><span>Book / author</span><span>Audible rating</span><span>Release date</span><span>Your library</span></div>{/snippet}
{#snippet seriesHeading()}<div class="list-heading series-heading" aria-hidden="true"><span>Series / author</span><span>Your progress</span><span>Latest audiobook</span><span>Follow</span></div>{/snippet}
{#snippet preferences()}
	{#if filtersOpen && view !== 'library'}<section class="preferences-panel" aria-label="Content filters">
		<div class="preference-grid">
			{#each [{ key: 'hideSexualized', label: 'Sexualized covers / marketing' }, { key: 'hideExplicit', label: 'Explicit sexual content' }, { key: 'hideHarem', label: 'Harem / reverse harem' }, { key: 'hideAiNarration', label: 'Disclosed AI narration' }, { key: 'hideAiWriting', label: 'Disclosed AI writing' }, { key: 'hideQualityFlags', label: 'Listing quality concerns' }] as option (option.key)}<label class="checkbox-label"><input type="checkbox" checked={filters[option.key as keyof ReaderFilters]} onchange={(e) => setFilter(option.key as keyof ReaderFilters, e.currentTarget.checked)}/>Hide {option.label.toLowerCase()}</label>{/each}
			<label class="checkbox-label"><input type="checkbox" checked={filters.hideUnknown} onchange={(e) => setFilter('hideUnknown', e.currentTarget.checked)}/>Also hide unclassified content</label>
			<label class="checkbox-label"><input type="checkbox" bind:checked={includeUnclassified} onchange={() => (visibleCount = 24)}/>Include genres awaiting review</label>
		</div>
		<div class="preference-foot"><span>Harem filtering includes series with a publisher disclosure on another volume. Your library and reading progress stay complete. {coverCoverage.toLocaleString()} of {catalogBooks.length.toLocaleString()} visible editions have cover assessments.</span><button class="subtle-button" onclick={resetFilters}>Reset</button></div>
	</section>{/if}
{/snippet}
{#snippet freshness()}{#if catalog?.sourceSnapshotAt}<span class="freshness">Source snapshot: {displayDate(catalog.sourceSnapshotAt.slice(0, 10))}</span>{/if}{/snippet}
{#if selectedBook}{#key selectedBook.id}<BookDetail book={selectedBook} series={seriesOf(selectedBook)} books={bookIndex} {library} {today} now={nowIso} entry={entryOf(selectedBook)} rateable={!!works.get(selectedBook.id)} onclose={closeBook} onshelf={setShelf} onrating={rateBook} onlike={findSimilar} onopen={openBook} onseries={openSeries}/>{/key}{/if}
<div class="toast" class:visible={toast} role="status" aria-live="polite">{toast}</div>
