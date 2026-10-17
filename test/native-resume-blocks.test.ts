import assert from 'node:assert/strict';
import test from 'node:test';
import type { UploadDescriptor } from '../src/core.ts';
import { fixture, relative, upload } from './helpers.ts';

interface Created {
	project: { id: string }; snapshot: { id: string };
	sync: { file: UploadDescriptor; blocks: UploadDescriptor[] };
}

await test('native resume descriptors match Audacity cached uppercase block hashes', async t => {
	const f = await fixture(); t.after(() => f.cleanup());
	const headers = { authorization: `Bearer ${f.token}` };
	const pendingHash = '0000000A' + 'ABCDEF01'.repeat(7);
	const created = (await f.app.inject({ method: 'POST', url: '/project', headers, payload: { name: 'Interrupted blocks', blocks: [pendingHash] } })).json<Created>();
	assert.equal(created.sync.blocks[0]!.id, pendingHash.toLowerCase(), 'creation retains audio.com descriptor casing');
	await upload(f.app, created.sync.file, Buffer.from('native metadata'));
	const root = `/project/${created.project.id}/snapshot/${created.snapshot.id}`;
	const resumed = (await f.app.inject({ url: `${root}/sync`, headers })).json<Created['sync']>();
	assert.equal(resumed.file.url, '');
	// ResumedSnaphotUploadOperation::UpdateUrls performs this exact-case lookup.
	const lookup = new Map(resumed.blocks.map(block => [block.id, block]));
	const descriptor = lookup.get(pendingHash);
	assert.ok(descriptor, 'Audacity must retain the pending block upload after refreshing URLs');
	assert.equal(descriptor.url, created.sync.blocks[0]!.url, 'an active capability remains valid');
	await upload(f.app, descriptor, Buffer.from('native WavPack block bytes'));
	assert.equal((await f.app.inject({ method: 'POST', url: `${root}/sync`, headers })).statusCode, 204);
	const expanded = (await f.app.inject({ url: root, headers })).json<{ blocks: { hash: string; url: string }[] }>();
	assert.equal(expanded.blocks[0]!.hash, pendingHash.toLowerCase(), 'download hashes retain audio.com casing');
	assert.equal((await f.app.inject(relative(expanded.blocks[0]!.url))).body, 'native WavPack block bytes');
});
