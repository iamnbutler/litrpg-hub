<script lang="ts">
	import { onMount } from 'svelte';
	import { base } from '$app/paths';
	import { bookPopularity, collapsePlaceholderDuplicates, defaultFilters, displayDate, genreLabels, passesFilters, recommend, searchBooks, seriesStarters, tasteLabels, type Catalog, type CatalogBook, type ReaderFilters, type Taste, type TasteWeights } from '$lib/catalog';
	import { parseFilters, parseLibrary, shelfLabels, type Library, type ShelfStatus } from '$lib/library';
	import Icon from '$lib/components/Icon.svelte';
	import BookTile from '$lib/components/BookTile.svelte';
	import BookDetail from '$lib/components/BookDetail.svelte';

	type View = 'index' | 'releases' | 'shelf' | 'similar';
	const navigation: { id: View; label: string }[] = [{ id: 'index', label: 'Book index' }, { id: 'similar', label: 'Similar books' }, { id: 'releases', label: 'Releases' }, { id: 'shelf', label: 'My shelf' }];
	let catalog = $state.raw<Catalog | null>(null);
	let loading = $state(true), error = $state('');
	let view: View = $state('index');
	let query = $state(''), genre = $state('all');
	let bookLayout: 'grid' | 'list' = $state('grid');
	let sort = $state('popular'), seriesOnly = $state(true), includeUnclassified = $state(false), visibleCount = $state(24);
	let filters: ReaderFilters = $state({ ...defaultFilters }), filtersOpen = $state(false);
	let library: Library = $state({}), storageWarning = $state('');
	let selectedId: string | null = $state(null), seedId = $state(''), seedQuery = $state('');
	let weights: TasteWeights = $state({});
	let shelfStatus = $state('all');
	let releaseMode = $state('upcoming'), releaseMonth = $state('all'), releaseYear = $state(String(new Date().getUTCFullYear()));
	let toast = $state('');
	let toastTimer: ReturnType<typeof setTimeout>;
	let importInput = $state<HTMLInputElement>();
	const today = new Date().toISOString().slice(0,10);
	const books = $derived(catalog?.books ?? []);
	const shelfCount = $derived(Object.keys(library).length);
	const catalogBooks = $derived(collapsePlaceholderDuplicates(books).filter(b => (includeUnclassified || b.scope === 'indexed') && passesFilters(b, filters)));
	const starters = $derived(seriesStarters(catalogBooks).sort((a,b) => bookPopularity(b) - bookPopularity(a)));
	const seed = $derived(books.find(b => b.id === seedId) ?? starters[0] ?? null);
	const recommendations = $derived(seed ? recommend(seed, catalogBooks, weights) : []);
	const seedOptions = $derived(searchBooks(starters, seedQuery).slice(0, 60));
	const selectedBook = $derived(books.find(b => b.id === selectedId) ?? null);
	const selectedSeries = $derived(selectedBook ? collapsePlaceholderDuplicates(books.filter(b => b.seriesKey === selectedBook.seriesKey)).sort((a,b) => (a.seriesNumber ?? 9999) - (b.seriesNumber ?? 9999) || (a.releaseDate ?? '').localeCompare(b.releaseDate ?? '')) : []);
	const years = $derived([...new Set(books.flatMap(b => b.releaseDate ? [b.releaseDate.slice(0,4)] : []))].sort().reverse());
	const filteredBooks = $derived.by(() => {
		let result = view === 'shelf' ? books.filter(b => library[b.id] && (shelfStatus === 'all' || library[b.id].status === shelfStatus)) : seriesOnly ? starters : catalogBooks;
		result = searchBooks(result, query);
		if (genre !== 'all') result = result.filter(b => b.subgenres.includes(genre));
		return [...result].sort((a,b) => sort === 'title' ? a.title.localeCompare(b.title) : sort === 'rating' ?
			((b.rating ?? 4.2) * b.ratingCount + 4.2 * 50) / (b.ratingCount + 50) - ((a.rating ?? 4.2) * a.ratingCount + 4.2 * 50) / (a.ratingCount + 50) :
			sort === 'new' ? (b.releaseDate ?? '').localeCompare(a.releaseDate ?? '') : bookPopularity(b) - bookPopularity(a));
	});
	const releaseBooks = $derived(searchBooks(catalogBooks, query).filter(b => {
		if (releaseMode === 'unknown') return !b.releaseDate;
		if (!b.releaseDate) return false;
		if (releaseMode === 'upcoming') return b.releaseDate >= today;
		return b.releaseDate.startsWith(releaseYear) && (releaseMonth === 'all' || b.releaseDate.slice(5,7) === releaseMonth);
	}).sort((a,b) => (a.releaseDate ?? '').localeCompare(b.releaseDate ?? '') || a.title.localeCompare(b.title)));
	const activePreferenceCount = $derived(Object.values(filters).filter(Boolean).length);
	const semanticCount = $derived(recommendations.filter(r => r.method === 'taste').length);
	const coverCoverage = $derived(catalogBooks.filter(b => b.coverAssessment).length);

	function announce(message: string) { toast = message; clearTimeout(toastTimer); toastTimer = setTimeout(() => toast = '', 3500); }
	function persist(key: string, value: unknown) {
		try { localStorage.setItem(key, JSON.stringify(value)); }
		catch { storageWarning = 'Browser storage is unavailable. Export your shelf to keep a copy.'; }
	}
	function writeUrl(push = false) {
		const url = new URL(window.location.href);
		url.search = '';
		if (view !== 'index') url.searchParams.set('view', view);
		if (query) url.searchParams.set('q', query);
		if (view === 'similar' && seedId) url.searchParams.set('like', seedId);
		if (selectedId) url.searchParams.set('book', selectedId);
		if (push) window.history.pushState({}, '', url); else window.history.replaceState({}, '', url);
	}
	function readUrl() {
		const params = new URLSearchParams(window.location.search);
		const requested = params.get('view');
		view = ['index','releases','shelf','similar'].includes(requested ?? '') ? requested as View : 'index';
		query = params.get('q') ?? ''; selectedId = params.get('book'); seedId = params.get('like') ?? '';
		visibleCount = 24;
	}
	function navigate(next: View) {
		view = next; query = ''; genre = 'all'; visibleCount = 24; selectedId = null;
		writeUrl(true); window.scrollTo({ top: 0, behavior: 'instant' });
	}
	function openBook(book: CatalogBook) { selectedId = book.id; writeUrl(true); }
	function closeBook() { selectedId = null; writeUrl(); }
	function findSimilar(book: CatalogBook) { seedId = book.id; weights = {}; seedQuery = ''; navigate('similar'); }
	function setShelf(book: CatalogBook, status: ShelfStatus | '') {
		if (!status) { const next = { ...library }; delete next[book.id]; library = next; announce('Removed from your shelf'); }
		else { library = { ...library, [book.id]: { status, rating: library[book.id]?.rating ?? null, updatedAt: new Date().toISOString() } }; announce(`Added to ${shelfLabels[status].toLowerCase()}`); }
		persist('litrpg-hub:library:v1', library);
	}
	function saveBook(book: CatalogBook) { if (library[book.id]) openBook(book); else setShelf(book, 'want'); }
	function rateBook(book: CatalogBook, rating: number) {
		library = { ...library, [book.id]: { status: library[book.id]?.status ?? 'read', rating: rating || null, updatedAt: new Date().toISOString() } };
		persist('litrpg-hub:library:v1', library);
	}
	function setFilter(key: keyof ReaderFilters, value: boolean) { filters = { ...filters, [key]: value }; visibleCount = 24; persist('litrpg-hub:filters:v1', filters); }
	function resetFilters() { filters = { ...defaultFilters }; genre = 'all'; includeUnclassified = false; persist('litrpg-hub:filters:v1', filters); }
	function searchChanged() { if (view === 'similar') view = 'index'; visibleCount = 24; writeUrl(); }
	function downloadShelf() {
		const blob = new Blob([JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), library }, null, 2)], { type: 'application/json' });
		const url = URL.createObjectURL(blob); const link = document.createElement('a');
		link.href = url; link.download = `litrpg-hub-shelf-${today}.json`; link.click(); URL.revokeObjectURL(url);
	}
	async function importShelf(event: Event) {
		const input = event.currentTarget as HTMLInputElement, file = input.files?.[0];
		if (!file) return;
		try {
			if (file.size > 5_000_000) throw new Error('File too large');
			const data = JSON.parse(await file.text());
			if (data.version !== 1 || !data.library || typeof data.library !== 'object') throw new Error('Invalid export');
			const imported = parseLibrary(data.library);
			library = { ...library, ...imported }; persist('litrpg-hub:library:v1', library); announce(`Imported ${Object.keys(imported).length} shelf entries`);
		} catch { announce('That file is not a valid LitRPG Hub shelf export.'); }
		input.value = '';
	}
	async function loadCatalog(signal?: AbortSignal) {
		loading = true; error = '';
		try {
			const response = await fetch(`${base}/data/catalog.json`, { signal });
			if (!response.ok) throw new Error('Catalog request failed');
			const data = await response.json();
			if (data.version !== 1 || !Array.isArray(data.books)) throw new Error('Unsupported catalog');
			catalog = data;
		} catch (e) { if (!(e instanceof DOMException && e.name === 'AbortError')) error = 'The catalog couldn’t be loaded. Please try again.'; }
		finally { loading = false; }
	}
	onMount(() => {
		readUrl();
		try { library = parseLibrary(JSON.parse(localStorage.getItem('litrpg-hub:library:v1') ?? '{}')); filters = parseFilters(JSON.parse(localStorage.getItem('litrpg-hub:filters:v1') ?? '{}')); }
		catch { storageWarning = 'Your saved preferences could not be loaded. You can import a shelf backup.'; }
		const controller = new AbortController(); loadCatalog(controller.signal);
		return () => { controller.abort(); clearTimeout(toastTimer); };
	});
