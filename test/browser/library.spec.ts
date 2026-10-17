import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';

function wavFixture(): Buffer {
	const wav = Buffer.alloc(1644);
	wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
	wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
	wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
	wav.write('data', 36); wav.writeUInt32LE(1600, 40);
	return wav;
}
async function grant(request: APIRequestContext, listener = false): Promise<string> {
	const result = await request.post('/auth/token', { data: { grant_type: 'password', username: listener ? 'library-listener@example.test' : 'library-browser@example.test', password: listener ? 'library-listener-password' : 'library-browser-password', scope: 'all' } });
	expect(result.status()).toBe(200);
	return (await result.json() as { access_token: string }).access_token;
}
async function signedIn(page: Page, token: string, path = '/library'): Promise<void> {
	await page.goto('/');
	await page.evaluate(value => { sessionStorage.setItem('audiocity.access-token', value); }, token);
	await page.goto(path);
}
async function createAudio(request: APIRequestContext, token: string, title: string): Promise<{ id: string; title: string }> {
	const bytes = wavFixture(); const headers = { authorization: `Bearer ${token}` };
	const result = await request.post('/audio', { headers, data: { name: title + '.wav', title, size: bytes.length, mime: 'audio/wav', category: 'recording', visibility: 'private' } });
	expect(result.status()).toBe(201);
	const policy = await result.json() as { url: string; success: string; audio: { id: string; title: string } };
	expect((await request.put(policy.url, { data: bytes, headers: { 'content-type': 'application/octet-stream' } })).status()).toBe(200);
	expect((await request.post(policy.success)).status()).toBe(200);
	return policy.audio;
}
async function paste(page: Page, text: string): Promise<void> {
	await page.locator('[role=gridcell]:focus').evaluate((element, value) => {
		const clipboardData = new DataTransfer(); clipboardData.setData('text/plain', value);
		element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
	}, text);
}
async function menu(page: Page, name: string): Promise<void> {
	await page.locator('#menu > summary').click();
	await page.locator('#menu').getByRole('button', { name, exact: true }).click();
}

test('mixed uploads use library tabs, edit pages, shared preferences and public playback', async ({ page, request, browser }, info) => {
	const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); });
	const token = await grant(request);
	await signedIn(page, token);
	await expect(page.getByRole('tab', { name: 'Audio', exact: true })).toHaveAttribute('aria-selected', 'true');
	await page.getByRole('button', { name: '+ Upload', exact: true }).click();
	const archivePath = info.outputPath('Batch project.aup3'); const db = new DatabaseSync(archivePath);
	try { db.exec('CREATE TABLE project (value TEXT)'); } finally { db.close(); }
	await page.getByLabel('Audio or project files', { exact: true }).setInputFiles([
		{ name: 'Batch recording.wav', mimeType: 'audio/wav', buffer: wavFixture() },
		{ name: 'Batch project.aup3', mimeType: 'application/octet-stream', buffer: await readFile(archivePath) },
	]);
	await page.getByRole('button', { name: 'Upload files', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'Library', exact: true })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Batch recording', exact: true })).toBeVisible();
	await page.getByRole('tab', { name: 'Projects', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'Batch project', exact: true })).toBeVisible();
	await page.getByRole('tab', { name: 'Audio', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'Shared ambience', exact: true })).toBeVisible();
	await page.getByLabel('Include shared files in my library').uncheck();
	await expect(page.locator('#message')).toContainText('preference saved');
	await page.reload();
	await expect(page.getByLabel('Include shared files in my library')).not.toBeChecked();
	const native = await request.get('/my/audio', { headers: { authorization: `Bearer ${token}` } });
	const nativeItems = await native.json() as { items: { title: string }[] };
	expect(nativeItems.items.some(item => item.title === 'Shared ambience')).toBe(false);
	await page.getByLabel('Include shared files in my library').check();
	await page.getByLabel('Files', { exact: true }).selectOption('mine');
	await expect(page.getByRole('heading', { name: 'Shared ambience', exact: true })).toHaveCount(0);
	await page.getByRole('link', { name: 'Batch recording', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'Batch recording', exact: true })).toBeVisible();
	await expect.poll(() => page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.readyState)).toBeGreaterThanOrEqual(1);
	await page.getByRole('link', { name: 'Edit details', exact: true }).click();
	await page.getByLabel('Title', { exact: true }).fill('Field recording');
	await page.getByLabel('Slug', { exact: true }).fill('forest-rain');
	await page.getByLabel('Category', { exact: true }).selectOption('sfx');
	await page.getByLabel('Tags', { exact: true }).fill('forest, rain');
	await page.getByLabel('Description', { exact: true }).fill('Rain under the trees.\nRecorded outdoors.');
	await page.getByLabel('License', { exact: true }).selectOption('cc-by-sa');
	await page.getByLabel('Visibility', { exact: true }).selectOption('public');
	await page.getByLabel('Allow other listeners to download').check();
	await page.getByRole('button', { name: 'Save details', exact: true }).click();
	await expect(page).toHaveURL(/\/library-browser[^/]*\/audio\/forest-rain$/);
	await expect(page.getByRole('heading', { name: 'Field recording', exact: true })).toBeVisible();
	await expect(page.getByText('Rain under the trees.\nRecorded outdoors.', { exact: true })).toBeVisible();
	await expect(page.getByText('Creative Commons Attribution-ShareAlike 4.0', { exact: true })).toBeVisible();
	const sharePath = await page.getByRole('link', { name: 'Share link', exact: true }).getAttribute('href'); expect(sharePath).toBeTruthy();
	const anonContext = await browser.newContext(); const anon = await anonContext.newPage();
	try {
		await anon.goto(new URL(sharePath!, page.url()).href);
		await expect(anon.getByRole('heading', { name: 'Field recording', exact: true })).toBeVisible();
		await expect.poll(() => anon.locator('audio').evaluate((audio: HTMLAudioElement) => audio.readyState)).toBeGreaterThanOrEqual(1);
		await expect(anon.getByRole('link', { name: 'Edit details', exact: true })).toHaveCount(0);
		await expect(anon.getByRole('button', { name: 'Download original', exact: true })).toBeVisible();
	} finally { await anonContext.close(); }
	const listenerToken = await grant(request, true);
	await signedIn(page, listenerToken);
	await page.getByLabel('Files', { exact: true }).selectOption('shared');
	await expect(page.getByRole('link', { name: 'Field recording', exact: true })).toBeVisible();
	await menu(page, 'Manage files');
	const readOnly = page.getByRole('gridcell', { name: 'Title for Field recording', exact: true });
	await expect(readOnly).toHaveAttribute('aria-readonly', 'true');
	await readOnly.click(); await paste(page, 'Cannot overwrite');
	await expect(page.locator('#message')).toContainText('read-only');
	await expect(readOnly).toHaveText('Field recording');
	await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled();
	expect(errors).toEqual([]);
});

