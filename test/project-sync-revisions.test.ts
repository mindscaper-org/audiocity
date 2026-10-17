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
