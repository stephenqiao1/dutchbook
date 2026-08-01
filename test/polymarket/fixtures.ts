import { readFileSync } from 'node:fs';

/**
 * Recorded Gamma payloads. Nothing in the Polymarket suite touches the network:
 * the client's `fetch` is always injected and always answers from one of these.
 */
export function loadFixture(name: string): unknown {
  const url = new URL(`../fixtures/polymarket/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8'));
}

/** The same fixture as the raw text a real response body would carry. */
export function fixtureText(name: string): string {
  return JSON.stringify(loadFixture(name));
}
