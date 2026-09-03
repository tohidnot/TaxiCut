import type { TaxiCutApi } from '../../preload/index';

declare global {
  interface Window {
    taxicut: TaxiCutApi;
  }
}
export {};
