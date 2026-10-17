import assert from 'node:assert/strict';
import test from 'node:test';
import { createUser, fixture, upload } from './helpers.ts';
import type { UploadDescriptor } from '../src/core.ts';
import { createApp } from '../src/app.ts';

interface Snapshot {
	id: string;
	date_synced: number;
	file_url: string;
	blocks: { hash: string; url: string }[];
}
interface Created {
	project: { id: string; latest_synced_snapshot_id: string; head: Snapshot };
	snapshot: Snapshot;
	sync: { file: UploadDescriptor; mixdown: UploadDescriptor; blocks: UploadDescriptor[] };
}
interface Listed<T> { items: T[]; pagination: { total: number; pages: number; page: number; size: number } }
const path = (url: string) => new URL(url).pathname + new URL(url).search;
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function complete(f: Awaited<ReturnType<typeof fixture>>, created: Created) {
	await upload(f.app, created.sync.file, Buffer.from('opaque project metadata'));
	for (const block of created.sync.blocks) await upload(f.app, block, Buffer.from(`wavpack ${block.id}`));
	return f.app.inject({ method: 'POST', url: `/project/${created.project.id}/snapshot/${created.snapshot.id}/sync`, headers: auth(f.token) });
}

await test('native create, upload, completion and download follow Audacity DTO fields', async (t) => {
	const f = await fixture(); t.after(() => f.cleanup());
	const response = await f.app.inject({ method: 'POST', url: '/project', headers: auth(f.token), payload: { name: 'Session', blocks: ['AABBCC', 'DDEEFF'] } });
	assert.equal(response.statusCode, 200, response.body);
	const created = response.json<Created>();
	assert.equal(created.snapshot.date_synced, 0);
	assert.equal(created.sync.blocks[0]?.id, 'aabbcc');
	for (const key of ['id', 'username', 'author_name', 'slug', 'name', 'details', 'date_created', 'date_updated', 'size', 'head', 'latest_synced_snapshot_id']) assert.ok(key in created.project, key);
	const premature = await f.app.inject({ method: 'POST', url: `/project/${created.project.id}/snapshot/${created.snapshot.id}/sync`, headers: auth(f.token) });
	assert.equal(premature.statusCode, 409);
	assert.equal((await complete(f, created)).statusCode, 204);
	const repeat = await f.app.inject({ method: 'POST', url: `/project/${created.project.id}/snapshot/${created.snapshot.id}/sync`, headers: auth(f.token) });
	assert.equal(repeat.statusCode, 204);
	const result = await f.app.inject({ url: `/project/${created.project.id}/snapshot/${created.snapshot.id}?expand=blocks,file_url`, headers: auth(f.token) });
	const snapshot = result.json<Snapshot>();
	assert.ok(snapshot.date_synced > 0);
	assert.equal(snapshot.blocks.length, 2);
	const file = await f.app.inject(path(snapshot.file_url));
	assert.equal(file.body, 'opaque project metadata');
	assert.equal((await f.app.inject(path(snapshot.blocks[0]!.url))).body, 'wavpack aabbcc');
	const list = await f.app.inject({ url: '/project?page=1&per-page=1&q=Session', headers: auth(f.token) });
	assert.deepEqual(list.json<Listed<Snapshot>>().pagination, { total: 1, pages: 1, page: 1, size: 1 });
});

