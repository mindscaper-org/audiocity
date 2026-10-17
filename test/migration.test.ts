import assert from 'node:assert/strict';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from '../src/app.ts';
import type { UploadDescriptor } from '../src/core.ts';
import { fixture, relative, upload } from './helpers.ts';

interface Created {
	project: { id: string }; snapshot: { id: string; file_url: string; blocks: { url: string }[] };
	sync: { file: UploadDescriptor; mixdown: UploadDescriptor; blocks: UploadDescriptor[] };
}
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

await test('restoring data to a new directory and origin preserves bytes and resumes pending uploads', async (t) => {
	const f = await fixture(); const moved = await mkdtemp(join(tmpdir(), 'audiocity-restored-'));
	let closeRestarted = async () => {};
	t.after(async () => { await closeRestarted(); await f.cleanup(); await rm(moved, { recursive: true, force: true }); });
	const created = (await f.app.inject({ method: 'POST', url: '/project', headers: auth(f.token), payload: { name: 'Moved', blocks: ['pending'] } })).json<Created>();
	await upload(f.app, created.sync.file, Buffer.from('preserved project metadata'));
	const archive = (await f.app.inject({ method: 'POST', url: '/project', headers: auth(f.token), payload: { name: 'Moved archive', format: 'aup4' } })).json<Created>();
	await f.app.close(); await cp(f.ctx.config.dataDir, moved, { recursive: true });
	await rm(f.ctx.config.dataDir, { recursive: true, force: true });
	const origin = 'http://localhost:9191';
	const restored = await createApp({ ...f.ctx.config, dataDir: moved, publicUrl: origin }); closeRestarted = () => restored.app.close();
	const base = `/project/${created.project.id}/snapshot/${created.snapshot.id}`;
	const metadata = (await restored.app.inject({ url: base, headers: auth(f.token) })).json<Created['snapshot']>();
	assert.equal(new URL(metadata.file_url).origin, origin);
	assert.equal((await restored.app.inject(relative(metadata.file_url))).body, 'preserved project metadata');
	const resumed = (await restored.app.inject({ url: `${base}/sync`, headers: auth(f.token) })).json<Created['sync']>();
	assert.equal(resumed.file.url, '');
	assert.equal(new URL(resumed.blocks[0]!.url).origin, origin);
	assert.equal(new URL(resumed.mixdown.url).origin, origin);
	await upload(restored.app, resumed.blocks[0]!, Buffer.from('resumed block'));
	assert.equal((await restored.app.inject({ method: 'POST', url: `${base}/sync`, headers: auth(f.token) })).statusCode, 204);
	const complete = (await restored.app.inject({ url: base, headers: auth(f.token) })).json<Created['snapshot']>();
	assert.equal((await restored.app.inject(relative(complete.blocks[0]!.url))).body, 'resumed block');
	const archiveBase = `/project/${archive.project.id}/snapshot/${archive.snapshot.id}`;
	const archiveSync = (await restored.app.inject({ url: `${archiveBase}/sync`, headers: auth(f.token) })).json<Created['sync']>();
	assert.equal(new URL(archiveSync.file.url).origin, origin);
	await upload(restored.app, archiveSync.file, Buffer.from('SQLite format 3\0restored'));
	assert.equal((await restored.app.inject({ method: 'POST', url: `${archiveBase}/sync`, headers: auth(f.token) })).statusCode, 200);
});

await test('resuming at the same origin preserves active upload capabilities', async (t) => {
	const f = await fixture(); t.after(() => f.cleanup());
	const created = (await f.app.inject({ method: 'POST', url: '/project', headers: auth(f.token), payload: { name: 'Stable', blocks: ['pending'] } })).json<Created>();
	const base = `/project/${created.project.id}/snapshot/${created.snapshot.id}/sync`;
	const resumed = (await f.app.inject({ url: base, headers: auth(f.token) })).json<Created['sync']>();
	const expected = { ...created.sync, blocks: created.sync.blocks.map(block => ({ ...block, id: block.id.toUpperCase() })) };
	assert.deepEqual(resumed, expected);
	const again = (await f.app.inject({ url: base, headers: auth(f.token) })).json<Created['sync']>();
	assert.deepEqual(again, expected);
	await upload(f.app, created.sync.file, Buffer.from('stable metadata'));
	await upload(f.app, created.sync.blocks[0]!, Buffer.from('stable block'));
	assert.equal((await f.app.inject({ method: 'POST', url: base, headers: auth(f.token) })).statusCode, 204);
});
