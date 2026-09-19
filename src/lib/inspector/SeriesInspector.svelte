<script lang="ts">
	import type { SeriesHealth, WorkHealth } from '$lib/catalog-health';
	import { resolve } from '$app/paths';
	import Icon from '$lib/components/Icon.svelte';
	import CheckStatus from './CheckStatus.svelte';
	import DataScore from './DataScore.svelte';
	import { audioLabel, checkGroups, formatDate, groupedCheck, safeSourceUrl, sourceHost } from './health-view';
	let { series, works }: { series: SeriesHealth; works: WorkHealth[] } = $props();
	let gapsOnly = $state(false);
	let openWork = $state<string | null>(null);
	const visibleWorks = $derived(works.filter((work) => !gapsOnly || work.checks.some((check) => check.status !== 'present')));
	const missingWorks = $derived(works.filter((work) => work.checks.some((check) => check.status === 'missing')).length);
	const issuePreview = $derived(series.issues.slice(0, 4));
	const issueRemainder = $derived(series.issues.slice(4));
</script>

<div class="series-summary">
	<div><span class="summary-label">Known works</span><strong>{works.length}</strong><small>{series.confirmedAudioWorks} with verified audio</small></div>
	<div><span class="summary-label">Works with missing data</span><strong class="gap-count">{missingWorks}</strong><small>Retained catalog fields</small></div>
	<div><span class="summary-label">Data completeness</span><DataScore score={series.completeness} label="Data completeness" /><small>{series.completeness.earned} / {series.completeness.possible} checks</small></div>
	<div><span class="summary-label">Evidence quality</span><DataScore score={series.evidenceQuality} label="Evidence quality" kind="evidence" /><small>{series.evidenceQuality.earned} / {series.evidenceQuality.possible} checks</small></div>
</div>

