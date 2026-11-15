"""Clean one mwoffliner (Kiwix) article page into compact article HTML.

clean(html_bytes, link_fn, img_fn) -> dict(html, text, lead, sections, links, images, infobox)

  link_fn(path) -> canonical path of the target if it is in the selection, else None
  img_fn(zim_image_path, width, height) -> (url, w, h) if a thumbnail is kept, else None

Kept: lead, infobox, headings (h2-h6 with ids, for the TOC), sections, tables,
references, hatnotes, figures. Dropped: page chrome, <style>/<script>/<link>,
navboxes (hidden on Wikipedia's mobile skin too), the Kiwix footer, Parsoid
data-* attributes, edit links. Internal links become /wiki/<Path> when the
target is selected, otherwise <span class="new"> (red-link style, no href).
"""
import re
from urllib.parse import quote, unquote
import html as htmlmod

from lxml import etree, html as lhtml

DROP_TAGS = {'style', 'script', 'link', 'meta', 'noscript'}
DROP_CLASSES = ('navbox', 'navbox-styles', 'mw-empty-elt', 'mw-editsection', 'noprint navigation-not-searchable')
REF_LIST_CLASSES = ('references', 'reflist', 'mw-references-wrap', 'refbegin')
KEEP_ATTRS = {'href', 'title', 'class', 'id', 'colspan', 'rowspan', 'scope', 'style', 'src', 'alt',
              'width', 'height', 'lang', 'dir', 'start', 'type', 'value', 'open', 'align', 'valign'}
WS = re.compile(r'\s+')


def wiki_href(path, frag=None):
    u = '/wiki/' + quote(path, safe="/:,()'!*@$;~")
    if frag:
        u += '#' + frag
    return u


def _cls(el):
    return el.get('class') or ''


def clean(raw, link_fn, img_fn):
    doc = lhtml.document_fromstring(raw)
    root = doc.get_element_by_id('mw-content-text', None)
    if root is None:
        root = doc.body
    # remove comments
    for c in root.xpath('.//comment()'):
        _drop(c)
    # drop tags
    for el in list(root.iter(*DROP_TAGS)):
        _drop(el)
    # first h1 (title) and kiwix footer
    for el in root.xpath('./h1[contains(@class,"section-heading")]'):
        _drop(el)
    for el in root.xpath('.//div[contains(., "This article is issued from")][a[contains(@href,"oldid=")]]'):
        par = el.getparent()
        _drop(el)
        if par is not None and par is not root and len(par) == 0 and not (par.text or '').strip():
            _drop(par)
    for el in list(root.iter('div', 'table', 'span')):
        c = _cls(el)
        if c and any(dc in c.split() or c == dc for dc in DROP_CLASSES):
            _drop(el)
        elif el.get('role') == 'navigation' and 'navbox' in c:
            _drop(el)
    # unwrap details/summary section wrappers, mf-section divs
    for el in list(root.iter('summary', 'details')):
        el.drop_tag()
    for el in list(root.xpath('.//div[starts-with(@id,"mf-section-")]')):
        el.drop_tag()
    # headings: keep id, strip classes
    sections = []
    for h in root.iter('h2', 'h3', 'h4', 'h5', 'h6'):
        hid = h.get('id')
        span = h.find('span[@class="mw-headline"]')
        if not hid and span is not None:
            hid = span.get('id')
        txt = WS.sub(' ', h.text_content()).strip()
        for a in list(h.attrib):
            del h.attrib[a]
        if hid:
            h.set('id', hid)
            sections.append((int(h.tag[1]), hid, txt))
    # links
    links = set()
    for a in list(root.iter('a')):
        href = a.get('href')
        if href is None:
            continue
        if href.startswith('#'):
            continue
        if href.startswith('http') or href.startswith('//') or href.startswith('mailto:'):
            a.set('rel', 'nofollow')
            continue
        if href.startswith('../'):
            # link to a media file page / other namespace; render as text
            _to_span(a, None)
            continue
        if href.startswith('./'):
            href = href[2:]
        path, _, frag = href.partition('#')
        path = unquote(htmlmod.unescape(path))
        tgt = link_fn(path)
        if tgt:
            a.set('href', wiki_href(tgt, frag or None))
            for k in list(a.attrib):
                if k not in ('href', 'title'):
                    del a.attrib[k]
            links.add(tgt)
        else:
            _to_span(a, 'new')
    # images
    images = []
    for img in list(root.iter('img')):
        src = img.get('src') or ''
        res = None
        if src.startswith('../I/'):
            zpath = unquote(src[5:])
            try:
                w = int(img.get('width') or 0)
                h = int(img.get('height') or 0)
            except ValueError:
                w = h = 0
            res = img_fn(zpath, w, h)
        if res:
            url, w, h = res
            alt = img.get('alt')
            for k in list(img.attrib):
                del img.attrib[k]
            img.set('src', url)
            if w:
                img.set('width', str(w))
                img.set('height', str(h))
            if alt:
                img.set('alt', alt)
            img.set('loading', 'lazy')
            images.append(url)
        else:
            par = img.getparent()
            # drop wrapping <a class="image"> too
            if par is not None and par.tag in ('a', 'span') and len(par) == 1 and not (par.text or '').strip():
                _drop(par)
            else:
                _drop(img)
    # attributes cleanup
    for el in root.iter():
        if not isinstance(el.tag, str):
            continue
        for k in list(el.attrib):
            if k not in KEEP_ATTRS:
                del el.attrib[k]
        i = el.get('id')
        if i and (i.startswith('mw') and len(i) <= 6):
            del el.attrib['id']
    infobox = bool(root.xpath('.//table[contains(@class,"infobox")]'))
    # plain text (no reference lists) and lead
    text, lead = _text(root)
    root.tag = 'div'
    for k in list(root.attrib):
        del root.attrib[k]
    root.set('class', 'mw-parser-output')
    out = etree.tostring(root, encoding='unicode', method='html')
    return dict(html=out, text=text, lead=lead, sections=sections, links=links, images=images, infobox=infobox)


