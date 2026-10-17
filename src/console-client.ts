import { consoleLibrary } from './console-library.ts';
import { consoleManage } from './console-manage.ts';

/** Browser source is served as a separate asset so the console needs no inline scripts. */
export const consoleClient = String.raw`'use strict';
(() => {
	const workspace = document.getElementById('workspace');
	const message = document.getElementById('message');
	const menu = document.getElementById('menu');
	const storageKey = 'audiocity.access-token';
	let user;
	const players = new Set();
	let libraryTab = 'audio';
	let optionsPromise;
	let viewGeneration = 0;
	function stopPlayers() { for (const player of players) player.dispose(); players.clear(); }
	async function player(container, data) {
		const { attachAudioPlayer } = await import('/playback.js');
		const attached = await attachAudioPlayer(container, data);
		if (!container.isConnected) attached.dispose(); else { players.add(attached); container.playerHandle = attached; }
		return attached;
	}
	function token() { return sessionStorage.getItem(storageKey); }
	function node(tag, content) {
		const result = document.createElement(tag);
		if (content !== undefined) result.textContent = String(content);
		return result;
	}
	function tell(text, error = false) {
		message.textContent = text;
		message.className = error ? 'error' : '';
		message.hidden = !text;
	}
	function fail(error) { tell(error instanceof Error ? error.message : 'The request failed.', true); }
	function on(target, event, action) {
		target.addEventListener(event, e => {
			if (event === 'submit') e.preventDefault();
			try { Promise.resolve(action(e)).catch(fail); } catch (error) { fail(error); }
		});
	}
	function begin(title) {
		viewGeneration++; stopPlayers(); document.title = title + ' · Audiocity'; tell('');
		const heading = node('h1', title);
		heading.id = 'view-title';
		workspace.replaceChildren(heading);
		return workspace;
	}
	function session(value) {
		user = value;
		document.getElementById('session').textContent = value ? 'Signed in as ' + value.name + ' (' + value.email + ')' : 'Not signed in';
		document.querySelectorAll('[data-auth]').forEach(button => { button.hidden = !value; });
		document.getElementById('login-menu').hidden = Boolean(value);
		document.getElementById('admin-menu').hidden = !value || !value.admin;
		document.querySelectorAll('[data-admin]').forEach(button => { button.hidden = !value || !value.admin; });
	}
	function clearSession() { sessionStorage.removeItem(storageKey); optionsPromise = undefined; audioSource = undefined; audioQuery = ''; resetManage(); session(undefined); }
	async function responseData(response) {
		if (response.status === 204) return undefined;
		const text = await response.text();
		try { return text ? JSON.parse(text) : undefined; }
		catch { throw new Error('The server returned an invalid response.'); }
	}
	async function api(path, method = 'GET', body) {
		const authorization = token();
		const headers = { Accept: 'application/json' };
		if (authorization) headers.Authorization = 'Bearer ' + authorization;
		if (body !== undefined) headers['Content-Type'] = 'application/json';
		const response = await fetch(path, { method, headers, credentials: 'omit', ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
		const data = await responseData(response);
		if (!response.ok) {
			if (response.status === 401 && authorization) {
				clearSession(); login();
				throw new Error('Your session expired. Log in to continue.');
			}
			throw new Error(data && typeof data.message === 'string' ? data.message : 'Request failed (' + response.status + ').');
		}
		return data;
	}
	function requireSession() {
		if (!user || !token()) { login(); throw new Error('Log in to continue.'); }
	}
	function field(form, title, type = 'text', value = '') {
		const label = node('label', title);
		const input = node('input'); input.type = type; input.value = value; input.setAttribute('aria-label', title);
		if (type === 'checkbox') label.className = 'check';
		label.append(input); form.append(label);
		return input;
	}
	function select(form, title, values, current) {
		const label = node('label', title); const input = node('select'); input.setAttribute('aria-label', title);
		for (const [value, title] of values) { const option = node('option', title); option.value = value; input.append(option); }
		input.value = current; label.append(input); form.append(label); return input;
	}
	function submit(form, title, action) {
		const button = node('button', title); button.type = 'submit'; form.append(button);
		on(form, 'submit', async () => {
			button.disabled = true; tell('');
			try { await action(); } finally { button.disabled = false; }
		});
	}
	function actionMenu(card, actions) {
		const details = node('details'); details.append(node('summary', 'Actions'));
		const nav = node('nav'); nav.setAttribute('aria-label', 'Item actions');
		for (const [title, action] of actions) {
			const button = node('button', title); button.type = 'button';
			on(button, 'click', async () => { details.open = false; await action(); }); nav.append(button);
		}
		details.append(nav); card.append(details);
	}
	function card(title, description, parent = workspace) {
		const result = node('article'); result.append(node('h2', title), node('p', description)); parent.append(result); return result;
	}
	function safeUrl(value) {
		const url = new URL(value, location.href);
		if (!['http:', 'https:'].includes(url.protocol)) throw new Error('The server returned an invalid media URL.');
		return url.href;
	}
	function download(url, name) {
		const link = node('a', 'Download'); link.href = safeUrl(url); link.download = name;
		link.rel = 'noreferrer noopener'; link.target = '_blank'; document.body.append(link); link.click(); link.remove();
	}
	async function transfer(policy, file) {
		try {
			const uploaded = await fetch(safeUrl(policy.url), { method: 'PUT', credentials: 'omit', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
			if (!uploaded.ok) { const data = await responseData(uploaded); throw new Error(data && data.message || 'The file upload failed.'); }
			const completed = await fetch(safeUrl(policy.success), { method: 'POST', credentials: 'omit' });
			if (!completed.ok) throw new Error('The uploaded file could not be confirmed.');
		} catch (error) {
			try { await fetch(safeUrl(policy.fail), { method: 'DELETE', credentials: 'omit' }); } catch { /* Keep the original error. */ }
			throw error;
		}
	}
	function login() {
		begin('Log in');
		workspace.append(node('p', 'Use the administrator account configured on your server, or an account created by its administrator.'));
		const form = node('form');
		const email = field(form, 'Email or username'); email.required = true; email.autocomplete = 'username';
		const password = field(form, 'Password', 'password'); password.required = true; password.autocomplete = 'current-password';
		submit(form, 'Log in', async () => {
			let grant;
			try { grant = await api('/auth/token', 'POST', { grant_type: 'password', username: email.value, password: password.value, scope: 'all' }); }
			finally { password.value = ''; }
			sessionStorage.setItem(storageKey, grant.access_token);
			try { session(await api('/auth/me')); }
			catch (error) { clearSession(); throw error; }
			await openRequestedView();
		});
		workspace.append(form); email.focus();
	}
	${consoleLibrary}
	${consoleManage}
	function projectUpload(project) {
		requireSession(); if (!project) { uploadFiles(); return; } begin('New revision: ' + project.name);
		workspace.append(node('p', 'Close the project in Audacity first so all changes are written into the standalone file. Archive revisions preserve the whole file; native block snapshots use a separate transport.'));
		const form = node('form'); const file = field(form, 'Project file', 'file'); file.accept = '.aup3,.aup4'; file.required = true;
		const name = field(form, 'Project name (optional)', 'text', project ? project.name : ''); name.maxLength = 256;
		submit(form, 'Upload project revision', async () => {
			const source = file.files[0]; if (!source) throw new Error('Choose an AUP3 or AUP4 file.');
			const format = source.name.split('.').pop().toLowerCase();
			if (!['aup3', 'aup4'].includes(format)) throw new Error('Choose an AUP3 or AUP4 project file.');
			const body = { format, size: source.size, name: name.value.trim() || source.name.replace(/\.[^.]+$/, ''), blocks: [], ...(project ? { head_snapshot_id: project.head.id } : {}) };
			tell('Uploading project archive…');
			const result = await api(project ? '/project/' + encodeURIComponent(project.id) + '/snapshot' : '/project', 'POST', body);
			await transfer(result.sync.file, source);
			await api('/project/' + encodeURIComponent(result.project.id) + '/snapshot/' + encodeURIComponent(result.snapshot.id) + '/sync', 'POST');
			if (form.isConnected) await projectList();
			tell('Project revision uploaded and synchronized.');
		});
		workspace.append(form);
	}
	async function projectList(page = 1) {
		requireSession(); const accountId = user.id; const view = ++viewGeneration; const result = await api('/project?transport=all&per-page=20&page=' + page);
		if (view !== viewGeneration || user?.id !== accountId) return;
		const panel = libraryFrame('projects');
		if (!result.items.length) panel.append(node('p', 'No projects on this page. Use + Upload to add an AUP3 or AUP4 archive.'));
		for (const project of result.items) {
			const article = card(project.name, project.format.toUpperCase() + ' · ' + project.size.toLocaleString() + ' bytes', panel);
			const actions = [['Revisions', () => revisions(project)]];
			if (project.preview) {
				actions.push(['Preview audio', () => projectPreview(article, project)]);
				if (!project.preview.is_current) article.append(node('p', 'The audio preview is from an earlier revision. Use Update Cloud Audio Preview in Audacity to refresh it.'));
			} else if (project.transport === 'blocks') article.append(node('p', 'No audio preview yet. Use Update Cloud Audio Preview in Audacity to create one.'));
			if (project.transport === 'blocks') actions.push(['Update preview in Audacity', () => { location.href = 'audacity://generate-audio?projectId=' + encodeURIComponent(project.id); }]);
			if (project.transport === 'file') actions.push(['Upload revision', () => projectUpload(project)]);
			actionMenu(article, actions);
		}
		pagination(page, page < result.pagination.pages, projectList, panel);
	}
	async function projectPreview(article, project, revision) {
		const path = '/project/' + encodeURIComponent(project.id) + (revision ? '/snapshot/' + encodeURIComponent(revision.id) : '');
		const fresh = await api(path);
		if (!fresh.preview) throw new Error('No audio preview is available. Use Update Cloud Audio Preview in Audacity.');
		const previous = article.querySelector('.project-player');
		if (previous) { if (previous.playerHandle) { previous.playerHandle.dispose(); players.delete(previous.playerHandle); } previous.remove(); }
		const container = node('div'); container.className = 'project-player'; article.append(container);
		await player(container, { url: safeUrl(fresh.preview.url), mime: fresh.preview.mime, name: project.name });
	}
	async function revisions(project, page = 1) {
		requireSession(); const accountId = user.id; const view = ++viewGeneration; const result = await api('/project/' + encodeURIComponent(project.id) + '/snapshot?per-page=20&page=' + page);
		if (view !== viewGeneration || user?.id !== accountId) return;
		begin('Revisions: ' + project.name);
		for (const revision of result.items) {
			const date = new Date(revision.date_created * 1000).toLocaleString();
			const article = card(date, revision.format.toUpperCase() + ' · ' + (revision.date_synced ? 'synchronized' : 'incomplete') + ' · ' + revision.file_size.toLocaleString() + ' file bytes');
			article.append(node('p', 'Revision ' + revision.id));
			const actions = [];
			if (revision.preview) actions.push(['Preview audio', () => projectPreview(article, project, revision)]);
			if (revision.transport === 'file' && revision.date_synced && revision.file_url) actions.push(['Download archive', async () => {
				const fresh = await api('/project/' + encodeURIComponent(project.id) + '/snapshot/' + encodeURIComponent(revision.id));
				download(fresh.file_url, project.name.replace(/[\\/]/g, '-') + '.' + fresh.format);
			}]);
			else if (revision.transport === 'blocks') article.append(node('p', 'Open this cloud revision in Audacity to edit it.'));
			if (actions.length) actionMenu(article, actions);
		}
		pagination(page, page < result.pagination.pages, next => revisions(project, next));
	}
	function createAccount() {
		requireSession(); if (!user.admin) throw new Error('Administrator access is required.');
		begin('Create account');
		const form = node('form'); const email = field(form, 'Email', 'email'); email.required = true;
		const name = field(form, 'Display name'); name.maxLength = 100;
		const password = field(form, 'Initial password', 'password'); password.required = true; password.minLength = 12; password.maxLength = 256; password.autocomplete = 'new-password';
		submit(form, 'Create account', async () => {
			const result = await api('/admin/users', 'POST', { email: email.value, name: name.value, password: password.value });
			password.value = ''; form.reset(); tell('Account created for ' + result.email + '. Username: ' + result.username + '.');
		});
		workspace.append(form);
	}
	function changePassword() {
		requireSession(); begin('Change password');
		workspace.append(node('p', 'Changing your password signs out every current session, including this tab.'));
		const form = node('form');
		const current = field(form, 'Current password', 'password'); current.required = true; current.autocomplete = 'current-password';
		const next = field(form, 'New password', 'password'); next.required = true; next.minLength = 12; next.maxLength = 256; next.autocomplete = 'new-password';
		const confirm = field(form, 'Confirm new password', 'password'); confirm.required = true; confirm.autocomplete = 'new-password';
		submit(form, 'Change password', async () => {
			if (next.value !== confirm.value) throw new Error('The new passwords do not match.');
			await api('/auth/password', 'POST', { current_password: current.value, new_password: next.value });
			current.value = ''; next.value = ''; confirm.value = '';
			history.replaceState(null, '', '/library?tab=' + libraryTab); clearSession(); login(); tell('Password changed. Log in with your new password.');
		});
		workspace.append(form);
	}
	function help() {
		begin('API help');
		workspace.append(node('p', 'Use this server’s origin as the API base URL. Requests use a bearer token obtained from POST /auth/token, or authorization code with PKCE for registered public clients.'));
		const list = node('ul');
		for (const item of ['POST /v1/audio/create → PUT policy.url → POST policy.success', 'GET /v1/audio/list and PATCH /v1/audio/update?id=…', 'POST /project with format, size, name and blocks: [] for a whole-file AUP3/AUP4 archive', 'PUT sync.file.url → POST sync.file.success → POST /project/{id}/snapshot/{sid}/sync', 'GET /project?transport=all includes file archives and native Audacity block snapshots', 'Native Audacity clients exchange a project file plus missing blocks through the same snapshot API.', 'The server preserves originals. It does not transcode media or reconstruct block snapshots in this console.']) list.append(node('li', item));
		workspace.append(list);
		const discovery = node('a', 'Server capabilities and upload limits'); discovery.href = '/.well-known/audiocity'; workspace.append(discovery);
		const source = node('a', 'Download corresponding source (AGPL-3.0)'); source.href = '/source.tar.gz';
		workspace.append(node('p', 'Server source:'), source);
	}
	async function openRequestedView() { await route(); }
	function link(title, path) {
		const result = node('a', title); result.href = path;
		on(result, 'click', async event => { if (!event.ctrlKey && !event.metaKey && !event.shiftKey && event.button === 0) { event.preventDefault(); await go(path); } });
		return result;
	}
	async function go(path, replace = false) {
		if (replace) history.replaceState(null, '', path); else history.pushState(null, '', path);
		await route();
	}
	async function route() {
		viewGeneration++;
		const path = location.pathname;
		const audio = path.match(/^\/audio\/([^/]+)\/(play|edit)$/);
		const slug = path.match(/^\/([^/]+)\/audio\/([^/]+)(\/edit)?$/);
		if (audio && audio[2] === 'play') { await playAudio({ id: decodeURIComponent(audio[1]) }); return; }
		if (slug && !slug[3]) { await playAudio({ username: decodeURIComponent(slug[1]), slug: decodeURIComponent(slug[2]) }); return; }
		if (path === '/help') { help(); return; }
		if (!user) { if (path !== '/' || new URLSearchParams(location.search).has('view')) login(); return; }
		if (audio) { await editAudioPage({ id: decodeURIComponent(audio[1]) }); return; }
		if (slug) {
			const pending = editAudioPage({ username: decodeURIComponent(slug[1]), slug: decodeURIComponent(slug[2]) });
			const view = viewGeneration; const requestedUrl = location.href;
			try { await pending; }
			catch (error) { if (view !== viewGeneration) return; await audioList(); if (location.href === requestedUrl) tell(error.message, true); }
			return;
		}
		if (path === '/account/new') { createAccount(); return; }
		if (path === '/account/password') { changePassword(); return; }
		if (path === '/upload') { await uploadFiles(); return; }
		if (path === '/manage') { await manageFiles(); return; }
		if (path === '/admin/categories/manage') { await manageCategories(); return; }
		const query = new URLSearchParams(location.search);
		libraryTab = query.get('tab') || query.get('view') || libraryTab;
		if (libraryTab === 'projects') await projectList(); else await audioList();
	}
	const actions = { login, upload: () => go('/upload'), library: () => go('/library?tab=' + libraryTab), manage: () => go('/manage'), categories: () => go('/admin/categories/manage'), account: () => go('/account/new'), password: () => go('/account/password'), help: () => go('/help'),
		logout: async () => { await api('/auth/logout', 'POST'); clearSession(); begin('Signed out'); workspace.append(node('p', 'Choose Menu → Log in to return to your library.')); }
	};
	document.querySelectorAll('[data-action]').forEach(button => on(button, 'click', async () => { menu.open = false; await actions[button.dataset.action](); }));
	window.addEventListener('popstate', () => { route().catch(fail); });
	window.addEventListener('beforeunload', event => { if (manageDrafts.size) { event.preventDefault(); event.returnValue = ''; } });
	async function start() {
		if (token()) {
			try { session(await api('/auth/me')); }
			catch (error) { clearSession(); login(); fail(error); return; }
		}
		await route();
	}
	start().catch(fail);
})();`;
