import { expect, test } from '@playwright/test';

test('editing and bulk management preserve an unselected public API license', async ({ page, request }) => {
	const grant = await request.post('/auth/token', { data: { grant_type: 'password', username: 'library-browser@example.test', password: 'library-browser-password', scope: 'all' } });
	expect(grant.status()).toBe(200);
	const { access_token: token } = await grant.json() as { access_token: string };
	const headers = { authorization: `Bearer ${token}` };
	const wav = Buffer.alloc(48);
	wav.write('RIFF'); wav.writeUInt32LE(40, 4); wav.write('WAVEfmt ', 8);
	wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
	wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
	wav.write('data', 36); wav.writeUInt32LE(4, 40);
	const created = await request.post('/v1/audio/create', { headers, data: { name: 'License round trip.wav', title: 'License round trip', mime: 'audio/wav', size: wav.length, category: 'voice-over', license: 'none' } });
	expect(created.status()).toBe(201);
	const policy = await created.json() as { url: string; success: string; audio: { id: string; category: string; license: string } };
	expect(policy.audio).toMatchObject({ category: 'voice-over', license: 'none' });
	expect((await request.put(policy.url, { data: wav, headers: { 'content-type': 'application/octet-stream' } })).status()).toBe(200);
	expect((await request.post(policy.success)).status()).toBe(200);
	try {
		await page.goto('/');
		await page.evaluate(value => { sessionStorage.setItem('audiocity.access-token', value); }, token);
		await page.goto(`/audio/${policy.audio.id}/edit`);
		await expect(page.getByLabel('License', { exact: true })).toHaveValue('none');
		await page.getByLabel('Title', { exact: true }).fill('License preserved');
		await page.getByRole('button', { name: 'Save details', exact: true }).click();
		await expect(page.getByRole('heading', { name: 'License preserved', exact: true })).toBeVisible();
		await expect(page.getByText('No license selected', { exact: true })).toBeVisible();
		await page.locator('#menu > summary').click();
		await page.locator('#menu').getByRole('button', { name: 'Manage files', exact: true }).click();
		await expect(page.getByRole('gridcell', { name: 'License for License preserved', exact: true })).toHaveText('none');
		const description = page.getByRole('gridcell', { name: 'Description for License preserved', exact: true });
		await description.click(); await page.keyboard.press('F2');
		await description.locator('textarea').fill('Changed independently of license.');
		await page.keyboard.press('Enter');
		await page.getByRole('button', { name: 'Save changes', exact: true }).click();
		await expect(page.locator('#message')).toContainText('1 file(s) updated');
		const viewed = await request.get(`/v1/audio/view?id=${policy.audio.id}`, { headers });
		expect(await viewed.json()).toMatchObject({ title: 'License preserved', category: 'voice-over', license: 'none', description: 'Changed independently of license.' });
	} finally { await request.post(`/v1/audio/delete?id=${policy.audio.id}`, { headers }); }
});
