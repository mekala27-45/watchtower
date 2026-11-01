/** Public configuration only: credentials never belong in a browser build. */
export interface PublicRuntimeConfig {
  apiOrigin: string;
  allowLocal: boolean;
}

export type Method = 'deterministic_baseline' | 'local_agent' | 'recorded_local_agent';
export interface APIReadiness {
  ready: boolean;
  productionReady: boolean;
  revision: string;
  database: { backend: string; state: string };
}