test('metadata table supports rectangular TSV, fill, undo and atomic errors without losing edits', async ({ page, request }) => {
	const token = await grant(request); const headers = { authorization: `Bearer ${token}` };
	const alpha = await createAudio(request, token, 'Sheet alpha');
	const beta = await createAudio(request, token, 'Sheet beta');
	await signedIn(page, token, '/manage');
	const alphaTitle = page.getByRole('gridcell', { name: 'Title for Sheet alpha', exact: true });
	const betaTitle = page.getByRole('gridcell', { name: 'Title for Sheet beta', exact: true });
	await expect(alphaTitle).toBeVisible();
	const first = Number(await betaTitle.getAttribute('data-row')); const second = Number(await alphaTitle.getAttribute('data-row')); expect(second).toBe(first + 1);
	await betaTitle.click();
	await paste(page, 'New beta\tnew-beta\tSFX\train, forest\t"Rain\nunder ""trees"""\tcc-by\tprivate\ttrue\r\nNew alpha\tnew-alpha\tsfx\twind\t"Wind\tand leaves"\tcc-0\tunlisted\tfalse');
	await expect(betaTitle).toHaveText('New beta');
	await expect(alphaTitle).toHaveText('New alpha');
	await expect(page.locator('#manage-changes')).toContainText('2 file(s) with unsaved changes');
	await page.getByRole('button', { name: 'Save changes', exact: true }).click();
	await expect(page.locator('#message')).toContainText('2 file(s) updated');
	const updatedBeta = await request.get(`/library/audio/${beta.id}`, { headers });
	expect(await updatedBeta.json()).toMatchObject({ title: 'New beta', slug: 'new-beta', category: 'sfx', tags: ['rain', 'forest'], description: 'Rain\nunder "trees"', license: 'cc-by', visibility: 'private', is_downloadable: true });
	const updatedAlpha = await request.get(`/library/audio/${alpha.id}`, { headers });
	expect(await updatedAlpha.json()).toMatchObject({ title: 'New alpha', description: 'Wind\tand leaves', visibility: 'unlisted' });
	const firstDescription = page.locator(`[role=gridcell][data-row="${first}"][data-key=description]`);
	const secondDescription = page.locator(`[role=gridcell][data-row="${second}"][data-key=description]`);
	await firstDescription.click(); await secondDescription.click({ modifiers: ['Shift'] });
	await expect(firstDescription).toHaveAttribute('aria-selected', 'true'); await expect(secondDescription).toHaveAttribute('aria-selected', 'true');
	await page.keyboard.press('Control+d'); await expect(secondDescription).toHaveText('Rain\nunder "trees"');
	await page.keyboard.press('Control+z'); await expect(secondDescription).toHaveText('Wind\tand leaves');
	await paste(page, 'Same description');
	await expect(firstDescription).toHaveText('Same description'); await expect(secondDescription).toHaveText('Same description');
	// A conflicting slug rejects the entire batch and preserves both local drafts.
	const firstSlug = page.locator(`[role=gridcell][data-row="${first}"][data-key=slug]`);
	const secondSlug = page.locator(`[role=gridcell][data-row="${second}"][data-key=slug]`);
	await firstSlug.click(); await paste(page, 'same-slug'); await secondSlug.click(); await paste(page, 'same-slug');
	await page.getByRole('button', { name: 'Save changes', exact: true }).click();
	await expect(page.locator('#message')).toContainText('slug');
	await expect(page.locator('#manage-changes')).toContainText('2 file(s) with unsaved changes');
	const unchanged = await request.get(`/library/audio/${beta.id}`, { headers });
	expect(await unchanged.json()).toMatchObject({ slug: 'new-beta', description: 'Rain\nunder "trees"' });
	await secondSlug.click(); await paste(page, 'unique-alpha');
	await page.getByRole('button', { name: 'Save changes', exact: true }).click();
	await expect(page.locator('#message')).toContainText('2 file(s) updated');
	await expect(page.locator('#manage-changes')).toContainText('All changes saved');
	// Edits survive moving away from the table and returning.
	await firstDescription.click(); await page.keyboard.press('F2');
	await page.locator('[role=gridcell] textarea').fill('Keep this draft'); await page.keyboard.press('Enter');
	await page.getByRole('link', { name: 'Back to library', exact: true }).click();
	await menu(page, 'Manage files');
	await expect(page.locator(`[role=gridcell][data-row="${first}"][data-key=description]`)).toHaveText('Keep this draft');
	await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
	await expect(page.locator(`[role=gridcell][data-row="${first}"][data-key=description]`)).toHaveText('Same description');
});