await test('blocks deduplicate per owner, revisions require the head, and force preserves history', async (t) => {
	const f = await fixture(); t.after(() => f.cleanup());
	const request = async (url: string, payload: object, token = f.token) => f.app.inject({ method: 'POST', url, headers: auth(token), payload });
	const first = (await request('/project', { name: 'First', blocks: ['same'] })).json<Created>();
	await complete(f, first);
	const nextUrl = `/project/${first.project.id}/snapshot`;
	assert.equal((await request(nextUrl, { blocks: ['same'], head_snapshot_id: 'stale' })).statusCode, 409);
	const second = (await request(nextUrl, { blocks: ['same'], head_snapshot_id: first.snapshot.id })).json<Created>();
	assert.equal(second.sync.blocks.length, 0);
	await complete(f, second);
	const forced = (await request(nextUrl, { blocks: ['same'], head_snapshot_id: first.snapshot.id, force: true })).json<Created>();
	await complete(f, forced);
	const historical = await f.app.inject({ url: `/project/${first.project.id}/snapshot/${second.snapshot.id}`, headers: auth(f.token) });
	assert.equal(historical.statusCode, 200);
	const otherProject = (await request('/project', { name: 'Second', blocks: ['same'] })).json<Created>();
	assert.equal(otherProject.sync.blocks.length, 0);
	const other = await createUser(f.app, f.token, 'other@example.test');
	const isolated = (await request('/project', { name: 'Other', blocks: ['same'] }, other.token)).json<Created>();
	assert.equal(isolated.sync.blocks.length, 1);
	assert.equal((await f.app.inject({ url: `/project/${first.project.id}`, headers: auth(other.token) })).statusCode, 404);
});

await test('GET sync resumes only missing blocks and stale completion never replaces a newer head', async (t) => {
	const f = await fixture(); t.after(() => f.cleanup());
	const create = async (url: string, payload: object) => (await f.app.inject({ method: 'POST', url, headers: auth(f.token), payload })).json<Created>();
	const first = await create('/project', { name: 'Resume', blocks: ['a', 'b'] });
	await upload(f.app, first.sync.file, Buffer.from('project'));
	await upload(f.app, first.sync.blocks[0]!, Buffer.from('block'));
	const resumeUrl = `/project/${first.project.id}/snapshot/${first.snapshot.id}/sync`;
	const resume = await f.app.inject({ url: resumeUrl, headers: auth(f.token) });
	assert.deepEqual(resume.json<Created['sync']>().blocks.map((block: UploadDescriptor) => block.id), ['B']);
	assert.equal(resume.json<Created['sync']>().file.url, '');
	const newer = await create(`/project/${first.project.id}/snapshot`, { head_snapshot_id: first.snapshot.id, blocks: [] });
	assert.equal((await complete(f, newer)).statusCode, 204);
	await upload(f.app, first.sync.blocks[1]!, Buffer.from('block b'));
	assert.equal((await f.app.inject({ method: 'POST', url: resumeUrl, headers: auth(f.token) })).statusCode, 409);
	const info = await f.app.inject({ url: `/project/${first.project.id}`, headers: auth(f.token) });
	assert.equal(info.json<Created['project']>().latest_synced_snapshot_id, newer.snapshot.id);
});

await test('new saves renew expired or cancelled block uploads reused from earlier snapshots', async (t) => {
	const f = await fixture(); t.after(() => f.cleanup());
	const create = async (url: string, payload: object) => {
		const response = await f.app.inject({ method: 'POST', url, headers: auth(f.token), payload });
		assert.equal(response.statusCode, 200, response.body);
		return response.json<Created>();
	};
	const first = await create('/project', { name: 'Interrupted save', blocks: ['expired', 'cancelled'] });
	const expired = first.sync.blocks.find(block => block.id === 'expired')!;
	const cancelled = first.sync.blocks.find(block => block.id === 'cancelled')!;
	f.ctx.db.run('UPDATE blobs SET expires=1 WHERE id=?', new URL(expired.url).pathname.split('/').pop()!);
	assert.equal((await f.app.inject({ method: 'POST', url: path(cancelled.fail) })).statusCode, 200);

	const second = await create(`/project/${first.project.id}/snapshot`, { head_snapshot_id: first.snapshot.id, blocks: ['expired', 'cancelled'] });
	assert.equal((await complete(f, second)).statusCode, 204);
	const historical = await f.app.inject({ url: `/project/${first.project.id}/snapshot/${first.snapshot.id}`, headers: auth(f.token) });
	assert.equal(historical.json<Snapshot>().blocks.length, 2, 'shared block references retain the recovered uploads');

	const abandoned = await create('/project', { name: 'Abandoned project', blocks: ['shared-cancelled'] });
	assert.equal((await f.app.inject({ method: 'POST', url: path(abandoned.sync.blocks[0]!.fail) })).statusCode, 200);
	const fresh = await create('/project', { name: 'New project', blocks: ['shared-cancelled'] });
	assert.equal((await complete(f, fresh)).statusCode, 204);
});

