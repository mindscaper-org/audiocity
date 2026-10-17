import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { UploadDescriptor } from '../src/core.ts';
import { createUser, fixture, upload } from './helpers.ts';

interface Audio { id: string; username: string; slug: string; origin: string }
interface Policy extends UploadDescriptor { audio: Audio }
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

void test('public and native audio libraries stay owner-only while explicit library sharing and public search remain available', async t => {
	const directory = await mkdtemp(join(tmpdir(), 'audiocity-owned-audio-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const bytes = Buffer.from('fLaCfixture');
	await writeFile(join(directory, 'Folder recording.flac'), bytes);
	const f = await fixture({ sharedDir: directory }); t.after(() => f.cleanup());
	const other = await createUser(f.app, f.token);
	async function create(token: string, fields: Record<string, unknown>, ready = true): Promise<Audio> {
		const response = await f.app.inject({ method: 'POST', url: '/audio', headers: auth(token), payload: { name: 'Recording.flac', mime: 'audio/flac', size: bytes.length, ...fields } });
		assert.equal(response.statusCode, 201, response.body);
		const policy = response.json<Policy>();
		if (ready) await upload(f.app, policy, bytes, 'audio/flac');
		return policy.audio;
	}
	const own = await create(f.token, { slug: 'collision', visibility: 'private' }, false);
	const ownListed = await create(f.token, { slug: 'own-listed', visibility: 'public' });
	const theirs = await create(other.token, { slug: 'collision', visibility: 'public', is_downloadable: true });
	await create(other.token, { visibility: 'private' });
	await create(other.token, { visibility: 'public' }, false);
	const publicLogin = await f.app.inject({ method: 'POST', url: '/auth/token', payload: {
		grant_type: 'password', username: f.ctx.config.adminEmail, password: f.ctx.config.adminPassword, scope: 'public',
	} });
	assert.equal(publicLogin.statusCode, 200, publicLogin.body);
	const publicHeaders = auth(publicLogin.json<{ access_token: string }>().access_token);
	const browser = (await f.app.inject({ url: '/library/audio?source=all', headers: auth(f.token) })).json<{ items: Audio[] }>();
	const folder = browser.items.find(item => item.origin === 'shared-folder')!;
	assert.ok(folder);
	assert.deepEqual(browser.items.map(item => item.id).sort(), [own.id, ownListed.id, theirs.id, folder.id].sort());
	for (const include of [true, false]) {
		assert.equal((await f.app.inject({ method: 'PATCH', url: '/library/preferences', headers: auth(f.token), payload: { include_shared: include } })).statusCode, 200);
		const native = await f.app.inject({ url: '/my/audio?source=all', headers: auth(f.token) });
		assert.equal(native.statusCode, 200, native.body);
		const nativeList = native.json<{ items: Audio[]; pagination: { total: number } }>();
		assert.deepEqual(nativeList.items.map(item => item.id).sort(), [own.id, ownListed.id].sort());
		assert.equal(nativeList.pagination.total, 2);
		assert.ok(nativeList.items.every(item => item.username === f.user.username));
		const publicList = await f.app.inject({ url: '/v1/audio/list?source=shared', headers: publicHeaders });
		assert.equal(publicList.statusCode, 200, publicList.body);
		assert.deepEqual(publicList.json<Audio[]>().map(item => item.id).sort(), [own.id, ownListed.id].sort());
		for (const id of [theirs.id, folder.id]) assert.equal((await f.app.inject({ url: `/v1/audio/view?id=${id}`, headers: publicHeaders })).statusCode, 404);
		assert.equal((await f.app.inject({ url: `/v1/audio/view?id=slug:${own.slug}`, headers: publicHeaders })).json<Audio>().id, own.id);
		const search = await f.app.inject({ url: '/v1/search?types=audio', headers: publicHeaders });
		assert.equal(search.statusCode, 200, search.body);
		assert.deepEqual(search.json<{ model: Audio }[]>().map(item => item.model.id).sort(), [ownListed.id, theirs.id].sort());
		assert.equal((await f.app.inject({ url: `/library/audio/${theirs.id}`, headers: auth(f.token) })).statusCode, 200);
		assert.equal((await f.app.inject({ url: `/library/audio/${folder.id}`, headers: auth(f.token) })).statusCode, 200);
	}
});
