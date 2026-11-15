'use strict';
// Eta templates. Names resolve in the site's views/ first, then kit/views/
// ("kit/<name>" always means the kit's own template). "./x" is relative.
const fs = require('node:fs');
const path = require('node:path');
const { Eta } = require('eta');

const KIT_VIEWS = path.join(__dirname, '..', 'views');

function createViews(siteViews, { cache = true } = {}) {
  const eta = new Eta({ views: siteViews || KIT_VIEWS, cache, autoEscape: true, autoTrim: false });
  const dirs = [siteViews, KIT_VIEWS].filter(Boolean);
  const memo = new Map();
  eta.resolvePath = function (name, options) {
    const base = options && options.filepath;
    const key = `${base || ''}|${name}`;
    if (cache && memo.has(key)) return memo.get(key);
    const file = name + (path.extname(name) ? '' : '.eta');
    let found;
    if (file.startsWith('kit/')) found = path.join(KIT_VIEWS, file.slice(4));
    else if (base && /^\.\.?\//.test(file)) found = path.join(path.dirname(base), file);
    else found = dirs.map((d) => path.join(d, file.replace(/^\/+/, ''))).find((f) => fs.existsSync(f));
    if (!found || !dirs.some((d) => !path.relative(d, found).startsWith('..'))) throw new Error(`template not found: ${name}`);
    memo.set(key, found);
    return found;
  };
  return eta;
}

module.exports = { createViews, KIT_VIEWS };
