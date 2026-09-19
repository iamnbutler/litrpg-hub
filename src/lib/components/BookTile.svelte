<script lang="ts">
    import { displayDate, genreLabels, type CatalogBook, type Recommendation } from '$lib/catalog';
    import { shelfLabels, type ShelfEntry } from '$lib/library';
    import Icon from './Icon.svelte';
    let { book, entry, recommendation, onopen, onsave, onlike, layout = 'grid' }: {
        layout?: 'grid' | 'list'; book: CatalogBook; entry?: ShelfEntry; recommendation?: Recommendation;
        onopen: (book: CatalogBook) => void; onsave: (book: CatalogBook) => void; onlike: (book: CatalogBook) => void;
    } = $props();
    let imageFailed = $state(false);
    // Edition joins the genre list rather than being appended to it, so a book with no
    // genres reads "Dramatized" and not " \u00b7 Dramatized".
    const genres = $derived([
        ...book.subgenres.slice(0, 3).map((g) => genreLabels[g] ?? g),
        ...(book.edition === 'audiobook' ? [] : [book.edition === 'dramatized' ? 'Dramatized' : 'Collection'])
    ].join(' \u00b7 '));
</script>
<article class="book-row" class:grid={layout === 'grid'} role="listitem">
    <button class="book-cover" onclick={() => onopen(book)} aria-label={`Open ${book.title}`}>{#if book.coverUrl && !imageFailed}<img src={book.coverUrl} alt="" loading="lazy" onerror={() => imageFailed = true}/>{:else}<Icon name="book" size={24}/>{/if}</button>
    <div class="book-info">
        <h3><button onclick={() => onopen(book)}>{book.title}</button></h3>
        <p class="author">{book.author}{#if book.seriesNumber != null}<span>{' · '}Book {book.seriesNumber}</span>{/if}</p>
        {#if recommendation}<p class="match-reason">{recommendation.method === 'taste' ? 'Shared traits' : 'Shared genres'}: {recommendation.reasons.join(', ')}</p>
        {:else}<p class="genres">{genres}</p>{/if}
    </div>
    <div class="rating" aria-label={book.rating != null ? `${book.rating.toFixed(2)} from ${book.ratingCount} Audible ratings` : 'No Audible ratings'}><strong>{#if layout === 'grid'}<span class="rating-star" aria-hidden="true">★</span> {/if}{book.rating?.toFixed(2) ?? '—'}</strong><span>{book.ratingCount.toLocaleString()} ratings</span></div>
    <div class="release-date" class:hidden={layout === 'grid'}>{book.releaseDate ? displayDate(book.releaseDate) : 'Unknown'}</div>
    <div class="book-actions"><button class="save-book" class:saved={entry} onclick={() => onsave(book)}>{entry ? shelfLabels[entry.status] : '+ Want to read'}</button><button class="similar-book" onclick={() => onlike(book)} aria-label={`Find books like ${book.title}`}>Similar books</button></div>
</article>
<style>
.book-row { display:grid; grid-template-columns:50px minmax(0,1fr) 100px 114px 170px; align-items:center; gap:18px; min-width:0; padding:10px; border-bottom:1px solid var(--line); } .book-row:last-child { border-bottom:0; } .book-row:hover { background:#f1f3eb; }
.book-cover { width:50px; height:50px; padding:0; background:none; border:0; color:var(--muted); display:grid; place-items:center; } .book-cover img { display:block; width:100%; height:100%; object-fit:contain; } .book-info { min-width:0; }
h3 { margin:0 0 4px; font-size:13px; line-height:1.35; font-weight:600; } h3 button { padding:0; border:0; background:none; text-align:left; font:inherit; display:-webkit-box; -webkit-line-clamp:2; line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; } h3 button:hover { color:var(--green); text-decoration:underline; }
.author { font-size:12px; margin:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; } .author span,.genres { color:var(--muted); } .genres,.match-reason { font-size:11px; margin:4px 0 0; line-height:1.4; } .match-reason { color:var(--green); }
.rating strong { font-size:13px; font-weight:600; font-variant-numeric:tabular-nums; } .rating span { display:block; font-size:10px; color:var(--muted); margin-top:4px; } .release-date { color:var(--muted); font-size:12px; font-variant-numeric:tabular-nums; }
.book-actions { display:flex; align-items:start; flex-direction:column; gap:6px; } .save-book { border:1px solid #d4d8ce; border-radius:4px; background:white; color:var(--ink); padding:5px 9px; min-width:112px; font-size:11px; } .save-book:hover,.save-book.saved { background:var(--sage); color:var(--green); } .similar-book { border:0; background:none; color:var(--green); padding:0; font-size:11px; } .similar-book:hover { text-decoration:underline; }
@media(max-width:1000px) { .book-row { grid-template-columns:50px minmax(0,1fr) 85px 95px 135px; gap:12px; } }
@media(max-width:800px) { .book-row { grid-template-columns:44px minmax(0,1fr) 115px; gap:5px 12px; padding:12px 0; } .book-cover { width:44px; height:44px; grid-row:1 / 3; align-self:start; } .book-info { grid-column:2; grid-row:1; } .book-actions { grid-column:3; grid-row:1 / 3; justify-self:end; } .rating { grid-column:2; grid-row:2; display:flex; align-items:center; gap:5px; margin-top:3px; } .rating strong { font-size:11px; } .rating span { margin:0; } .release-date { grid-column:2; font-size:10px; } }
@media(max-width:420px) { .book-row { grid-template-columns:38px minmax(0,1fr) 103px; gap:5px 8px; } .book-cover { width:38px; height:38px; } .save-book { min-width:0; padding:5px 7px; } h3 { font-size:12px; } .author { font-size:11px; } .genres { font-size:10px; } }

.book-row.grid { display:flex; flex-direction:column; align-items:stretch; gap:0; border:0; padding:0; }
.book-row.grid:hover { background:none; }
.grid .book-cover { width:100%; height:auto; aspect-ratio:1; border-radius:3px; overflow:hidden; background:#eceee7; }
.grid .book-cover img { width:100%; height:100%; object-fit:contain; }
.grid .book-info { margin-top:11px; }
.grid h3 { font:600 16px/1.3 var(--serif); min-height:42px; margin-bottom:4px; }
.grid .author { font-size:12px; }
.grid .genres { font-size:10px; white-space:nowrap; text-overflow:ellipsis; overflow:hidden; min-height:14px; margin-top:5px; }
.grid .rating { display:flex; align-items:center; gap:6px; margin-top:10px; font-size:11px; }
.grid .rating strong { display:flex; align-items:center; gap:5px; font-size:12px; }
.grid .rating span { display:inline; margin:0; }
.grid .rating .rating-star { color:var(--gold); font-size:14px; }
.grid .book-actions { flex-direction:row; justify-content:space-between; align-items:center; gap:8px; margin-top:11px; }
.grid .save-book { flex:1; padding:7px 6px; background:transparent; min-width:0; }
.grid .save-book:hover,.grid .save-book.saved { background:var(--sage); }
.grid .similar-book { white-space:nowrap; font-size:10px; }
.grid .match-reason { font-size:10px; min-height:28px; }
.hidden { display:none; }
@media(max-width:580px) { .grid h3 { font-size:15px; min-height:39px; } .grid .book-actions { align-items:stretch; flex-direction:column; gap:7px; } .grid .similar-book { text-align:left; } }
</style>