await test('whole AUP3 and AUP4 archives use explicit transport and retain revision downloads', async (t) => {
	const f = await fixture(); t.after(() => f.cleanup());
	const response = await f.app.inject({ method: 'POST', url: '/project', headers: auth(f.token), payload: { name: 'Archive', format: 'aup3', size: 17 } });
	assert.equal(response.statusCode, 201, response.body);
	const created = response.json<Created>();
	await upload(f.app, created.sync.file, Buffer.from('SQLite format 3\0x'));
	assert.equal((await f.app.inject({ method: 'POST', url: `/project/${created.project.id}/snapshot/${created.snapshot.id}/sync`, headers: auth(f.token) })).statusCode, 200);
	const nativeList = await f.app.inject({ url: '/project', headers: auth(f.token) });
	assert.equal(nativeList.json<Listed<Snapshot>>().items.length, 0);
	const list = await f.app.inject({ url: '/project?transport=all', headers: auth(f.token) });
	assert.equal(list.json<Listed<{ format: string }>>().items[0]?.format, 'aup3');
	const next = await f.app.inject({ method: 'POST', url: `/project/${created.project.id}/snapshot`, headers: auth(f.token), payload: { head_snapshot_id: created.snapshot.id, format: 'aup4', size: 17 } });
	assert.equal(next.statusCode, 201, next.body);
	const revision = next.json<Created>();
	await upload(f.app, revision.sync.file, Buffer.from('SQLite format 3\0y'));
	assert.equal((await f.app.inject({ method: 'POST', url: `/project/${created.project.id}/snapshot/${revision.snapshot.id}/sync`, headers: auth(f.token) })).statusCode, 200);
	const history = await f.app.inject({ url: `/project/${created.project.id}/snapshot`, headers: auth(f.token) });
	assert.equal(history.json<Listed<Snapshot>>().items.length, 2);
	const old = await f.app.inject({ url: `/project/${created.project.id}/snapshot/${created.snapshot.id}`, headers: auth(f.token) });
	assert.equal((await f.app.inject(path(old.json<Snapshot>().file_url))).body, 'SQLite format 3\0x');
});

await test('deleting active snapshots is guarded while deleting an abandoned head restores previous head', async (t) => {
	const f = await fixture(); t.after(() => f.cleanup());
	const request = async (url: string, payload: object) => (await f.app.inject({ method: 'POST', url, headers: auth(f.token), payload })).json<Created>();
	const first = await request('/project', { name: 'Delete', blocks: [] }); await complete(f, first);
	const root = `/project/${first.project.id}`;
	assert.equal((await f.app.inject({ method: 'DELETE', url: `${root}/snapshot/${first.snapshot.id}`, headers: auth(f.token) })).statusCode, 409);
	const pending = await request(`${root}/snapshot`, { blocks: [], head_snapshot_id: first.snapshot.id });
	assert.equal((await f.app.inject({ method: 'DELETE', url: `${root}/snapshot/${pending.snapshot.id}`, headers: auth(f.token) })).statusCode, 204);
	assert.equal((await f.app.inject({ url: root, headers: auth(f.token) })).json<Created['project']>().head.id, first.snapshot.id);
	assert.equal((await f.app.inject({ method: 'DELETE', url: root, headers: auth(f.token) })).statusCode, 204);
	assert.equal((await f.app.inject({ url: root, headers: auth(f.token) })).statusCode, 404);
});

