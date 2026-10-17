import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { initializeAudioSchema } from '../src/audio-metadata.ts';
import type { UploadDescriptor } from '../src/core.ts';
import { createUser, fixture, relative, upload } from './helpers.ts';

interface Audio {
	id: string; title: string; slug: string; category: string; tags: string[]; license: string;
	visibility: string; origin: string; can_edit: boolean; play: { url: string }; source: { size: number; mime: string };
}
interface Policy extends UploadDescriptor { audio: Audio }
interface List { items: Audio[]; pagination: { total: number } }
const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const bytes = Buffer.from('fLaCfixture');

async function audio(f: Awaited<ReturnType<typeof fixture>>, token: string, fields: Record<string, unknown> = {}, ready = true): Promise<Audio> {
	const response = await f.app.inject({ method: 'POST', url: '/audio', headers: auth(token), payload: { mime: 'audio/flac', size: bytes.length, name: 'Rain.flac', ...fields } });
	assert.equal(response.statusCode, 201, response.body);
	const policy = response.json<Policy>();
	if (ready) await upload(f.app, policy, bytes, 'audio/flac');
	return policy.audio;
}

void test('shared library includes ready public uploads, preserves private boundaries, and remembers native inclusion per account', async () => {
	const f = await fixture();
	try {
		const other = await createUser(f.app, f.token);
		const mine = await audio(f, f.token, { title: 'Mine', visibility: 'private' });
		const published = await audio(f, other.token, { title: 'Shared rain', visibility: 'public', is_downloadable: true });
		await audio(f, other.token, { title: 'Unlisted', visibility: 'unlisted' });
		await audio(f, other.token, { title: 'Private', visibility: 'private' });
		await audio(f, other.token, { title: 'Pending', visibility: 'public' }, false);
		const list = (await f.app.inject({ url: '/library/audio', headers: auth(f.token) })).json<List>();
		assert.deepEqual(list.items.map(row => row.id).sort(), [mine.id, published.id].sort());
		assert.equal(list.items.find(row => row.id === mine.id)?.can_edit, true);
		assert.equal(list.items.find(row => row.id === published.id)?.can_edit, false);
		assert.equal((await f.app.inject({ url: `/v1/audio/view?id=${published.id}`, headers: auth(f.token) })).statusCode, 200);
		const set = await f.app.inject({ method: 'PATCH', url: '/library/preferences', headers: auth(f.token), payload: { include_shared: false } });
		assert.deepEqual(set.json(), { include_shared: false });
		for (const url of ['/library/audio', '/my/audio', '/v1/audio/list']) {
			const result = (await f.app.inject({ url, headers: auth(f.token) })).json<List | Audio[]>();
			assert.deepEqual((Array.isArray(result) ? result : result.items).map(row => row.id), [mine.id]);
		}
		assert.equal((await f.app.inject({ url: '/v1/search?query=rain', headers: auth(f.token) })).json<Audio[]>().length, 0);
		assert.deepEqual((await f.app.inject({ url: '/library/audio?source=shared', headers: auth(f.token) })).json<List>().items.map(row => row.id), [published.id]);
		assert.deepEqual((await f.app.inject({ url: '/library/preferences', headers: auth(other.token) })).json(), { include_shared: true });
		assert.equal((await f.app.inject({ method: 'PATCH', url: '/library/preferences', headers: auth(f.token), payload: { include_shared: 'false' } })).statusCode, 422);
		assert.equal((await f.app.inject('/library/audio')).statusCode, 401);
	} finally { await f.cleanup(); }
});

void test('metadata options include default categories and all CC licenses; only administrators control categories', async () => {
	const f = await fixture();
	try {
		const other = await createUser(f.app, f.token);
		const options = (await f.app.inject('/library/options')).json<{ categories: { id: string }[]; licenses: { id: string }[] }>();
		assert.deepEqual(options.categories.map(row => row.id), ['music', 'podcast', 'voiceover', 'sfx', 'cover', 'beats', 'audiobook', 'recording', 'other']);
		assert.equal(options.licenses.length, 9);
		assert.equal((await f.app.inject({ method: 'POST', url: '/admin/categories', headers: auth(other.token), payload: { id: 'nature', name: 'Nature' } })).statusCode, 403);
		assert.equal((await f.app.inject({ method: 'POST', url: '/admin/categories', headers: auth(f.token), payload: { id: 'nature', name: 'Nature' } })).statusCode, 201);
		const item = await audio(f, f.token, { category: 'nature', license: 'none' });
		assert.equal(item.license, 'none');
		assert.equal((await f.app.inject({ method: 'DELETE', url: '/admin/categories/nature', headers: auth(f.token) })).statusCode, 409);
		assert.equal((await f.app.inject({ method: 'DELETE', url: '/admin/categories/other', headers: auth(f.token) })).statusCode, 409);
		assert.equal((await f.app.inject({ method: 'DELETE', url: '/admin/categories/beats', headers: auth(f.token) })).statusCode, 204);
		initializeAudioSchema(f.ctx.db);
		assert.equal(f.ctx.db.get('SELECT id FROM audio_categories WHERE id=?', 'beats'), undefined);
		assert.equal((await audio(f, f.token, { category: 'voice-over' })).category, 'voiceover');
		assert.equal((await audio(f, f.token, { category: 'sound-design' })).category, 'sfx');
	} finally { await f.cleanup(); }
});

