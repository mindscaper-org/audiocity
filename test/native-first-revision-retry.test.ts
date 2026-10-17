import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../src/app.ts';
import type { UploadDescriptor } from '../src/core.ts';
import { fixture, relative, upload } from './helpers.ts';

interface Created {
	project: { id: string }; snapshot: { id: string; parent_id: string };
	sync: { file: UploadDescriptor; mixdown: UploadDescriptor; blocks: UploadDescriptor[] };
}

await test('Audacity can retry its first aborted save after restart with the same native project ID', async t => {
	const f = await fixture(); let closeRestarted = async () => {};
	t.after(async () => { await closeRestarted(); await f.cleanup(); });
	const headers = { authorization: `Bearer ${f.token}` };
	const created = (await f.app.inject({ method: 'POST', url: '/project', headers, payload: { name: 'First save retry', blocks: ['AABB'] } })).json<Created>();
	const root = `/project/${created.project.id}`;
	assert.match(created.project.id, /^[1-9]\d*$/);
	// A failed local save makes Audacity delete the snapshot and retain its parent ID.
	assert.equal((await f.app.inject({ method: 'DELETE', url: `${root}/snapshot/${created.snapshot.id}`, headers })).statusCode, 204);
	assert.equal(created.snapshot.parent_id, '');
	await f.app.close();
	const restarted = await createApp(f.ctx.config); closeRestarted = () => restarted.app.close();
	const dormant = await restarted.app.inject({ url: root, headers });
	assert.equal(dormant.statusCode, 200, dormant.body);
	assert.equal(dormant.json<{ transport: string }>().transport, 'blocks');
	assert.equal(dormant.json<{ head: unknown }>().head, null);
	const listed = (await restarted.app.inject({ url: '/project?transport=all', headers })).json<{ items: unknown[] }>();
	assert.deepEqual(listed.items, [], 'empty native identities stay out of the desktop project list');
	assert.equal((await restarted.app.inject({ method: 'POST', url: `${root}/snapshot`, headers, payload: { format: 'aup4' } })).statusCode, 422);
	for (const descriptor of [created.sync.file, created.sync.mixdown, ...created.sync.blocks]) {
		assert.equal((await restarted.app.inject({ method: 'PUT', url: relative(descriptor.url), headers: { 'content-type': 'application/octet-stream' }, payload: Buffer.from('aborted bytes') })).statusCode, 409);
	}

	// The native serializer omits an empty head_snapshot_id on the next normal save.
	const retry = await restarted.app.inject({ method: 'POST', url: `${root}/snapshot`, headers, payload: { blocks: ['AABB'] } });
	assert.equal(retry.statusCode, 200, retry.body);
	const saved = retry.json<Created>();
	assert.equal(saved.project.id, created.project.id);
	assert.notEqual(saved.snapshot.id, created.snapshot.id);
	assert.equal(saved.snapshot.parent_id, '');
	assert.equal((await restarted.app.inject({ method: 'POST', url: `${root}/snapshot`, headers, payload: { blocks: [] } })).statusCode, 409);
	await upload(restarted.app, saved.sync.file, Buffer.from('retried project metadata'));
	await upload(restarted.app, saved.sync.blocks[0]!, Buffer.from('retried WavPack block'));
	assert.equal((await restarted.app.inject({ method: 'POST', url: `${root}/snapshot/${saved.snapshot.id}/sync`, headers })).statusCode, 204);
	const ready = (await restarted.app.inject({ url: '/project', headers })).json<{ items: { id: string; head: { id: string } }[] }>();
	assert.equal(ready.items[0]!.id, created.project.id);
	assert.equal(ready.items[0]!.head.id, saved.snapshot.id);
	const expanded = (await restarted.app.inject({ url: `${root}/snapshot/${saved.snapshot.id}`, headers })).json<{ file_url: string; blocks: { url: string }[] }>();
	assert.equal((await restarted.app.inject(relative(expanded.file_url))).body, 'retried project metadata');
	assert.equal((await restarted.app.inject(relative(expanded.blocks[0]!.url))).body, 'retried WavPack block');
});
