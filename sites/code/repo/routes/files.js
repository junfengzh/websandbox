'use strict';
// Files: tree, blob, raw, blame, find file, web editor (edit / new / delete -> real commits).
const code = require('../../lib/code');
const git = require('../lib/git');
const write = require('../lib/write');
const R = require('../lib/repo');

module.exports = async function (app, kit) {
  // ---------------------------------------------------------------- tree
  app.get('/:ns/:proj/-/tree/*', async (req, reply) => {
    const p = code.loadProject(req, req.params.ns, req.params.proj);
    if (!p.default_branch) return reply.redirect(p.url);
    const sp = git.splitRefPath(p, req.params['*'] || p.default_branch);
    if (!sp) throw kit.httpError(404, 'Ref not found');
    const view = R.treeView(req, p, sp.ref, sp.path);
    if (view.redirect) return reply.redirect(view.redirect);
    return reply.render('repo/tree', { ...view, project: p, nav: 'repo.files', title: sp.path ? sp.path.split('/').pop() : 'Files', crumbs: [['Repository', R.treeUrl(p, sp.ref.name)]] });
  });
  app.get('/:ns/:proj/tree/*', async (req, reply) => reply.redirect(`/${req.params.ns}/${req.params.proj}/-/tree/${req.params['*']}`));
  app.get('/:ns/:proj/blob/*', async (req, reply) => reply.redirect(`/${req.params.ns}/${req.params.proj}/-/blob/${req.params['*']}`));
  app.get('/:ns/:proj/raw/*', async (req, reply) => reply.redirect(`/${req.params.ns}/${req.params.proj}/-/raw/${req.params['*']}`));

  // ---------------------------------------------------------------- blob
  app.get('/:ns/:proj/-/blob/*', async (req, reply) => {
    const p = code.loadProject(req, req.params.ns, req.params.proj);
    const sp = git.splitRefPath(p, req.params['*']);
    if (!sp || !sp.path) throw kit.httpError(404, 'File not found');
    const c = sp.ref.commit;
    if (!c.has_tree) return reply.render('repo/tree', { ...R.truncatedView(p, sp.ref, sp.path), project: p, nav: 'repo.files', title: sp.path, crumbs: [['Repository', R.treeUrl(p, sp.ref.name)]] });
    const e = git.entryAt(c.tree_sha, sp.path);
    if (!e) throw kit.httpError(404, 'File not found');
    if (e.missing) return reply.render('repo/tree', { ...R.truncatedView(p, sp.ref, sp.path), project: p, nav: 'repo.files', title: sp.path, crumbs: [['Repository', R.treeUrl(p, sp.ref.name)]] });
    if (e.type === 'tree') return reply.redirect(R.treeUrl(p, sp.ref.name, sp.path));
    const blob = e.type === 'commit' ? { submodule: true, sha: e.sha } : git.readBlob(e.sha);
    const lang = git.languageOf(sp.path);
    const isMd = /\.(md|markdown|mdown|mkd)$/i.test(sp.path);
    const plain = req.query.plain === '1' || req.query.plain === 'true';
    let lines = null, rendered = null;
    if (blob.text != null) {
      if (isMd && !plain) rendered = code.md(blob.text, { project: p, ref: sp.ref.name, dir: sp.path.split('/').slice(0, -1).join('/') });
      else lines = git.highlightLines(blob.sha, blob.text, sp.path);
    }
    const last = git.lastCommitFor(p, sp.ref, sp.path);
    const image = (blob.binary || blob.text != null) && /\.(png|jpe?g|gif|webp|svg|ico|bmp)$/i.test(sp.path) && !blob.omitted;
    return reply.render('repo/blob', {
      project: p, nav: 'repo.files', title: sp.path.split('/').pop(), crumbs: [['Repository', R.treeUrl(p, sp.ref.name)]],
      ref: sp.ref.name, refInfo: sp.ref, path: sp.path, entry: e, blob, lines, rendered, isMd, plain, lang, last, image,
      canPush: R.canPush(req.user, p, sp.ref), refs: R.refOptions(p),
    });
  });

  // ---------------------------------------------------------------- raw
  app.get('/:ns/:proj/-/raw/*', async (req, reply) => {
    const p = code.loadProject(req, req.params.ns, req.params.proj);
    const sp = git.splitRefPath(p, req.params['*']);
    if (!sp || !sp.path) throw kit.httpError(404, 'File not found');
    const c = sp.ref.commit;
    const e = c.has_tree ? git.entryAt(c.tree_sha, sp.path) : { missing: true };
    if (!e) throw kit.httpError(404, 'File not found');
    if (e.missing) throw kit.httpError(404, 'The file contents of this commit are not available in this sandbox (history truncated).');
    if (e.type !== 'blob' && e.type !== 'link') throw kit.httpError(404, 'File not found');
    const b = git.readBlob(e.sha);
    if (b.missing) throw kit.httpError(404, 'File not found');
    if (b.omitted) throw kit.httpError(404, `This file (${code.fmtBytes(b.size)}) is too large to be stored in this sandbox.`);
    const ext = (/\.([a-z0-9]+)$/i.exec(sp.path) || [])[1] || '';
    const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', ico: 'image/x-icon', bmp: 'image/bmp', pdf: 'application/pdf', svg: 'text/plain; charset=utf-8' }[ext.toLowerCase()];
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'");
    if (req.query.inline === 'false') reply.header('Content-Disposition', `attachment; filename="${sp.path.split('/').pop().replace(/"/g, '')}"`);
    return reply.type(b.binary ? mime || 'application/octet-stream' : 'text/plain; charset=utf-8').send(b.data);
  });

  // ---------------------------------------------------------------- blame
  app.get('/:ns/:proj/-/blame/*', async (req, reply) => {
    const p = code.loadProject(req, req.params.ns, req.params.proj);
    const sp = git.splitRefPath(p, req.params['*']);
    if (!sp || !sp.path) throw kit.httpError(404, 'File not found');
    const bl = R.blame(p, sp.ref, sp.path);
    if (bl.notFound) throw kit.httpError(404, 'File not found');
    return reply.render('repo/blame', { project: p, nav: 'repo.files', title: 'Blame · ' + sp.path.split('/').pop(), crumbs: [['Repository', R.treeUrl(p, sp.ref.name)], ['Blame']], ref: sp.ref.name, path: sp.path, bl });
  });

  // ---------------------------------------------------------------- find file
  app.get('/:ns/:proj/-/find_file/*', async (req, reply) => {
    const p = code.loadProject(req, req.params.ns, req.params.proj);
    const r = git.resolveRef(p, req.params['*'] || p.default_branch);
    if (!r) throw kit.httpError(404, 'Ref not found');
    const all = r.commit && r.commit.has_tree ? git.allPaths(r.commit.tree_sha) : [];
    const q = String(req.query.q || '').trim().toLowerCase();
    const files = (q ? all.filter((f) => R.fuzzy(f.toLowerCase(), q)) : all).slice(0, 300);
    return reply.render('repo/find_file', { project: p, nav: 'repo.files', title: 'Find file', crumbs: [['Repository', R.treeUrl(p, r.name)], ['Find file']], ref: r.name, files, q, total: all.length, available: !!(r.commit && r.commit.has_tree) });
  });

  // ---------------------------------------------------------------- web editor
  const editorCtx = (req, mode) => {
    const p = code.loadProject(req, req.params.ns, req.params.proj);
    const sp = p.default_branch ? git.splitRefPath(p, req.params['*'] || p.default_branch) : null;
    if (!sp && mode !== 'new') throw kit.httpError(404, 'Ref not found');
    return { p, ref: sp ? sp.ref : null, path: sp ? sp.path.replace(/\/+$/, '') : '' };
  };
  const renderEditor = (req, reply, { p, ref, mode, path, dir, content, values = {}, errors = {}, status = 200 }) => reply.render('repo/edit', {
    project: p, nav: 'repo.files', title: mode === 'new' ? 'New File' : 'Edit · ' + path, crumbs: [['Repository', ref ? R.treeUrl(p, ref.name) : p.url], [mode === 'new' ? 'New file' : 'Edit file']],
    mode, ref: ref ? ref.name : 'main', refInfo: ref, path, dir, content, values, errors, canPush: R.canPush(req.user, p, ref), canCommitNew: R.canPush(req.user, p, null),
  }, status);

  app.get('/:ns/:proj/-/edit/*', { config: { login: true } }, async (req, reply) => {
    const { p, ref, path } = editorCtx(req, 'edit');
    if (!path) throw kit.httpError(404, 'File not found');
    const c = ref.commit;
    const e = c.has_tree ? git.entryAt(c.tree_sha, path) : { missing: true };
    if (!e || e.type === 'tree') throw kit.httpError(404, 'File not found');
    if (e.missing) throw kit.httpError(409, 'The file contents of this commit are not available in this sandbox (history truncated).');
    const b = git.readBlob(e.sha);
    if (b.text == null) throw kit.httpError(422, 'This file cannot be edited in the web editor (binary or too large).');
    return renderEditor(req, reply, { p, ref, mode: 'edit', path, content: b.text, values: { branch_name: R.suggestBranch(req, p, ref) } });
  });
  app.get('/:ns/:proj/-/new/*', { config: { login: true } }, async (req, reply) => {
    const { p, ref, path } = editorCtx(req, 'new');
    if (ref) {
      const c = ref.commit;
      const e = path && c.has_tree ? git.entryAt(c.tree_sha, path) : null;
      if (path && e && e.type !== 'tree') throw kit.httpError(404, 'Directory not found');
    }
    return renderEditor(req, reply, { p, ref, mode: 'new', path: '', dir: path, content: '', values: { branch_name: ref ? R.suggestBranch(req, p, ref) : 'main', file_name: String(req.query.file_name || '') } });
  });

  // POST handlers: commit to the target branch (creating it from the current ref if new).
  const commitFromForm = async (req, reply, mode) => {
    const { p, ref, path } = editorCtx(req, mode);
    const b = req.body || {};
    const branch = String(b.branch_name || (ref ? ref.name : 'main')).trim();
    const message = String(b.commit_message || '').trim();
    const content = b.content == null ? '' : String(b.content);
    const newMr = b.create_merge_request === '1' || b.create_merge_request === 'on' || b.create_merge_request === 'true';
    const errors = {};
    let filePath;
    if (mode === 'new') {
      const name = String(b.file_name || '').trim().replace(/^\/+/, '');
      filePath = (path ? path + '/' : '') + name;
      if (!name) errors.file_name = 'You must provide a file path.';
      else if (!write.validPath(filePath)) errors.file_name = 'The file path is invalid.';
    } else if (mode === 'edit') {
      filePath = String(b.file_path || path).trim().replace(/^\/+/, '') || path;
      if (!write.validPath(filePath)) errors.file_path = 'The file path is invalid.';
    } else filePath = path;
    if (!message) errors.commit_message = 'Commit message is required.';
    if (!write.validRefName(branch)) errors.branch_name = 'Branch name is invalid.';
    const target = git.getRef(p.id, 'branch', branch);
    const pushRef = target ? { kind: 'branch', name: branch } : null;
    if (!R.canPush(req.user, p, pushRef)) {
      if (target && R.canPush(req.user, p, null)) errors.branch_name = `You are not allowed to push into the protected branch ${branch}. Use a new branch.`;
      else throw kit.httpError(403, "You're not allowed to make changes to this project directly. Fork it first.");
    }
    if (Object.keys(errors).length) {
      if (mode === 'delete') { req.flash('error', Object.values(errors).join(' ')); return reply.redirect(R.blobUrl(p, ref.name, path)); }
      return renderEditor(req, reply, { p, ref, mode, path: mode === 'edit' ? path : '', dir: mode === 'new' ? path : undefined, content, values: b, errors, status: 422 });
    }
    const actions = mode === 'delete' ? [{ action: 'delete', path: filePath }]
      : mode === 'new' ? [{ action: 'create', path: filePath, content }]
        : filePath !== path ? [{ action: 'move', previousPath: path, path: filePath, content }] : [{ action: 'update', path: filePath, content }];
    const startSha = target ? target.sha : ref ? ref.sha : null;
    if (mode === 'edit' && b.last_commit_sha && target && ref && target.sha !== ref.sha && b.last_commit_sha !== target.sha) {
      // someone else changed the branch since the editor was opened: still fine unless the file changed
    }
    let c;
    try {
      c = write.commitFiles(p, req.user, { branch, startSha, actions, message });
    } catch (e) {
      if (e.statusCode !== 422 && e.statusCode !== 409) throw e;
      if (mode === 'delete') { req.flash('error', e.message); return reply.redirect(R.blobUrl(p, ref.name, path)); }
      return renderEditor(req, reply, { p, ref, mode, path: mode === 'edit' ? path : '', dir: mode === 'new' ? path : undefined, content, values: b, errors: { base: e.message }, status: 422 });
    }
    const created = !target;
    if (created && newMr && ref) {
      req.flash('success', 'Your changes have been committed successfully. You can now submit a merge request to get them into the target branch.');
      return reply.redirect(`${p.url}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${encodeURIComponent(branch)}&merge_request%5Btarget_branch%5D=${encodeURIComponent(ref.name)}`);
    }
    req.flash('success', mode === 'delete' ? 'The file has been successfully deleted.' : mode === 'new' ? 'The file has been successfully created.' : 'Your changes have been successfully committed.');
    if (mode === 'delete') {
      const dir = filePath.split('/').slice(0, -1).join('/');
      return reply.redirect(R.treeUrl(p, branch, dir));
    }
    void c;
    return reply.redirect(R.blobUrl(p, branch, filePath));
  };
  app.post('/:ns/:proj/-/update/*', { config: { login: true } }, async (req, reply) => commitFromForm(req, reply, 'edit'));
  app.post('/:ns/:proj/-/edit/*', { config: { login: true } }, async (req, reply) => commitFromForm(req, reply, 'edit'));
  app.post('/:ns/:proj/-/create/*', { config: { login: true } }, async (req, reply) => commitFromForm(req, reply, 'new'));
  app.post('/:ns/:proj/-/new/*', { config: { login: true } }, async (req, reply) => commitFromForm(req, reply, 'new'));
  app.post('/:ns/:proj/-/delete/*', { config: { login: true } }, async (req, reply) => commitFromForm(req, reply, 'delete'));
};