void test('public audio uploads accept administrator-defined category IDs up to the supported limit', async () => {
	const f = await fixture();
	try {
		const category = `field-${'recording'.repeat(6)}-sfx`;
		assert.equal(category.length, 64);
		const created = await f.app.inject({ method: 'POST', url: '/admin/categories', headers: auth(f.token), payload: { id: category, name: 'Field recordings' } });
		assert.equal(created.statusCode, 201, created.body);
		const response = await f.app.inject({ method: 'POST', url: '/v1/audio/create', headers: auth(f.token), payload: {
			mime: 'audio/flac', size: bytes.length, name: 'Rain.flac', category,
		} });
		assert.equal(response.statusCode, 201, response.body);
		const policy = response.json<Policy>();
		await upload(f.app, policy, bytes, 'audio/flac');
		const item = (await f.app.inject({ url: `/library/audio/${policy.audio.id}`, headers: auth(f.token) })).json<Audio>();
		assert.equal(item.category, category);
	} finally { await f.cleanup(); }
});

void test('batch metadata edits validate every row, enforce ownership, and allow atomic slug swaps', async () => {
	const f = await fixture();
	try {
		const other = await createUser(f.app, f.token);
		const first = await audio(f, f.token, { title: 'First', slug: 'first' });
		const second = await audio(f, f.token, { title: 'Second', slug: 'second' });
		const theirs = await audio(f, other.token, { slug: 'theirs' });
		const batch = (items: Record<string, unknown>[]) => f.app.inject({ method: 'PATCH', url: '/library/audio/batch', headers: auth(f.token), payload: { items } });
		assert.equal((await batch([{ id: first.id, title: 'Do not change' }, { id: second.id, category: 'missing' }])).statusCode, 422);
		assert.equal((await batch([{ id: first.id, title: 'Do not change' }, { id: theirs.id, title: 'stolen' }])).statusCode, 404);
		assert.equal((await batch([{ id: first.id, slug: 'duplicate' }, { id: second.id, slug: 'duplicate' }])).statusCode, 409);
		assert.equal((await f.app.inject({ url: `/library/audio/${first.id}`, headers: auth(f.token) })).json<Audio>().title, 'First');
		const swapped = await batch([{ id: first.id, slug: 'second', tags: ['rain', 'rain'], license: 'cc-by-sa' }, { id: second.id, slug: 'first', description: 'Edited together' }]);
		assert.equal(swapped.statusCode, 200, swapped.body);
		assert.deepEqual(swapped.json<List>().items.map(row => row.slug), ['second', 'first']);
		assert.deepEqual(swapped.json<List>().items[0]?.tags, ['rain']);
		assert.equal((await batch([{ id: first.id, title: 'a' }, { id: first.id, title: 'b' }])).statusCode, 422);
		for (const fields of [{ slug: '../escape' }, { tags: [1] }, { description: 'x'.repeat(501) }, { license: 'pirate' }, { visibility: 'everyone' }]) {
			assert.equal((await f.app.inject({ method: 'PATCH', url: `/library/audio/${first.id}`, headers: auth(f.token), payload: fields })).statusCode, 422);
		}
	} finally { await f.cleanup(); }
});

void test('playback metadata resolves user-scoped slugs and keeps private uploads owner-only', async () => {
	const f = await fixture();
	try {
		const other = await createUser(f.app, f.token);
		const item = await audio(f, f.token, { visibility: 'unlisted', slug: 'listen' });
		const resolve = `/library/audio/resolve?username=${f.user.username}&slug=listen`;
		assert.equal((await f.app.inject(resolve)).json<Audio>().id, item.id);
		assert.equal((await f.app.inject(`/library/audio/${item.id}`)).statusCode, 200);
		await f.app.inject({ method: 'PATCH', url: `/library/audio/${item.id}`, headers: auth(f.token), payload: { visibility: 'private' } });
		assert.equal((await f.app.inject(resolve)).statusCode, 404);
		assert.equal((await f.app.inject({ url: resolve, headers: auth(other.token) })).statusCode, 404);
		assert.equal((await f.app.inject({ url: resolve, headers: auth(f.token) })).json<Audio>().can_edit, true);
	} finally { await f.cleanup(); }
});