await test('deleting the only pending snapshot removes its empty project and retires its upload capabilities', async (t) => {
	const f = await fixture(); t.after(() => f.cleanup());
	let nativeId = '';
	for (const format of ['audacity', 'aup4']) {
		const response = await f.app.inject({ method: 'POST', url: '/project', headers: auth(f.token), payload: { name: 'Cancelled initial save', format, blocks: format === 'audacity' ? ['abandoned'] : [] } });
		assert.equal(response.statusCode, format === 'audacity' ? 200 : 201, response.body);
		const created = response.json<Created>();
		if (format === 'audacity') nativeId = created.project.id;
		const root = `/project/${created.project.id}`;
		assert.equal((await f.app.inject({ method: 'DELETE', url: `${root}/snapshot/${created.snapshot.id}`, headers: auth(f.token) })).statusCode, 204);
		assert.equal((await f.app.inject({ url: root, headers: auth(f.token) })).statusCode, 404);
		assert.equal((await f.app.inject({ method: 'POST', url: `${root}/snapshot`, headers: auth(f.token), payload: { blocks: [] } })).statusCode, 404);
		const list = await f.app.inject({ url: '/project?transport=all', headers: auth(f.token) });
		assert.deepEqual(list.json<Listed<Snapshot>>().items, []);
		for (const descriptor of [created.sync.file, created.sync.mixdown, ...created.sync.blocks]) {
			assert.equal((await f.app.inject({ method: 'PUT', url: path(descriptor.url), headers: { 'content-type': 'application/octet-stream' }, payload: Buffer.from('cancelled bytes') })).statusCode, 409);
		}
	}
	const fresh = await f.app.inject({ method: 'POST', url: '/project', headers: auth(f.token), payload: { blocks: ['abandoned'] } });
	assert.equal(fresh.statusCode, 200, fresh.body);
	assert.notEqual(fresh.json<Created>().project.id, nativeId, 'a cancelled native project ID is not reused');
	assert.equal((await complete(f, fresh.json<Created>())).statusCode, 204);
});

await test('archive validation rejects arbitrary bytes and native transport switches', async (t) => {
	const f = await fixture(); t.after(() => f.cleanup());
	const createdResponse = await f.app.inject({ method: 'POST', url: '/project', headers: auth(f.token), payload: { name: 'Validate', format: 'aup4' } });
	const created = createdResponse.json<Created>();
	const invalid = await f.app.inject({ method: 'PUT', url: path(created.sync.file.url), headers: { 'content-type': 'application/octet-stream' }, payload: Buffer.from('not a portable SQLite project') });
	assert.equal(invalid.statusCode, 422);
	assert.equal((await f.app.inject({ method: 'POST', url: path(created.sync.file.success) })).statusCode, 409);
	await upload(f.app, created.sync.file, Buffer.from('SQLite format 3\0real database follows'));
	const switched = await f.app.inject({ method: 'POST', url: `/project/${created.project.id}/snapshot`, headers: auth(f.token), payload: { head_snapshot_id: created.snapshot.id, format: 'audacity', blocks: [] } });
	assert.equal(switched.statusCode, 422);
	const unknownParent = await f.app.inject({ method: 'POST', url: `/project/${created.project.id}/snapshot`, headers: auth(f.token), payload: { head_snapshot_id: 'unknown', format: 'aup4', force: true } });
	assert.equal(unknownParent.statusCode, 409);
});

await test('removing a forced pending branch restores the previous head and shared blocks survive project removal', async (t) => {
	const f = await fixture(); t.after(() => f.cleanup());
	const create = async (url: string, payload: object) => (await f.app.inject({ method: 'POST', url, headers: auth(f.token), payload })).json<Created>();
	const first = await create('/project', { name: 'Shared one', blocks: ['shared'] }); await complete(f, first);
	const newer = await create(`/project/${first.project.id}/snapshot`, { head_snapshot_id: first.snapshot.id, blocks: ['shared'] }); await complete(f, newer);
	const branch = await create(`/project/${first.project.id}/snapshot`, { head_snapshot_id: first.snapshot.id, blocks: ['shared'], force: true });
	assert.equal((await f.app.inject({ method: 'DELETE', url: `/project/${first.project.id}/snapshot/${branch.snapshot.id}`, headers: auth(f.token) })).statusCode, 204);
	const metadata = await f.app.inject({ url: `/project/${first.project.id}`, headers: auth(f.token) });
	assert.equal(metadata.json<Created['project']>().head.id, newer.snapshot.id);
	const shared = await create('/project', { name: 'Shared two', blocks: ['shared'] }); await complete(f, shared);
	await f.app.inject({ method: 'DELETE', url: `/project/${first.project.id}`, headers: auth(f.token) });
	const snapshot = await f.app.inject({ url: `/project/${shared.project.id}/snapshot/${shared.snapshot.id}`, headers: auth(f.token) });
	const block = snapshot.json<Snapshot>().blocks[0]!;
	assert.equal((await f.app.inject(path(block.url))).body, 'wavpack shared');
});

