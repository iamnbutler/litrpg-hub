/** Public aggregate only. Review bodies and reviewer identities remain in private storage. */
export interface ReaderContext {
  entity: string;
  voices: number;
  substantiveVoices: number;
  samples: number;
  meanRating: number | null;
  span: [string, string] | null;
  sampling: 'bounded-public-review-sample';
  sources: { name: string; url: string }[];
  /** One qualitative assessment of the whole bounded sample. */
  consensus: 'consistent' | 'mixed' | 'insufficient' | null;
  /** Short original observation grounded in this bounded sample, not a publisher fact. */
  observation?: string | null;
  /** Confidence describes a model assessment, never a fraction of readers agreeing. */
  traits: {
    trait: string;
    value: string;
    confidence: number;
    modelConfidence: number;
    summary: string;
    voices: number;
  }[];
}
