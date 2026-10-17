import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../src/app.ts';
import type { UploadDescriptor } from '../src/core.ts';
import { fixture, upload } from './helpers.ts';

interface Audio { id: string; title: string; category: string; license: string; can_edit: boolean }
interface Policy extends UploadDescriptor { audio: Audio }
const bytes = Buffer.from('fLaCpublic metadata regression');

await test('public audio categories and an unselected license round-trip across create, view, list, search and update', async t => {
	const f = await fixture(); t.after(() => f.cleanup());
	const headers = { authorization: `Bearer ${f.token}` };
	for (const category of ['voice-over', 'sound-design']) {
		const response = await f.app.inject({ method: 'POST', url: '/v1/audio/create', headers,
			payload: { name: `${category}.flac`, mime: 'audio/flac', size: bytes.length, category, license: 'none', is_listed: true } });
		assert.equal(response.statusCode, 201, response.body);
		const policy = response.json<Policy>();
		assert.equal(policy.audio.category, category);
		assert.equal(policy.audio.license, 'none');
		await upload(f.app, policy, bytes);
		const view = (await f.app.inject({ url: `/v1/audio/view?id=${policy.audio.id}`, headers })).json<Audio>();
		assert.equal(view.category, category);
		assert.equal(view.license, 'none');
		const listed = (await f.app.inject({ url: '/v1/audio/list', headers })).json<Audio[]>().find(item => item.id === view.id)!;
		assert.equal(listed.category, category);
		assert.equal(listed.license, 'none');
		const search = (await f.app.inject({ url: '/v1/search?types=audio', headers })).json<{ model: Audio }[]>().find(item => item.model.id === view.id)!;
		assert.equal(search.model.category, category);
		assert.equal(search.model.license, 'none');
		const changed = await f.app.inject({ method: 'PATCH', url: `/v1/audio/update?id=${view.id}`, headers,
			payload: { category, license: 'none', description: 'Preserve public API values.' } });
		assert.equal(changed.statusCode, 200, changed.body);
		assert.equal(changed.json<Audio>().category, category);
		assert.equal(changed.json<Audio>().license, 'none');
		assert.equal(changed.json<Audio>().can_edit, true);
	}
});

await test('public uploads default to no selected license and preserve it through restart', async t => {
	const f = await fixture(); let closeRestarted = async () => {};
	t.after(async () => { await closeRestarted(); await f.cleanup(); });
	const headers = { authorization: `Bearer ${f.token}` };
	const response = await f.app.inject({ method: 'POST', url: '/v1/audio/create', headers,
		payload: { name: 'Default.flac', mime: 'audio/flac', size: bytes.length, category: 'recording' } });
	assert.equal(response.statusCode, 201, response.body);
	const policy = response.json<Policy>();
	assert.equal(policy.audio.license, 'none');
	await upload(f.app, policy, bytes);
	await f.app.close();
	const restarted = await createApp(f.ctx.config); closeRestarted = () => restarted.app.close();
	const view = await restarted.app.inject({ url: `/v1/audio/view?id=${policy.audio.id}`, headers });
	assert.equal(view.statusCode, 200, view.body);
	assert.equal(view.json<Audio>().license, 'none');
});

await test('custom library categories stay available locally and serialize as other in public API responses', async t => {
	const f = await fixture(); t.after(() => f.cleanup());
	const headers = { authorization: `Bearer ${f.token}` };
	const category = 'custom-field-recordings';
	const created = await f.app.inject({ method: 'POST', url: '/admin/categories', headers, payload: { id: category, name: 'Field recordings' } });
	assert.equal(created.statusCode, 201);
	const response = await f.app.inject({ method: 'POST', url: '/v1/audio/create', headers,
		payload: { name: 'Custom.flac', mime: 'audio/flac', size: bytes.length, category } });
	assert.equal(response.statusCode, 201, response.body);
	const policy = response.json<Policy>();
	assert.equal(policy.audio.category, 'other');
	const local = await f.app.inject({ url: `/library/audio/${policy.audio.id}`, headers });
	assert.equal(local.json<Audio>().category, category);
	const publicView = await f.app.inject({ url: `/v1/audio/view?id=${policy.audio.id}`, headers });
	assert.equal(publicView.json<Audio>().category, 'other');
});