def _to_span(a, cls):
    a.tag = 'span'
    title = a.get('title')
    for k in list(a.attrib):
        del a.attrib[k]
    if cls:
        a.set('class', cls)
    if title and cls:
        a.set('title', title + ' (page does not exist)')


def _drop(el):
    """Remove element, keeping its tail text."""
    par = el.getparent()
    if par is None:
        return
    tail = el.tail
    if tail:
        prev = el.getprevious()
        if prev is not None:
            prev.tail = (prev.tail or '') + tail
        else:
            par.text = (par.text or '') + tail
    par.remove(el)


def _text(root):
    skip = set()
    for el in root.iter('ol', 'div', 'table', 'sup', 'span'):
        c = _cls(el)
        if any(rc in c.split() for rc in REF_LIST_CLASSES) or 'mw-ref' in c.split():
            skip.add(el)
    parts = []

    def walk(el):
        if el in skip:
            if el.tail:
                parts.append(el.tail)
            return
        tag = el.tag if isinstance(el.tag, str) else ''
        block = tag in ('p', 'div', 'li', 'tr', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'ul', 'ol', 'dd', 'dt', 'br', 'figcaption', 'caption')
        if block:
            parts.append('\n')
        if el.text and tag:
            parts.append(el.text)
        for ch in el:
            walk(ch)
        if tag in ('td', 'th'):
            parts.append(' ')
        if block:
            parts.append('\n')
        if el.tail:
            parts.append(el.tail)

    walk(root)
    text = ''.join(parts)
    lines = [WS.sub(' ', ln).strip() for ln in text.split('\n')]
    text = '\n'.join(ln for ln in lines if ln)
    # lead: first real paragraph outside infobox/tables
    lead = ''
    for p in root.iter('p'):
        anc = p.getparent()
        bad = False
        while anc is not None:
            if anc.tag == 'table' or anc in skip:
                bad = True
                break
            anc = anc.getparent()
        if bad:
            continue
        t = WS.sub(' ', p.text_content()).strip()
        t = re.sub(r'\[\d+\]', '', t)
        if len(t) > 40:
            lead = t[:600]
            break
    return text, lead
