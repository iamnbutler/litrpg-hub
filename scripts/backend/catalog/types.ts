export interface SeedSeries {
  id: string; title: string; author: string; authorAliases: string[]; aliases: string[];
  /** Explicit person-level aliases for a coauthored series. Distinct coauthors are never aliases. */
  authorIdentities?: { name: string; aliases: string[] }[];
  /** Reviewed publisher credits occasionally present in a retailer's author list; never person aliases. */
  publisherCredits?: string[];
  status?: 'ongoing' | 'complete' | 'unknown';
  statusEvidence?: { url: string; observedAt: string; summary: string };
  genres: string[]; priority: number; sources: { url: string; adapter: 'aethon-series' | 'sbt-series' | 'dinniman' | 'prh-series' | 'podium-series' | 'portal-author' | 'chatfield-series' | 'chatfield-book' | 'bagwell-author' | 'mountaindale-series' | 'grand-game-series' | 'nova-roma-author' | 'apostasy-author' | 'sarah-lin-author' | 'the-land-book' }[];
}
export interface Document { id: string; url: string; content_hash: string; body: string; fetched_at: string; method?:'publisher-page'|'author-page'|'curated-source-summary'|'curated-title-mapping'|'retailer-api'|'retailer-link' }
export interface WorkRow {
  id: string; series_id: string; number: number; title: string; author: string; description: string;
  source_description: string; source_url: string; cover_url: string | null;
  publication_status: 'released' | 'announced' | 'unknown'; first_release_date: string | null;
  metadata_json: string | null; assessment_json: string | null; updated_at: string;
}
export interface ExtractedBook {
  title: string; series: string; number: number; author: string; description: string;
  coverUrl: string | null; releaseDate: string | null; publicationStatus: WorkRow['publication_status'];
  format: 'ebook' | 'audiobook' | 'print' | 'unknown'; narrator: string | null;
  audioReleaseDate: string | null; audioRuntimeMinutes: number | null;
  links: { url: string; format: 'ebook' | 'audiobook' | 'print'; asin?: string }[];
}
export type Adapter = 'aethon-index' | 'sbt-index' | 'aethon-series' | 'sbt-series' | 'aethon-book' | 'sbt-book' | 'dinniman' | 'prh-series' | 'prh-book' | 'podium-series' | 'podium-book' | 'portal-author' | 'chatfield-series' | 'chatfield-book' | 'bagwell-author' | 'mountaindale-series' | 'mountaindale-book' | 'grand-game-series' | 'grand-game-book' | 'nova-roma-author' | 'apostasy-author' | 'sarah-lin-author' | 'the-land-book';
export interface SourcePayload { url: string; adapter: Adapter; seriesId?: string; number?: number; parentDocumentId?: string }
export interface AudioPayload { seriesId: string; workId: string; asin: string; sourceUrl: string }
/** A numbered author-page link with no canonical title yet. The retained document is mandatory. */
export interface IdentifiedAudioPayload {
  seriesId: string; number: number; asin: string; url: string; sourceUrl: string;
  adapter: 'sarah-lin-author'; sourceDocumentId: string; sourceContentHash: string;
}
export const AUDIO_ADAPTER_VERSION = 'known-audio-v3-bound-work';
export class ReviewError extends Error {}
/** The provider responded, but the receipt did not commit. Further purchases must stop. */
export class PaidResponseStorageError extends ReviewError {
  constructor() { super('The paid response could not be saved. Review database storage before manually retrying; another attempt may incur another charge.'); }
}
