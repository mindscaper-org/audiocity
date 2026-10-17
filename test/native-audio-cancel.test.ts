import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { test } from 'node:test';
import { createApp } from '../src/app.ts';
import type { UploadDescriptor } from '../src/core.ts';
import { createUser, fixture, relative, upload } from './helpers.ts';

interface Policy extends UploadDescriptor { audio: { id: string; play: { url: string } }; extra: { audio: { id: string }; token: string } }
const bytes = Buffer.from('fLaCfixture');
const auth = (token: string) => ({ authorization: `Bearer ${token}` });
async function create(f: Awaited<ReturnType<typeof fixture>>, token = f.token, size = bytes.length): Promise<Policy> {
	const response = await f.app.inject({ method: 'POST', url: '/audio', headers: auth(token), payload: { name: 'Cancelled.flac', mime: 'audio/flac', size, public: false, method: 'PUT' } });
	assert.equal(response.statusCode, 201, response.body);
	const policy = response.json<Policy>();
	assert.equal(typeof policy.extra.token, 'string');
	assert.ok(policy.extra.token);
	assert.equal(policy.extra.audio.id, policy.audio.id);
	return policy;
}
const discard = (policy: Policy, token = policy.extra.token) => `/audio/${policy.audio.id}?token=${encodeURIComponent(token)}`;

void test('Audacity discard cancels pending audio without OAuth and immediately releases its quota', async t => {
	const f = await fixture({ maxUserBytes: 100 }); t.after(() => f.cleanup());
	const policy = await create(f, f.token, 60);
	assert.equal((await f.app.inject({ method: 'DELETE', url: discard(policy) })).statusCode, 204);
	assert.equal((await f.app.inject({ url: `/v1/audio/view?id=${policy.audio.id}`, headers: auth(f.token) })).statusCode, 404);
	assert.deepEqual((await f.app.inject({ url: '/my/audio', headers: auth(f.token) })).json<{ items: unknown[] }>().items, []);
	assert.equal((await f.app.inject({ method: 'POST', url: relative(policy.success) })).statusCode, 409);
	await create(f, f.token, 60);
});

void test('Audacity discard removes uploaded and ready originals and revokes issued media URLs', async t => {
	const f = await fixture(); t.after(() => f.cleanup());
	for (const ready of [false, true]) {
		const policy = await create(f);
		assert.equal((await f.app.inject({ method: 'PUT', url: relative(policy.url), headers: { 'content-type': 'audio/flac' }, payload: bytes })).statusCode, 200);
		if (ready) assert.equal((await f.app.inject({ method: 'POST', url: relative(policy.success) })).statusCode, 200);
		const blobPath = f.ctx.blobs.get(policy.id)!.path;
		const media = ready ? (await f.app.inject(`/public/audio/${policy.audio.id}`)).json<Policy['audio']>().play.url : '';
		assert.equal((await f.app.inject({ method: 'DELETE', url: discard(policy) })).statusCode, 204);
		await assert.rejects(stat(blobPath), { code: 'ENOENT' });
		assert.equal((await f.app.inject({ method: 'POST', url: relative(policy.success) })).statusCode, 409);
		assert.equal((await f.app.inject({ method: 'PUT', url: relative(policy.url), headers: { 'content-type': 'audio/flac' }, payload: bytes })).statusCode, 409);
		assert.equal((await f.app.inject(`/public/audio/${policy.audio.id}`)).statusCode, 404);
		if (media) assert.equal((await f.app.inject(relative(media))).statusCode, 404);
	}
});

void test('discard capabilities are scoped to their audio and reject missing, wrong and expired tokens', async t => {
	const f = await fixture(); t.after(() => f.cleanup());
	const other = await createUser(f.app, f.token);
	const first = await create(f); const second = await create(f, other.token);
	for (const url of [`/audio/${first.audio.id}`, discard(first, 'wrong'), discard(second, first.extra.token), `${discard(first)}&token=duplicate`]) {
		assert.equal((await f.app.inject({ method: 'DELETE', url })).statusCode, 403, url);
	}
	assert.equal((await f.app.inject({ url: `/v1/audio/view?id=${second.audio.id}`, headers: auth(other.token) })).statusCode, 200);
	f.ctx.db.run('UPDATE blobs SET expires=1 WHERE id=?', first.id);
	assert.equal((await f.app.inject({ method: 'DELETE', url: discard(first) })).statusCode, 403);
	assert.equal((await f.app.inject({ url: `/v1/audio/view?id=${first.audio.id}`, headers: auth(f.token) })).statusCode, 200);
});

void test('discarding an in-flight audio upload prevents publication and frees quota before it finishes', async t => {
	const f = await fixture({ maxUserBytes: 20 }); t.after(() => f.cleanup());
	const policy = await create(f);
	const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
	f.ctx.blobs.setValidator('audio', async () => { entered.resolve(); await release.promise; });
	const uploading = f.app.inject({ method: 'PUT', url: relative(policy.url), headers: { 'content-type': 'audio/flac' }, payload: bytes }).then(response => response);
	await entered.promise;
	try {
		assert.equal((await f.app.inject({ method: 'DELETE', url: discard(policy) })).statusCode, 204);
		await create(f);
	} finally { release.resolve(); }
	assert.equal((await uploading).statusCode, 409);
	assert.equal((await f.app.inject({ method: 'POST', url: relative(policy.success) })).statusCode, 409);
	await assert.rejects(stat(f.ctx.blobs.get(policy.id)!.path), { code: 'ENOENT' });
});

void test('native discard capabilities survive a server restart', async t => {
	const f = await fixture();
	let closeRestarted = async () => {};
	t.after(async () => { await closeRestarted(); await f.cleanup(); });
	const pending = await create(f); const ready = await create(f);
	await upload(f.app, ready, bytes, 'audio/flac');
	await f.app.close();
	const restarted = await createApp(f.ctx.config); closeRestarted = () => restarted.app.close();
	for (const policy of [pending, ready]) {
		assert.equal((await restarted.app.inject({ method: 'DELETE', url: discard(policy) })).statusCode, 204);
		assert.equal((await restarted.app.inject({ url: `/v1/audio/view?id=${policy.audio.id}`, headers: auth(f.token) })).statusCode, 404);
	}
});