<div class="attention-layout">
	<section class="attention-panel" aria-labelledby="series-attention-heading">
		<div class="panel-heading"><h2 id="series-attention-heading">Needs attention</h2><span>{series.issues.length} recorded issues</span></div>
		{#if series.missingVolumes.length}
			<ul class="volume-gaps">
				{#each series.missingVolumes as gap (gap.number)}
					<li><div><CheckStatus status={gap.status} /><strong>Volume {gap.number}</strong><span class="evidence-label">{gap.evidence === 'reviewed-bibliography' ? 'Reviewed bibliography' : 'Numbering needs review'}</span></div><p>{gap.explanation}</p></li>
				{/each}
			</ul>
		{/if}
		{#if issuePreview.length}
			<ul class="issue-list">
				{#each issuePreview as issue, i (`${issue.code}-${i}`)}<li><CheckStatus status={issue.status} /><span>{issue.message}</span></li>{/each}
			</ul>
			{#if issueRemainder.length}
				<details class="more-issues"><summary>Show {issueRemainder.length} more issues</summary><ul class="issue-list">{#each issueRemainder as issue, i (`${issue.code}-${i}`)}<li><CheckStatus status={issue.status} /><span>{issue.message}</span></li>{/each}</ul></details>
			{/if}
		{:else if !series.missingVolumes.length}
			<p class="panel-copy">No gaps were recorded by these checks. This does not establish that the series is finished.</p>
		{/if}
	</section>
	<section class="bibliography-panel" aria-labelledby="bibliography-heading">
		<div class="panel-heading"><h2 id="bibliography-heading">Audio bibliography</h2><CheckStatus status={series.bibliography.status} /></div>
		<p class="panel-copy">{series.bibliography.explanation}</p>
		<dl>
			<div><dt>Reviewed volumes</dt><dd>{series.bibliography.expectedNumbers.length ? series.bibliography.expectedNumbers.join(', ') : 'No reviewed list'}</dd></div>
			<div><dt>Reviewed</dt><dd>{formatDate(series.bibliography.reviewedAt)}</dd></div>
			<div><dt>Valid through</dt><dd>{formatDate(series.bibliography.validUntil, true)}</dd></div>
		</dl>
		<div class="bibliography-links">
			{#each series.bibliography.sourceUrls as source (source)}
				{@const url = safeSourceUrl(source)}
				{#if url}<a href={url} target="_blank" rel="external noreferrer">{sourceHost(url)} <Icon name="external" size={12} /><span class="visually-hidden"> (opens in a new tab)</span></a>{/if}
			{/each}
		</div>
	</section>
</div>

<div class="works-heading">
	<div><h2>Books & evidence</h2><p>Select a title to inspect its checks. All known formats are included.</p></div>
	<label><input type="checkbox" bind:checked={gapsOnly} /> Gaps and review only</label>
	<a class="hub-link" href={resolve(`/?view=series&series=${encodeURIComponent(series.id)}`)}>Open series in Hub <Icon name="external" size={13} /></a>
</div>

<div class="work-table-scroll" role="region" aria-label="Book evidence table">
	<table>
		<caption class="visually-hidden">Every known work in {series.title}, including works without verified audiobooks. Missing means missing catalog data, not a confirmed absence of an edition.</caption>
		<thead><tr><th scope="col">Book</th><th scope="col">Data</th><th scope="col">Evidence</th>{#each checkGroups as group (group.id)}<th scope="col">{group.label}</th>{/each}</tr></thead>
		<tbody>
			{#each visibleWorks as work (work.id)}
				<tr class:expanded={openWork === work.id}>
					<th scope="row"><button class="work-toggle" aria-expanded={openWork === work.id} aria-controls={`checks-${encodeURIComponent(work.id)}`} onclick={() => openWork = openWork === work.id ? null : work.id}>
						<span class="work-number">{work.number === null ? '—' : `#${work.number}`}</span><span class="work-name"><strong>{work.title}</strong><small>{work.formats.length ? work.formats.join(' · ') : 'Format unknown'}</small></span><span class:turned={openWork === work.id} class="row-chevron"><Icon name="chevron" size={14} /></span>
					</button></th>
					<td><DataScore score={work.completeness} label="Data completeness" /></td>
					<td><DataScore score={work.evidenceQuality} label="Evidence quality" kind="evidence" /></td>
					{#each checkGroups as group (group.id)}
						{@const check = groupedCheck(work.checks, group)}
						<td><CheckStatus status={check.status} explanation={check.explanation} label={group.id === 'audio' && check.status === 'present' ? 'Verified' : undefined} />
							{#if group.id === 'audio'}<small>{audioLabel(work)}</small>
							{:else if group.id === 'date' && work.audio.releaseDate}<small>{formatDate(work.audio.releaseDate)}</small>
							{:else if group.id === 'readers'}<small>{work.reader.selectedCount} usable / {work.reader.minimum} min.</small>{/if}
						</td>
					{/each}
				</tr>
				{#if openWork === work.id}
					<tr class="work-detail-row"><td colspan={3 + checkGroups.length}>
						<div class="work-details" id={`checks-${encodeURIComponent(work.id)}`}>
							<div class="detail-heading"><h3>Checks for {work.title}</h3><span>{work.audio.confirmedEditionCount} verified / {work.audio.retainedEditionCount} retained audio editions</span></div>
							<p class="detail-note">Unknown means the evidence cannot settle the check. Missing means the catalog does not hold the required data.</p>
							<div class="check-grid">
								{#each work.checks as check (check.id)}
									{@const source = safeSourceUrl(check.sourceUrl)}
									<section class="check-detail"><div><h4>{check.label}</h4><CheckStatus status={check.status} /></div><p>{check.explanation}</p>
										<small>{check.available ? 'Data retained' : 'No supporting data retained'}{#if check.observedAt} · {formatDate(check.observedAt)}{/if}{#if check.dueAt} · Due {formatDate(check.dueAt)}{/if}</small>
										{#if source}<a href={source} target="_blank" rel="external noreferrer">{sourceHost(source)} <Icon name="external" size={11} /><span class="visually-hidden"> (opens in a new tab)</span></a>{/if}
									</section>
								{/each}
							</div>
						</div>
					</td></tr>
				{/if}
			{:else}
				<tr><td colspan={3 + checkGroups.length} class="no-works">{gapsOnly ? 'No works need attention in this snapshot.' : 'No works have been retained for this series.'}</td></tr>
			{/each}
		</tbody>
	</table>
</div>

<p class="series-footnote">Numbering alone cannot prove a missing book or a complete series. Reader counts are usable sampled comments, not confirmed listeners.</p>

<style>
	.series-summary { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); border:1px solid var(--ins-line,#2b3441); background:var(--ins-panel,#1b212b); border-radius:5px; margin-bottom:18px; }
	.series-summary > div { padding:16px 18px; border-right:1px solid var(--ins-line,#2b3441); display:flex; flex-direction:column; align-items:start; gap:8px; }
	.series-summary > div:last-child { border-right:0; }
	.summary-label { font-size:11px; color:#aab6c8; }
	.series-summary strong { font-size:22px; line-height:1; font-weight:550; font-variant-numeric:tabular-nums; }
	.series-summary small { font-size:11px; color:#8e9bb0; }
	.gap-count { color:#edbb72; }
	.attention-layout { display:grid; grid-template-columns:minmax(0,1.6fr) minmax(290px,1fr); gap:16px; margin-bottom:22px; }
	.attention-panel,.bibliography-panel { border:1px solid var(--ins-line,#2b3441); background:#181e27; padding:14px 16px; border-radius:5px; min-width:0; }
	.panel-heading { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:12px; }
	h2 { font-size:13px; font-weight:600; color:#e0e7f0; }
	.panel-heading > span { color:#8e9bb0; font-size:11px; }
	.panel-copy { line-height:1.6; color:#a8b5c7; font-size:12px; }
	.issue-list,.volume-gaps { list-style:none; padding:0; margin:0; }
	.issue-list li { display:flex; align-items:baseline; gap:11px; font-size:12px; line-height:1.55; padding:5px 0; color:#bcc6d5; }
	.issue-list li > span { min-width:0; }
	.volume-gaps li { padding:9px 11px; border-left:2px solid #9b783f; background:#28251f; margin-bottom:10px; }
	.volume-gaps li > div { display:flex; flex-wrap:wrap; align-items:center; gap:9px; }
	.volume-gaps strong { font-size:12px; font-weight:600; }
	.volume-gaps p { color:#b9b4a9; font-size:12px; line-height:1.55; margin-top:5px; }
	.evidence-label { color:#b9b4a9; font-size:10px; }
	.more-issues { margin-top:9px; font-size:12px; } summary { color:#76c9d2; cursor:pointer; padding:4px 0; }
	dl { font-size:11px; margin:13px 0 0; } dl > div { display:grid; grid-template-columns:105px minmax(0,1fr); gap:10px; margin-top:7px; }
	dt { color:#8e9bb0; } dd { margin:0; color:#ccd5e2; overflow-wrap:anywhere; }
	.bibliography-links { display:flex; flex-wrap:wrap; gap:10px; margin-top:12px; }
	a { color:#7ecbd3; display:inline-flex; align-items:center; gap:5px; font-size:11px; }
	.works-heading { display:flex; align-items:center; gap:18px; margin-bottom:12px; flex-wrap:wrap; }
	.works-heading p { font-size:11px; color:#8e9bb0; margin-top:5px; }
	.works-heading label { display:flex; align-items:center; gap:7px; margin-left:auto; color:#b9c5d5; font-size:11px; }
	.works-heading input { accent-color:#63c5c2; }
	.hub-link { border:1px solid #344151; border-radius:4px; padding:7px 10px; }
	.work-table-scroll { position:relative; overflow:auto; border:1px solid var(--ins-line,#2b3441); border-radius:5px; }
	table { width:100%; min-width:1040px; border-collapse:collapse; text-align:left; font-size:12px; }
	caption { text-align:left; }
	thead th { padding:11px 12px; font-size:10px; letter-spacing:.025em; color:#a8b5c7; font-weight:500; white-space:nowrap; background:#1e2631; border-bottom:1px solid #344151; }
	thead th:first-child { padding-left:16px; }
	tbody th,tbody td { padding:12px; border-bottom:1px solid #28313e; vertical-align:middle; font-weight:400; }
	tbody th { padding:0; width:260px; min-width:230px; }
	tbody tr:nth-child(odd) { background:#181e27; } tbody tr:nth-child(even) { background:#161c25; }
	tbody tr.expanded { background:#202e3b; }
	td > small { display:block; font-size:10px; color:#8e9bb0; margin-top:5px; white-space:nowrap; }
	.work-toggle { width:100%; display:flex; align-items:center; gap:10px; text-align:left; border:0; color:#dce5f1; padding:15px 12px; background:transparent; }
	.work-toggle:hover { color:#85d5da; }
	.work-number { font:11px ui-monospace,SFMono-Regular,Consolas,monospace; color:#8293a9; min-width:24px; text-align:center; }
	.work-name { flex:1; min-width:0; } .work-name strong { display:block; line-height:1.4; font-size:12px; font-weight:550; }
	.work-name small { display:block; color:#8e9bb0; font-size:10px; margin-top:5px; }
	.row-chevron { color:#72869b; display:inline-flex; } .turned { transform:rotate(90deg); }
	.work-detail-row > td { padding:0; } .work-details { padding:20px; background:#111922; border-top:1px solid #344455; }
	.detail-heading { display:flex; align-items:baseline; gap:20px; justify-content:space-between; } h3 { color:#d7e2ef; font-size:13px; }
	.detail-heading > span,.detail-note { font-size:11px; color:#8e9bb0; } .detail-note { margin:8px 0 14px; }
	.check-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:10px; }
	.check-detail { padding:12px; border:1px solid #2a3847; background:#19222d; border-radius:4px; min-width:0; }
	.check-detail > div { display:flex; align-items:start; gap:10px; justify-content:space-between; }
	h4 { margin:0; font-size:11px; color:#d0dce9; font-weight:550; } .check-detail p { font-size:11px; line-height:1.6; color:#aab8ca; margin:9px 0; overflow-wrap:anywhere; }
	.check-detail > small { font-size:10px; color:#8799af; display:block; line-height:1.6; } .check-detail > a { margin-top:8px; overflow-wrap:anywhere; }
	.no-works { text-align:center; padding:30px; color:#9fadc0; }
	.series-footnote { color:#8e9bb0; font-size:11px; line-height:1.7; margin-top:12px; }
	@media(max-width:1100px) { .attention-layout { grid-template-columns:1fr; } }
	@media(max-width:650px) { .series-summary { grid-template-columns:1fr 1fr; } .series-summary > div { border-bottom:1px solid #2b3441; padding:14px; } .series-summary > div:nth-child(2) { border-right:0; } .series-summary > div:nth-child(n+3) { border-bottom:0; } .works-heading label { margin-left:0; } .hub-link { margin-left:auto; } .work-details { padding:14px; } .attention-panel,.bibliography-panel { padding:12px; } .panel-heading { gap:6px; } }
</style>