await test('resuming expired uploaded metadata retains its bytes and renews only upload capabilities', async (t) => {
	const f = await fixture({ maxUserBytes: 100 }); t.after(() => f.cleanup());
	const response = await f.app.inject({ method: 'POST', url: '/project', headers: auth(f.token), payload: { name: 'Expired', blocks: ['ready'] } });
	const created = response.json<Created>();
	const uploaded = await f.app.inject({ method: 'PUT', url: path(created.sync.file.url), headers: { 'content-type': 'application/octet-stream' }, payload: Buffer.from('already uploaded metadata') });
	assert.equal(uploaded.statusCode, 200);
	await upload(f.app, created.sync.blocks[0]!, Buffer.from('ready block'));
	f.ctx.db.run('UPDATE blobs SET expires=1');
	const before = f.ctx.db.get<{ n: number }>('SELECT COUNT(*) n FROM blobs')!.n;
	const resume = await f.app.inject({ url: `/project/${created.project.id}/snapshot/${created.snapshot.id}/sync`, headers: auth(f.token) });
	const sync = resume.json<Created['sync']>();
	assert.equal(sync.file.id, created.sync.file.id);
	assert.notEqual(sync.file.success, created.sync.file.success);
	assert.equal(sync.blocks.length, 0);
	assert.equal(f.ctx.db.get<{ n: number }>('SELECT COUNT(*) n FROM blobs')!.n, before);
	assert.equal((await f.app.inject({ method: 'POST', url: path(created.sync.file.success) })).statusCode, 403);
	assert.equal((await f.app.inject({ method: 'POST', url: path(sync.file.success) })).statusCode, 200);
	const completed = await f.app.inject({ method: 'POST', url: `/project/${created.project.id}/snapshot/${created.snapshot.id}/sync`, headers: auth(f.token) });
	assert.equal(completed.statusCode, 204);
	const snapshot = await f.app.inject({ url: `/project/${created.project.id}/snapshot/${created.snapshot.id}`, headers: auth(f.token) });
	assert.equal((await f.app.inject(path(snapshot.json<Snapshot>().file_url))).body, 'already uploaded metadata');
});

await test('pending archive validation and project data survive a server restart', async (t) => {
	const f = await fixture();
	let closeRestarted = async () => {};
	t.after(async () => { await closeRestarted(); await f.cleanup(); });
	const response = await f.app.inject({ method: 'POST', url: '/project', headers: auth(f.token), payload: { name: 'Restart', format: 'aup3' } });
	const created = response.json<Created>();
	await f.app.close();
	const restarted = await createApp(f.ctx.config); closeRestarted = () => restarted.app.close();
	const bad = await restarted.app.inject({ method: 'PUT', url: path(created.sync.file.url), headers: { 'content-type': 'application/octet-stream' }, payload: Buffer.from('invalid after restart') });
	assert.equal(bad.statusCode, 422);
	await upload(restarted.app, created.sync.file, Buffer.from('SQLite format 3\0persisted'));
	const completed = await restarted.app.inject({ method: 'POST', url: `/project/${created.project.id}/snapshot/${created.snapshot.id}/sync`, headers: auth(f.token) });
	assert.equal(completed.statusCode, 200);
	assert.equal((await restarted.app.inject(path(completed.json<Snapshot>().file_url))).body, 'SQLite format 3\0persisted');
});

await test('a rejected first archive upload reservation leaves no project or blobs', async (t) => {
	const f = await fixture({ maxUserBytes: 20 }); t.after(() => f.cleanup());
	const response = await f.app.inject({ method: 'POST', url: '/project', headers: auth(f.token), payload: { name: 'Too large', format: 'aup4', size: 30 } });
	assert.equal(response.statusCode, 413);
	assert.equal(f.ctx.db.get<{ n: number }>('SELECT COUNT(*) n FROM projects')!.n, 0);
	assert.equal(f.ctx.db.get<{ n: number }>('SELECT COUNT(*) n FROM blobs')!.n, 0);
});
