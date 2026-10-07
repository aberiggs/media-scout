export interface GeneralSearchRequest { query: string }
export interface GeneralRelease {
  releaseId: string; title: string; indexer: string; size: number | null; seeders: number | null;
  leechers: number | null; age: number; protocol: 'unknown' | 'usenet' | 'torrent';
  selectable: boolean; unavailableReason: string | null;
}
export interface GeneralSearchResponse {
  status: 'clarification-needed' | 'selection-required'; query: string; queries: string[];
  question: string; searchId: string | null; expiresAt: string | null; confirmationToken: string | null;
  releases: GeneralRelease[]; destination: { name: string; protocol: 'usenet' | 'torrent' } | null;
  dryRun: boolean; actionsAllowed: boolean; blockedReason: string | null;
}
export interface GeneralGrabRequest { confirmationToken: string; releaseIds: string[]; confirmed: true }
export interface GeneralGrabResponse {
  searchId: string; dryRun: boolean;
  results: Array<{ releaseId: string; status: 'submitted' | 'dry-run' | 'submitting' | 'failed' | 'uncertain' | 'not-attempted'; code: string | null }>;
}
