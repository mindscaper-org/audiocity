import { expect, test } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';

async function grant(request: APIRequestContext): Promise<string> {
	const response = await request.post('/auth/token', { data: { grant_type: 'password', username: 'library-browser@example.test', password: 'library-browser-password', scope: 'all' } });
	expect(response.status()).toBe(200);
	return (await response.json() as { access_token: string }).access_token;
}

async function signedIn(page: Page, token: string, path: string): Promise<void> {
	await page.goto('/');
	await page.evaluate(value => { sessionStorage.setItem('audiocity.access-token', value); }, token);
	await page.goto(path);
}

async function settle(page: Page): Promise<void> {
	await page.evaluate(() => new Promise<void>(resolve => { requestAnimationFrame(() => { requestAnimationFrame(() => { resolve(); }); }); }));
}

test('loading more metadata rows cannot replace a page opened during the request', async ({ page, request }) => {
	const token = await grant(request);
	const headers = { authorization: `Bearer ${token}` };
	const ids: string[] = [];
	let release!: () => void;
	let arrived!: () => void;
	const blocked = new Promise<void>(resolve => { release = resolve; });
	const started = new Promise<void>(resolve => { arrived = resolve; });
	try {
		for (let index = 0; index < 50; index++) {
			const response = await request.post('/audio', { headers, data: { name: `Navigation ${index}.wav`, size: 48, mime: 'audio/wav', visibility: 'private' } });
			expect(response.status()).toBe(201);
			ids.push((await response.json() as { audio: { id: string } }).audio.id);
		}
		await page.route('**/library/audio?*', async route => {
			const response = await route.fetch();
			if (new URL(route.request().url()).searchParams.get('page') === '2') { arrived(); await blocked; }
			await route.fulfill({ response });
		});
		await signedIn(page, token, '/manage');
		await page.getByRole('button', { name: 'Load more files', exact: true }).click();
		await started;
		await page.getByRole('button', { name: '+ Upload', exact: true }).click();
		await expect(page.getByRole('heading', { name: 'Upload files', exact: true })).toBeVisible();
		const finished = page.waitForResponse(response => new URL(response.url()).pathname === '/library/audio' && new URL(response.url()).searchParams.get('page') === '2');
		release(); await (await finished).finished(); await settle(page);
		await expect(page).toHaveURL(/\/upload$/);
		await expect(page.getByRole('heading', { name: 'Upload files', exact: true })).toBeVisible();
		await expect(page.getByLabel('Audio or project files', { exact: true })).toBeVisible();
	} finally {
		release();
		for (const id of ids) await request.post(`/v1/audio/delete?id=${id}`, { headers });
	}
});

test('a delayed slug edit failure cannot replace a page opened during the request', async ({ page, request }) => {
	const token = await grant(request);
	const fallbackRequests: string[] = [];
	page.on('request', request => { if (new URL(request.url()).pathname === '/library/audio') fallbackRequests.push(request.url()); });
	let release!: () => void;
	let arrived!: () => void;
	const blocked = new Promise<void>(resolve => { release = resolve; });
	const started = new Promise<void>(resolve => { arrived = resolve; });
	await page.route('**/library/audio/resolve?*', async route => {
		const response = await route.fetch();
		arrived(); await blocked; await route.fulfill({ response });
	});
	try {
		await signedIn(page, token, '/library-browser/audio/missing-recording/edit');
		await started;
		await page.getByRole('button', { name: '+ Upload', exact: true }).click();
		await expect(page.getByRole('heading', { name: 'Upload files', exact: true })).toBeVisible();
		const finished = page.waitForResponse(response => new URL(response.url()).pathname === '/library/audio/resolve');
		release(); await (await finished).finished(); await settle(page);
		expect(fallbackRequests).toEqual([]);
		await expect(page).toHaveURL(/\/upload$/);
		await expect(page.getByRole('heading', { name: 'Upload files', exact: true })).toBeVisible();
		await expect(page.locator('#message')).toBeHidden();
	} finally { release(); }
});
