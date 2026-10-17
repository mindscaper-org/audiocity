import assert from 'node:assert/strict';
import test from 'node:test';
import type { UploadDescriptor } from '../src/core.ts';
import { fixture, relative, upload } from './helpers.ts';

interface Created {
	project: { id: string };
	snapshot: { id: string };
	sync: { file: UploadDescriptor; blocks: UploadDescriptor[] };
}
interface Snapshot { file_url: string; blocks: { hash: string; url: string }[] }

for (const deletion of ['project', 'snapshot']) await test(`deleting a ${deletion} preserves blocks reused by a concurrent save during cleanup`, async t => {
	const f = await fixture(); t.after(() => f.cleanup());
	const headers = { authorization: `Bearer ${f.token}` };
	const create = async (name: string, blocks: string[]) => {
		const response = await f.app.inject({ method: 'POST', url: '/project', headers, payload: { name, blocks } });
		assert.equal(response.statusCode, 200, response.body);
		return response.json<Created>();
	};
	const source = await create('Project being removed', ['first-block', 'second-block']);
	for (const block of source.sync.blocks) await upload(f.app, block, Buffer.from(`original bytes for ${block.id}`));

	let reportPaused!: (id: string) => void;
	let resumeRemoval!: () => void;
	const paused = new Promise<string>(resolve => { reportPaused = resolve; });
	const resumed = new Promise<void>(resolve => { resumeRemoval = resolve; });
	const remove = f.ctx.blobs.remove.bind(f.ctx.blobs);
	let pauseNextBlock = true;
	f.ctx.blobs.remove = async id => {
		if (pauseNextBlock && f.ctx.blobs.get(id)?.kind === 'project-block') {
			pauseNextBlock = false;
			reportPaused(id);
			await resumed;
		}
		await remove(id);
	};
	const deletedPath = `/project/${source.project.id}` + (deletion === 'snapshot' ? `/snapshot/${source.snapshot.id}` : '');
	const deleting = f.app.inject({ method: 'DELETE', url: deletedPath, headers });
	let saved: Created;
	let shared: UploadDescriptor;
	try {
		const removingId = await paused;
		shared = source.sync.blocks.find(block => new URL(block.url).pathname !== `/uploads/${removingId}`)!;
		saved = await create('Project saved during cleanup', [shared.id]);
		assert.deepEqual(saved.sync.blocks, [], 'the confirmed block can be reused without another upload');
	} finally {
		resumeRemoval();
		assert.equal((await deleting).statusCode, 204);
		f.ctx.blobs.remove = remove;
	}
	await upload(f.app, saved.sync.file, Buffer.from('metadata referencing the shared block'));
	const root = `/project/${saved.project.id}/snapshot/${saved.snapshot.id}`;
	assert.equal((await f.app.inject({ method: 'POST', url: `${root}/sync`, headers })).statusCode, 204);
	const snapshot = (await f.app.inject({ url: root, headers })).json<Snapshot>();
	assert.deepEqual(snapshot.blocks.map(block => block.hash), [shared.id]);
	assert.equal((await f.app.inject(relative(snapshot.blocks[0]!.url))).body, `original bytes for ${shared.id}`);
});

