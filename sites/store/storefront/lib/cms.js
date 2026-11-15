'use strict';
// Magento CMS content: expand the directives the stored pages/blocks use.
//   {{store url="x"}} / {{store direct_url="x"}} -> /x      {{media url="wysiwyg/x.jpg"}} -> /media/wysiwyg/admin/x.webp
//   {{block id="identifier"}} / {{widget type="...Block" block_id="N"}} -> block content
//   other {{widget ...}} (product lists) -> removed (the storefront renders its own showcases)
function render(db, html, depth = 0) {
  if (!html) return '';
  return String(html)
    .replace(/\{\{store\s+(?:direct_)?url="([^"]*)"\s*\}\}/g, (_, u) => '/' + u.replace(/^\/+/, ''))
    .replace(/\{\{media\s+url="([^"]*)"\s*\}\}/g, (_, u) => '/media/' + u.replace(/^wysiwyg\//, 'wysiwyg/admin/').replace(/\.(jpe?g|png|gif)$/i, '.webp'))
    .replace(/\{\{(?:block|widget)\s+[^}]*?(?:block_id|id)="([^"]+)"[^}]*\}\}/g, (_, id) => {
      if (depth > 2) return '';
      const b = /^\d+$/.test(id) ? db.prepare('SELECT content FROM cms_blocks WHERE id = ? AND is_active = 1').get(+id) : db.prepare('SELECT content FROM cms_blocks WHERE identifier = ? AND is_active = 1').get(id);
      return b ? render(db, b.content, depth + 1) : '';
    })
    .replace(/\{\{widget\s[^}]*\}\}/g, '')
    .replace(/\{\{[^}]*\}\}/g, '');
}
module.exports = { render };