</script>

<svelte:head>
    <title>{selectedBook ? `${selectedBook.title} · ` : ''}LitRPG Hub</title>
    <meta name="description" content="Search LitRPG and progression fantasy books, compare similar stories, track your reading, and check audiobook releases."/>
</svelte:head>
<svelte:window onpopstate={readUrl}/>
<a class="skip-link" href="#main">Skip to books</a>
<header class="site-header">
    <button class="brand" onclick={() => navigate('index')}><span class="brand-mark"><Icon name="book" size={18}/></span>LitRPG Hub</button>
    <nav aria-label="Main navigation">
        {#each navigation as item}<button class:active={view === item.id} aria-current={view === item.id ? 'page' : undefined} onclick={() => navigate(item.id)}>{item.label}{#if item.id === 'shelf' && shelfCount}<span class="nav-count">{shelfCount}</span>{/if}</button>{/each}
    </nav>
    <form class="global-search" onsubmit={e => { e.preventDefault(); searchChanged(); }} role="search">
        <Icon name="search" size={16}/><input aria-label="Search books, series, authors, or narrators" placeholder="Search books, series, authors…" bind:value={query} oninput={searchChanged}/>
        {#if query}<button type="button" class="icon-button" aria-label="Clear search" onclick={() => { query = ''; writeUrl(); }}><Icon name="close" size={14}/></button>{/if}
    </form>
</header>
<main id="main" class="main-shell">
    <div class="page-heading">
        <h1>{view === 'similar' ? 'Similar books' : view === 'releases' ? 'Audiobook releases' : view === 'shelf' ? 'My shelf' : 'Book index'}</h1>
        {#if view === 'shelf'}<span class="small-note">Saved in this browser</span><div class="shelf-tools"><button class="secondary-button" onclick={downloadShelf}>Export</button><button class="secondary-button" onclick={() => importInput?.click()}>Import</button><input class="visually-hidden" type="file" accept="application/json,.json" bind:this={importInput} onchange={importShelf} aria-label="Import a shelf backup"/></div>{/if}
    </div>
    {#if storageWarning}<p class="notice" role="status">{storageWarning}</p>{/if}
    {#if error}<div class="empty-state" role="alert"><p>{error}</p><button class="secondary-button" onclick={() => loadCatalog()}>Retry</button></div>
    {:else if loading}<p class="loading" role="status">Loading catalog…</p>
    {:else if view === 'similar'}
        <div class="match-layout">
            <aside class="taste-controls" aria-label="Similarity settings">
                <label for="seed-search">Starting book</label><input id="seed-search" bind:value={seedQuery} placeholder="Search series…"/>
                <label class="visually-hidden" for="seed-select">Choose a starting book</label>
                <select id="seed-select" value={seed?.id ?? ''} onchange={e => { seedId = e.currentTarget.value; writeUrl(); }}>
                    {#if seed && !seedOptions.some(b => b.id === seed.id)}<option value={seed.id}>{seed.series || seed.title}</option>{/if}
                    {#each seedOptions as book}<option value={book.id}>{book.series || book.title} — {book.author}</option>{/each}
                </select>
                {#if seed}<button class="seed-book" onclick={() => openBook(seed)}>{#if seed.coverUrl}<img src={seed.coverUrl} alt=""/>{/if}<span><strong>{seed.title}</strong><small>{seed.author}</small></span></button>{/if}
                <div class="weight-heading"><h2>Match priorities</h2><button class="subtle-button" onclick={() => weights = {}}>Reset</button></div>
                {#each Object.keys(tasteLabels) as key}<label class="weight-control"><span>{tasteLabels[key as Taste]}<small>{(weights[key as Taste] ?? 1) === 0 ? 'Ignore' : `${weights[key as Taste] ?? 1}×`}</small></span><input type="range" min="0" max="3" step="0.5" value={weights[key as Taste] ?? 1} oninput={e => weights = { ...weights, [key]: Number(e.currentTarget.value) }}/></label>{/each}
                <p class="small-note">{seed?.assessment ? 'Matches compare reading traits estimated from publisher descriptions. Books without profiles use genre overlap.' : 'This book has no reading profile yet. Results use genre overlap.'}</p>
            </aside>
            <section class="match-results" aria-label="Similar books">
                <div class="browse-toolbar"><span>{recommendations.length} matches <span class="muted">· {semanticCount} by reading traits</span></span>{@render layoutControls()}{@render filterButton()}</div>
                {@render preferences()}
                {#if recommendations.length}<div class="book-list" class:cover-grid={bookLayout === 'grid'} role="list">{#each recommendations as rec (rec.book.id)}<BookTile layout={bookLayout} book={rec.book} entry={library[rec.book.id]} recommendation={rec} onopen={openBook} onsave={saveBook} onlike={findSimilar}/>{/each}</div>
                {:else}<div class="empty-state"><p>No matches with these filters.</p><button class="secondary-button" onclick={resetFilters}>Reset filters</button></div>{/if}
            </section>
        </div>
    {:else if view === 'releases'}
        <div class="browse-toolbar">
            <div class="segmented" aria-label="Release period">{#each [{ id: 'upcoming', label: 'Upcoming' }, { id: 'year', label: 'By year' }, { id: 'unknown', label: 'Date unknown' }] as mode}<button class:chosen={releaseMode === mode.id} onclick={() => { releaseMode = mode.id; visibleCount = 24; }}>{mode.label}</button>{/each}</div>
            {#if releaseMode === 'year'}<select aria-label="Release year" bind:value={releaseYear} onchange={() => visibleCount = 24}>{#each years as year}<option value={year}>{year}</option>{/each}</select><select aria-label="Release month" bind:value={releaseMonth} onchange={() => visibleCount = 24}><option value="all">All months</option>{#each Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2,'0')) as month}<option value={month}>{new Intl.DateTimeFormat('en', { month: 'long', timeZone: 'UTC' }).format(new Date(`2026-${month}-15T12:00:00Z`))}</option>{/each}</select>{/if}
            {@render filterButton()}
        </div>
        {@render preferences()}
        <div class="results-meta"><span>{releaseBooks.length.toLocaleString()} releases{query ? ` matching “${query}”` : ''}</span><span>US Audible · {@render freshness()}</span></div>
        {#if releaseBooks.length}{@render listHeading()}<div class="book-list" role="list">{#each releaseBooks.slice(0, visibleCount) as book (book.id)}<BookTile layout="list" {book} entry={library[book.id]} onopen={openBook} onsave={saveBook} onlike={findSimilar}/>{/each}</div>{#if releaseBooks.length > visibleCount}<button class="load-more" onclick={() => visibleCount += 24}>Show 24 more</button>{/if}
        {:else}<div class="empty-state"><p>No releases found. The source snapshot may be out of date.</p><button class="secondary-button" onclick={() => { releaseMode = 'year'; releaseYear = '2026'; }}>View 2026 releases</button></div>{/if}
    {:else}
        {#if view === 'shelf'}<div class="shelf-tabs" aria-label="Shelf status"><button class:chosen={shelfStatus === 'all'} onclick={() => { shelfStatus = 'all'; visibleCount = 24; }}>All <span>{shelfCount}</span></button>{#each Object.entries(shelfLabels) as [key,label]}<button class:chosen={shelfStatus === key} onclick={() => { shelfStatus = key; visibleCount = 24; }}>{label}<span>{Object.values(library).filter(e => e.status === key).length}</span></button>{/each}</div>{/if}
        <div class="browse-toolbar">
            <label class="inline-field">Sort<select bind:value={sort} aria-label="Sort books"><option value="popular">Popular</option><option value="rating">Rating</option><option value="new">Newest release</option><option value="title">Title A–Z</option></select></label>
            <select bind:value={genre} aria-label="Filter by genre" onchange={() => visibleCount = 24}><option value="all">All genres</option>{#each Object.entries(genreLabels) as [key,label]}<option value={key}>{label}</option>{/each}</select>
            {#if view === 'index'}<label class="checkbox-label"><input type="checkbox" bind:checked={seriesOnly} onchange={() => visibleCount = 24}/>One per series</label><label class="checkbox-label"><input type="checkbox" checked={filters.hideSexualized} onchange={e => setFilter('hideSexualized', e.currentTarget.checked)}/>Hide sexualized content</label>{@render filterButton()}{/if}
        </div>
        {@render preferences()}
        <div class="results-meta"><span>{filteredBooks.length.toLocaleString()} books{query ? ` matching “${query}”` : ''}</span><div class="results-controls">{#if view === 'index'}<span>{seriesOnly ? 'Series entry points' : 'All editions'}</span>{/if}{@render layoutControls()}</div></div>
        {#if filteredBooks.length}{#if bookLayout === 'list'}{@render listHeading()}{/if}<div class="book-list" class:cover-grid={bookLayout === 'grid'} role="list">{#each filteredBooks.slice(0, visibleCount) as book (book.id)}<BookTile layout={bookLayout} {book} entry={library[book.id]} onopen={openBook} onsave={saveBook} onlike={findSimilar}/>{/each}</div>{#if filteredBooks.length > visibleCount}<button class="load-more" onclick={() => visibleCount += 24}>Show 24 more · {filteredBooks.length - visibleCount} remaining</button>{/if}
        {:else}<div class="empty-state"><p>{view === 'shelf' ? 'No books on this shelf. Use “Want to read” to add a book.' : 'No books match your search and filters.'}</p><button class="secondary-button" onclick={() => view === 'shelf' ? navigate('index') : resetFilters()}>{view === 'shelf' ? 'Browse books' : 'Reset filters'}</button></div>{/if}
    {/if}
    <footer>{@render freshness()}<a href="https://github.com/iamnbutler/litrpg-hub" target="_blank" rel="noreferrer">Source</a></footer>
</main>
{#snippet layoutControls()}<div class="view-controls" aria-label="Book layout"><button aria-pressed={bookLayout === 'grid'} class:chosen={bookLayout === 'grid'} onclick={() => bookLayout = 'grid'}>Grid</button><button aria-pressed={bookLayout === 'list'} class:chosen={bookLayout === 'list'} onclick={() => bookLayout = 'list'}>List</button></div>{/snippet}
{#snippet filterButton()}<button class="secondary-button filter-button" onclick={() => filtersOpen = !filtersOpen} aria-expanded={filtersOpen}><Icon name="filter" size={15}/>Filters <span class="muted">{activePreferenceCount}</span></button>{/snippet}
{#snippet listHeading()}<div class="list-heading" aria-hidden="true"><span>Book / author</span><span>Audible rating</span><span>Release date</span><span>Your shelf</span></div>{/snippet}
{#snippet preferences()}
    {#if filtersOpen && view !== 'shelf'}<section class="preferences-panel" aria-label="Content filters">
        <div class="preference-grid">
            {#each [{ key: 'hideSexualized', label: 'Sexualized covers / marketing' }, { key: 'hideExplicit', label: 'Explicit sexual content' }, { key: 'hideHarem', label: 'Harem / reverse harem' }, { key: 'hideAiNarration', label: 'Disclosed AI narration' }, { key: 'hideAiWriting', label: 'Disclosed AI writing' }, { key: 'hideQualityFlags', label: 'Listing quality concerns' }] as option}<label class="checkbox-label"><input type="checkbox" checked={filters[option.key as keyof ReaderFilters]} onchange={e => setFilter(option.key as keyof ReaderFilters, e.currentTarget.checked)}/>Hide {option.label.toLowerCase()}</label>{/each}
            <label class="checkbox-label"><input type="checkbox" checked={filters.hideUnknown} onchange={e => setFilter('hideUnknown', e.currentTarget.checked)}/>Also hide unclassified content</label>
            <label class="checkbox-label"><input type="checkbox" bind:checked={includeUnclassified} onchange={() => visibleCount = 24}/>Include genres awaiting review</label>
        </div>
        <div class="preference-foot"><span>Unclassified books stay visible by default. {coverCoverage.toLocaleString()} of {catalogBooks.length.toLocaleString()} visible editions have cover assessments.</span><button class="subtle-button" onclick={resetFilters}>Reset</button></div>
    </section>{/if}
{/snippet}
{#snippet freshness()}{#if catalog?.sourceSnapshotAt}<span class="freshness">Source snapshot: {displayDate(catalog.sourceSnapshotAt.slice(0,10))}</span>{/if}{/snippet}
{#if selectedBook}{#key selectedBook.id}<BookDetail book={selectedBook} seriesBooks={selectedSeries} entry={library[selectedBook.id]} onclose={closeBook} onshelf={setShelf} onrating={rateBook} onlike={findSimilar} onopen={openBook}/>{/key}{/if}
<div class="toast" class:visible={toast} role="status" aria-live="polite">{toast}</div>