for (const completed of [false, true]) await test(`sync recovers a ${completed ? 'historical completed' : 'pending'} revision damaged by legacy block cleanup`, async t => {
	const f = await fixture(); t.after(() => f.cleanup());
	const headers = { authorization: `Bearer ${f.token}` };
	const create = async (url: string, payload: object) => {
		const response = await f.app.inject({ method: 'POST', url, headers, payload });
		assert.equal(response.statusCode, 200, response.body);
		return response.json<Created>();
	};
	const source = await create('/project', { name: 'Old project', blocks: ['legacy-first', 'legacy-second'] });
	for (const block of source.sync.blocks) await upload(f.app, block, Buffer.from(`preserved local bytes for ${block.id}`));

	let reportPaused!: (id: string) => void;
	let resumeRemoval!: () => void;
	const paused = new Promise<string>(resolve => { reportPaused = resolve; });
	const resumed = new Promise<void>(resolve => { resumeRemoval = resolve; });
	const run = f.ctx.db.run.bind(f.ctx.db);
	const remove = f.ctx.blobs.remove.bind(f.ctx.blobs);
	// Replay the old cleanup algorithm through the real DELETE and save routes.
	// It selected unused blocks once, then deleted them without rechecking references.
	f.ctx.db.run = (sql, ...values) => sql.startsWith('DELETE FROM project_blocks WHERE')
		? run('DELETE FROM project_blocks WHERE owner_id=? AND hash=?', ...values.slice(0, 2))
		: run(sql, ...values);
	let pauseNextBlock = true;
	f.ctx.blobs.remove = async id => {
		if (pauseNextBlock && f.ctx.blobs.get(id)?.kind === 'project-block') {
			pauseNextBlock = false;
			reportPaused(id);
			await resumed;
		}
		await remove(id);
	};
	const deleting = f.app.inject({ method: 'DELETE', url: `/project/${source.project.id}`, headers });
	let saved: Created;
	let shared: UploadDescriptor;
	let expectedHead: string;
	try {
		const removingId = await paused;
		shared = source.sync.blocks.find(block => new URL(block.url).pathname !== `/uploads/${removingId}`)!;
		saved = await create('/project', { name: 'Project affected by old cleanup', blocks: [shared.id] });
		assert.deepEqual(saved.sync.blocks, []);
		await upload(f.app, saved.sync.file, Buffer.from('unchanged metadata referencing the shared block'));
		expectedHead = saved.snapshot.id;
		if (completed) {
			assert.equal((await f.app.inject({ method: 'POST', url: `/project/${saved.project.id}/snapshot/${saved.snapshot.id}/sync`, headers })).statusCode, 204);
			const newer = await create(`/project/${saved.project.id}/snapshot`, { head_snapshot_id: saved.snapshot.id, blocks: [] });
			await upload(f.app, newer.sync.file, Buffer.from('newer project metadata'));
			assert.equal((await f.app.inject({ method: 'POST', url: `/project/${saved.project.id}/snapshot/${newer.snapshot.id}/sync`, headers })).statusCode, 204);
			expectedHead = newer.snapshot.id;
		}
	} finally {
		resumeRemoval();
		try { assert.equal((await deleting).statusCode, 204); }
		finally { f.ctx.db.run = run; f.ctx.blobs.remove = remove; }
	}

	const root = `/project/${saved.project.id}/snapshot/${saved.snapshot.id}`;
	const expanded = await f.app.inject({ url: root, headers });
	assert.equal(expanded.statusCode, completed ? 409 : 200, expanded.body);
	if (completed) assert.equal(expanded.json<{ name: string }>().name, 'UploadIncomplete');
	const listed = await f.app.inject({ url: '/project', headers });
	assert.equal(listed.statusCode, 200, listed.body);
	assert.ok(listed.json<{ items: { id: string }[] }>().items.some(project => project.id === saved.project.id));
	const incomplete = await f.app.inject({ method: 'POST', url: `${root}/sync`, headers });
	assert.equal(incomplete.statusCode, 409, incomplete.body);
	assert.equal(incomplete.json<{ name: string }>().name, 'UploadIncomplete');
	const resumedSync = (await f.app.inject({ url: `${root}/sync`, headers })).json<Created['sync']>();
	assert.equal(resumedSync.file.url, '', 'the original confirmed metadata is retained');
	assert.deepEqual(resumedSync.blocks.map(block => block.id), [shared.id.toUpperCase()]);
	await upload(f.app, resumedSync.blocks[0]!, Buffer.from(`preserved local bytes for ${shared.id}`));
	assert.equal((await f.app.inject({ method: 'POST', url: `${root}/sync`, headers })).statusCode, 204);
	const response = await f.app.inject({ url: root, headers });
	assert.equal(response.statusCode, 200, response.body);
	const recovered = response.json<Snapshot>();
	assert.deepEqual(recovered.blocks.map(block => block.hash), [shared.id]);
	assert.equal((await f.app.inject(relative(recovered.file_url))).body, 'unchanged metadata referencing the shared block');
	assert.equal((await f.app.inject(relative(recovered.blocks[0]!.url))).body, `preserved local bytes for ${shared.id}`);
	const project = (await f.app.inject({ url: `/project/${saved.project.id}`, headers })).json<{ id: string; head: { id: string }; latest_synced_snapshot_id: string }>();
	assert.equal(project.id, saved.project.id);
	assert.equal(project.head.id, expectedHead);
	assert.equal(project.latest_synced_snapshot_id, expectedHead);
});