void test('existing shared directory is indexed without copying originals; signed ranges and admin metadata survive rescans', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'audiocity-shared-'));
	const outside = await mkdtemp(join(tmpdir(), 'audiocity-outside-'));
	await mkdir(join(directory, 'nested'));
	await writeFile(join(directory, 'nested', 'Rain.flac'), bytes);
	await writeFile(join(outside, 'secret.flac'), bytes);
	await symlink(join(outside, 'secret.flac'), join(directory, 'leak.flac'));
	await symlink(outside, join(directory, 'linked'));
	const f = await fixture({ sharedDir: directory });
	try {
		const other = await createUser(f.app, f.token);
		const list = (await f.app.inject({ url: '/library/audio?source=shared', headers: auth(other.token) })).json<List>();
		assert.equal(list.items.length, 1);
		const item = list.items[0]!;
		assert.equal(item.origin, 'shared-folder'); assert.equal(item.can_edit, false);
		assert.equal(item.source.mime, 'audio/flac');
		assert.equal((await f.app.inject(`/library/audio/${item.id}`)).statusCode, 404);
		assert.equal((await f.app.inject(`/public/audio/${item.id}`)).statusCode, 404);
		assert.equal((await f.app.inject(relative(item.play.url))).statusCode, 200);
		const range = await f.app.inject({ url: relative(item.play.url), headers: { range: 'bytes=0-3' } });
		assert.equal(range.statusCode, 206); assert.equal(range.body, 'fLaC');
		assert.equal((await f.app.inject({ url: relative(item.play.url), headers: { range: 'bytes=1000-' } })).statusCode, 416);
		assert.equal((await f.app.inject({ method: 'PATCH', url: `/library/audio/${item.id}`, headers: auth(other.token), payload: { title: 'stolen' } })).statusCode, 404);
		assert.equal((await f.app.inject({ method: 'PATCH', url: `/library/audio/${item.id}`, headers: auth(f.token), payload: { title: 'Forest rain', category: 'sfx', slug: 'forest-rain' } })).statusCode, 200);
		const changes = f.ctx.db.get<{ count: number }>('SELECT total_changes() count')?.count;
		await f.app.inject({ method: 'POST', url: '/admin/shared/rescan', headers: auth(f.token) });
		assert.equal(f.ctx.db.get<{ count: number }>('SELECT total_changes() count')?.count, changes, 'unchanged directory scans must avoid rewriting every indexed row');
		const edited = (await f.app.inject({ url: `/library/audio/${item.id}`, headers: auth(f.token) })).json<Audio>();
		assert.equal(edited.title, 'Forest rain'); assert.equal(edited.slug, 'forest-rain'); assert.equal(edited.can_edit, true);
		assert.deepEqual(await readFile(join(directory, 'nested', 'Rain.flac')), bytes);
		assert.equal(f.ctx.db.get<{ count: number }>('SELECT count(*) count FROM blobs')?.count, 0);
		assert.equal((await f.app.inject({ url: '/v1/search?query=forest', headers: auth(other.token) })).json<{ model: Audio }[]>()[0]?.model.id, item.id);
		await writeFile(join(directory, 'nested', 'Rain.flac'), Buffer.from('fLaCreplaced-more-bytes'));
		await f.app.inject({ method: 'POST', url: '/admin/shared/rescan', headers: auth(f.token) });
		assert.equal((await f.app.inject(relative(item.play.url))).statusCode, 403);
		const current = (await f.app.inject({ url: `/library/audio/${item.id}`, headers: auth(f.token) })).json<Audio>();
		await rm(join(directory, 'nested', 'Rain.flac'));
		await symlink(join(outside, 'secret.flac'), join(directory, 'nested', 'Rain.flac'));
		assert.equal((await f.app.inject(relative(current.play.url))).statusCode, 404);
		await f.app.inject({ method: 'POST', url: '/admin/shared/rescan', headers: auth(f.token) });
		assert.equal((await f.app.inject({ url: '/library/audio?source=shared', headers: auth(f.token) })).json<List>().items.length, 0);
	} finally { await f.cleanup(); await rm(directory, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});