test('opening a missing recording keeps the authenticated session', async ({ page, request }) => {
	const token = await grant(request);
	await signedIn(page, token, '/audio/missing-recording/play');
	await expect(page.locator('#message')).toContainText('not found');
	expect(await page.evaluate(() => sessionStorage.getItem('audiocity.access-token'))).toBe(token);
	await expect(page.locator('#session')).toContainText('Signed in as');
	await menu(page, 'Library');
	await expect(page.getByRole('heading', { name: 'Library', exact: true })).toBeVisible();
});

test('a delayed library response cannot replace the upload page after navigation', async ({ page, request }) => {
	const token = await grant(request);
	let release!: () => void;
	let arrived!: () => void;
	const blocked = new Promise<void>(resolve => { release = resolve; });
	const started = new Promise<void>(resolve => { arrived = resolve; });
	await page.route('**/library/audio?*', async route => {
		const response = await route.fetch();
		arrived(); await blocked; await route.fulfill({ response });
	});
	try {
		await signedIn(page, token);
		await started;
		await page.getByRole('button', { name: '+ Upload', exact: true }).click();
		await expect(page.getByRole('heading', { name: 'Upload files', exact: true })).toBeVisible();
		const finished = page.waitForResponse(response => new URL(response.url()).pathname === '/library/audio');
		release(); await (await finished).finished();
		// Wait for the browser to consume the released response and render its continuation.
		await page.evaluate(() => new Promise<void>(resolve => { requestAnimationFrame(() => { requestAnimationFrame(() => { resolve(); }); }); }));
		await expect(page).toHaveURL(/\/upload$/);
		await expect(page.getByRole('heading', { name: 'Upload files', exact: true })).toBeVisible();
		await expect(page.getByLabel('Audio or project files', { exact: true })).toBeVisible();
	} finally { release(); }
});

test('upload options recover after a temporary server error', async ({ page, request }) => {
	const token = await grant(request);
	await signedIn(page, token);
	await expect(page.getByRole('heading', { name: 'Library', exact: true })).toBeVisible();
	await page.route('**/library/options', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'Options temporarily unavailable.' }) }), { times: 1 });
	await page.getByRole('button', { name: '+ Upload', exact: true }).click();
	await expect(page.locator('#message')).toContainText('Options temporarily unavailable.');
	await page.getByRole('button', { name: '+ Upload', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'Upload files', exact: true })).toBeVisible();
	await expect(page.getByLabel('Audio category', { exact: true })).toHaveValue('recording');
});
