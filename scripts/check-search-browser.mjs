// Run with node --import tsx, PLAYWRIGHT_MODULE and CHROMIUM pointing to installed
// tooling. Only public artwork is fetched live; metadata uses captured public
// MusicBrainz responses and controlled Last.fm envelopes. No production state.
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildApp, passwordHash } from '../server/app.ts';
import { makeStore } from '../server/test-fixtures.ts';
import { Upstreams } from '../server/upstream.ts';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const output = resolve(process.env.SCREENSHOTS ?? 'screenshots-search');
mkdirSync(output, { recursive: true });
const fixture = name => JSON.parse(readFileSync(new URL(`../server/fixtures/${name}.json`, import.meta.url), 'utf8'));
const pablo = fixture('search-pablo');
const radiohead = fixture('search-radiohead');
const discography = fixture('search-radiohead-albums');
const discographyPage2 = fixture('search-radiohead-page2');
const cover = 'https://lastfm-img.freetls.fastly.net/i/u/500x500/8c6af1315c66631bad022085c7992b34.jpg';
const failedCover = cover.replace('/500x500/', '/300x300/');
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
let slow = false;
let unavailable = false;
let failPrimary = false;
const calls = [];
const upstream = new Upstreams(async url => {
  assert.ok(url instanceof URL);
  calls.push([url.hostname, url.pathname, url.searchParams.get('query')]);
  if (slow) await new Promise(resolve => setTimeout(resolve, 1500));
  if (unavailable) return json({}, 503);
  if (url.hostname === 'musicbrainz.org') {
    const q = url.searchParams.get('query') ?? '';
    if (url.pathname.endsWith('/artist')) return json(/Radiohead/.test(q) ? radiohead : { artists: [] });
    if (url.pathname.endsWith('/release-group')) {
      if (q.startsWith('arid:')) return json(url.searchParams.get('offset') === '25' ? discographyPage2 : discography);
      return json(/pablo/i.test(q) ? pablo : { count: 0, 'release-groups': [] });
    }
    if (url.pathname.endsWith('/release')) return json({ 'release-count': 1, releases: [{ id: '99e14f9e-5831-4b2c-b595-531be0f225ea', title: 'The Life of Pablo', date: '2016-02-14', country: 'US', 'artist-credit': pablo['release-groups'][0]['artist-credit'] }] });
  }
  if (url.hostname === 'ws.audioscrobbler.com') {
    assert.equal(url.searchParams.get('api_key'), 'disposable-key');
    const method = url.searchParams.get('method');
    if (method === 'user.getTopArtists') return json({ topartists: { artist: [] } });
    if (method === 'artist.getTopAlbums') return json({ topalbums: { album: [] } });
    if (method === 'album.search') return json({ results: { albummatches: { album: [{ name: 'The Life of Pablo', artist: 'Kanye West', image: [{ size: 'large', '#text': failPrimary ? failedCover : cover }] }] } } });
  }
  throw new Error(`Unexpected provider: ${url.hostname}${url.pathname}`);
});
const store = makeStore();
store.db.prepare('INSERT INTO users(id,username,password,role) VALUES(?,?,?,?)').run('public-review', 'review', await passwordHash('disposable-password'), 'admin');
store.putSecret('installation', 'settings', JSON.stringify({ jellyfinURL: 'https://fixture.invalid', lidarrURL: null, lidarrKey: null, rootFolderPath: null, qualityProfileID: null, metadataProfileID: null }));
store.putSecret('public-review', 'lastfm', JSON.stringify({ username: 'disposable', apiKey: 'disposable-key' }));
const options = { store, upstream, origin: 'http://127.0.0.1', secure: false, setupToken: 'disposable-setup', fixturePreview: true, webRoot: resolve('dist/web') };
const { app } = await buildApp(options);
options.origin = await app.listen({ port: 0, host: '127.0.0.1' });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const failures = [];
  page.on('pageerror', error => failures.push(error.message));
  // Deterministic unavailable-provider cases, not fictitious MBIDs or covers.
  await page.route('https://coverartarchive.org/**', route => route.fulfill({ status: 404, body: '' }));
  await page.goto(options.origin);
  await page.getByLabel('Username', { exact: true }).fill('review');
  await page.getByLabel('Password', { exact: true }).fill('disposable-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const search = page.getByRole('textbox', { name: 'Search artists and albums' });
  const submit = async value => { await search.fill(value); await search.press('Enter'); };
  const liveCover = page.waitForResponse(response => response.url() === cover && response.status() === 200);
  await submit('the life of pablo');
  const card = page.locator('.artCard[title="The Life of Pablo — Kanye West"]');
  await card.waitFor();
  await page.waitForFunction(() => document.querySelector('.artCard img')?.naturalWidth === 500);
  const coverBytes = await (await liveCover).body();
  assert.equal(await card.locator('img').getAttribute('src'), cover);
  assert.equal(await page.locator('.artCard').count(), 3);
  assert.equal(await page.locator('.coverStatus').count(), 2);
  await page.screenshot({ path: `${output}/leerr-search-pablo.png` });
  const filters = page.getByRole('group', { name: 'Search result type' });
  const beforeFilter = calls.length;
  await filters.getByRole('button', { name: 'Artists', exact: true }).click();
  await page.getByText('No artists matched all your search terms.', { exact: false }).waitFor();
  assert.equal(await search.inputValue(), 'the life of pablo');
  await filters.getByRole('button', { name: 'Albums', exact: true }).focus();
  await page.keyboard.press('Space');
  assert.equal(await filters.getByRole('button', { name: 'Albums', exact: true }).getAttribute('aria-pressed'), 'true');
  assert.equal(calls.length, beforeFilter);
  await card.click();
  await page.getByRole('heading', { name: 'Choose an edition' }).waitFor();
  assert.equal(await page.getByRole('dialog').count(), 1);
  await page.keyboard.press('Escape');
  await filters.getByRole('button', { name: 'All', exact: true }).click();
  await submit('Radiohead');
  await page.locator('.artistMatch').first().waitFor();
  assert.match(await page.locator('.artistMatch').nth(1).innerText(), /pre‐Radiohead group/);
  assert.equal(await page.locator('.artistMatch').first().locator('.lucide-users-round').count(), 1);
  assert.match(await page.locator('.artistMatch').first().innerText(), /ARTIST[\s\S]*Browse albums/);
  await page.screenshot({ path: `${output}/leerr-search-artists.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await filters.getByRole('button', { name: 'Artists', exact: true }).click();
  await page.screenshot({ path: `${output}/leerr-search-artists-mobile.png` });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.locator('.artistMatch').last().scrollIntoViewIfNeeded();
  const lastArtist = await page.locator('.artistMatch').last().boundingBox();
  assert.ok(lastArtist && lastArtist.y + lastArtist.height <= 844 - 64);
  await page.locator('.artistMatch').first().focus();
  await page.keyboard.press('Enter');
  await page.getByRole('heading', { name: 'Radiohead', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Next', exact: true }).waitFor();
  assert.equal(await page.locator('.artCard').count(), 25);
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByText('26–50 of 385').waitFor();
  assert.match(await page.locator('.artCard').first().innerText(), /Akasaka Blitz/);
  assert.ok(calls.some(([, , query]) => query?.includes('status:official^5')));
  await page.getByRole('button', { name: 'Back to search' }).click();
  await page.locator('.artistMatch').first().waitFor();
  assert.equal(await search.inputValue(), 'Radiohead');
  await page.setViewportSize({ width: 1440, height: 1000 });
  slow = true;
  await submit('the life of pablo');
  await page.getByText('Loading music…').waitFor();
  await filters.getByRole('button', { name: 'Albums', exact: true }).click();
  assert.equal(await page.getByText('Nothing here yet').count(), 0);
  await page.screenshot({ path: `${output}/leerr-search-loading.png` });
  slow = false;
  await card.waitFor();
  await submit('no-such-music-result');
  await page.getByText('Nothing here yet').waitFor();
  await page.screenshot({ path: `${output}/leerr-search-empty.png` });
  unavailable = true;
  await submit('the life of pablo');
  await page.getByRole('button', { name: 'Try again', exact: true }).waitFor();
  await page.screenshot({ path: `${output}/leerr-search-error.png` });
  unavailable = false;
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await card.waitFor();
  await page.waitForFunction(() => document.querySelector('.artCard img')?.naturalWidth === 500);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${output}/leerr-search-pablo-mobile.png` });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  // Exercise successful CAA fallback separately with controlled image bytes.
  // Primary-cover verification above used the actual live Fastly response.
  const groupArt = 'https://coverartarchive.org/release-group/8c18657a-6338-490d-a952-897663596b96/front-500';
  // A new URL avoids reusing Chromium's already decoded successful image.
  failPrimary = true;
  await page.route(failedCover, route => route.abort('failed'));
  await page.route(groupArt, route => route.fulfill({ status: 200, contentType: 'image/jpeg', body: coverBytes }));
  await submit('the life of pablo');
  await page.waitForFunction(expected => {
    const image = document.querySelector('.artCard img');
    return image?.src === expected && image.naturalWidth === 500;
  }, groupArt);
  assert.equal(await card.locator('img').getAttribute('src'), groupArt);
  assert.equal(failures.length, 0, failures.join('\n'));
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM acquisitions').get().count, 0);
  console.log('PASS: real Fastly cover under production CSP; controlled CAA failure; artist/album filters, labels, keyboard, paging, loading/empty/error/retry, mobile, edition dialog; no acquisitions.');
} finally {
  await browser.close(); await app.close(); store.close();
}
