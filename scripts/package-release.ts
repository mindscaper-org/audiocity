import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string; scripts: Record<string, string> };
const version = manifest.version;
const image = `ghcr.io/${(process.env.GITHUB_REPOSITORY || 'mindscaper-org/audiocity').toLowerCase()}:${version}`;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Releases require a stable semantic version.');
if (process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME !== `v${version}`) {
	throw new Error('The release tag must match package.json.');
}
const output = join(root, 'dist/release');
mkdirSync(output, { recursive: true });
const staging = mkdtempSync(join(tmpdir(), 'audiocity-package-'));
const archives: string[] = [];
function archive(kind: string, prepare: (directory: string) => void) {
	const name = `audiocity-${version}-${kind}`;
	const directory = join(staging, name);
	mkdirSync(directory);
	prepare(directory);
	const filename = `${name}.tar.gz`;
	execFileSync('tar', ['-czf', join(output, filename), '-C', staging, name]);
	archives.push(filename);
}
function copy(name: string, directory: string) { cpSync(join(root, name), join(directory, name), { recursive: true }); }
try {
	archive('source', directory => {
		execFileSync('tar', ['-xzf', join(root, 'dist/source.tar.gz'), '-C', directory]);
	});
	archive('node', directory => {
		// Keep the complete corresponding source, while shipping ready-to-run JavaScript.
		for (const name of ['package-lock.json', '.npmrc', '.nvmrc', '.env.example', 'LICENSE', 'NOTICE.md', 'docs']) copy(name, directory);
		mkdirSync(join(directory, 'dist'));
		for (const name of readdirSync(join(root, 'dist'))) {
			if (name.endsWith('.js') || name.endsWith('.js.map') || name === 'source.tar.gz' || name === 'assets') {
				cpSync(join(root, 'dist', name), join(directory, 'dist', name), { recursive: true });
			}
		}
		writeFileSync(join(directory, 'package.json'), `${JSON.stringify({ ...manifest, scripts: { start: 'node dist/main.js' } }, null, 2)}\n`);
		writeFileSync(join(directory, 'README.md'), `# Audiocity ${version}: Node.js package

Requires Node.js 26.5.0 and npm 12.0.1. JavaScript is already compiled.

Run:

\x60\x60\x60sh
npm ci --omit=dev
cp .env.example .env
# Edit .env as needed. Bind to loopback when using a local reverse proxy:
AUDIOCITY_HOST=127.0.0.1 node --env-file=.env dist/main.js
\x60\x60\x60

Open http://localhost:8080 and save the generated administrator password shown
once at startup. Store ./data persistently, and run as an unprivileged user.
See docs/operations.md for HTTPS, backups, recovery, and the single-process limit.
For a service manager, use this directory as the working directory and the same
environment settings. The complete source is in dist/source.tar.gz and is served
at /source.tar.gz. For Docker deployment use the separate deploy package.
`);
	});
	archive('deploy', directory => {
		const compose = readFileSync(join(root, 'compose.yaml'), 'utf8')
			.replace('    build: .\n', '').replace('    image: audiocity:local', `    image: ${image}\n    pull_policy: missing`);
		writeFileSync(join(directory, 'compose.yaml'), `name: audiocity\n${compose}`);
		for (const name of ['.env.example', 'LICENSE', 'NOTICE.md', 'docs']) copy(name, directory);
		const deploy = readFileSync(join(root, 'scripts/deploy.sh'), 'utf8');
		writeFileSync(join(directory, 'deploy.sh'), deploy, { mode: 0o755 });
		writeFileSync(join(directory, 'README.md'), `# Audiocity ${version}: Docker deployment

Install Docker Engine or Docker Desktop with Compose v2 or newer, then run:

\x60\x60\x60sh
./deploy.sh
docker compose logs audiocity
\x60\x60\x60

Docker pulls ${image} from GitHub Container Registry when it is not already
installed, selects Linux amd64 or arm64 for your Docker server, and starts
Audiocity. No registry account or local build is needed. You can also run
docker compose pull followed by docker compose up -d --wait directly.
Data lives on your Docker daemon's machine.

Open http://localhost:8080. Save the generated administrator password shown once
in the logs, sign in, and change it through Menu → Change password.

Copy .env.example to .env and edit it before first start to customize settings.
For a public server, configure AUDIOCITY_PUBLIC_URL and AUDIOCITY_CORS_ORIGINS,
and place an HTTPS reverse proxy in front of the loopback port.

For offline installation, download the matching audiocity-${version}-docker-ARCH.tar.gz
and SHA256SUMS from the release page, verify the checksum, then run:

\x60\x60\x60sh
docker load -i audiocity-${version}-docker-ARCH.tar.gz
docker compose up -d --wait --pull never
\x60\x60\x60

Data persists in the audiocity_audiocity-data named volume. Keep the Compose
project name audiocity when upgrading. Back up before upgrades; extract the new
deploy bundle, preserve your .env, and run its deploy.sh. To roll back, restore
the backup with the previous release. Never use docker compose down -v unless
you intend to delete all data. See docs/operations.md for backups and recovery.

Clients need configuration: see docs/clients.md. Windows Audacity 3.7.9 has been
tested manually against a WSL-hosted server; other versions require validation.
Source is available from /source.tar.gz and
the release's source archive under AGPL-3.0-only.
`);
	});
	writeFileSync(join(output, 'SHA256SUMS'), archives.map(name => `${createHash('sha256').update(readFileSync(join(output, name))).digest('hex')}  ${name}\n`).join(''));
	process.stdout.write(`Release packages: ${output}\n`);
} finally { rmSync(staging, { recursive: true, force: true }); }
