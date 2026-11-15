"""Shrink scraped Amazon product-description HTML without losing visible text.

- drops <script>, <style>, <noscript>, <iframe>, <svg>, <img>, <video>, <button>, <input>, <form> and HTML comments;
- keeps a small tag whitelist (structure, lists, tables, emphasis); other tags are unwrapped;
- drops every attribute except colspan/rowspan;
- removes elements left empty, collapses whitespace, unescapes nothing it does not need to.
Also extracts the product-details fields (Brand / Manufacturer ...) as a dict.
"""
import html
import re
from html.parser import HTMLParser

KEEP = {'div', 'p', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'table', 'thead', 'tbody',
        'tr', 'th', 'td', 'b', 'strong', 'i', 'em', 'span', 'hr', 'dl', 'dt', 'dd', 'sup', 'sub'}
DROP_CONTENT = {'script', 'style', 'noscript', 'iframe', 'svg', 'template', 'button', 'select', 'textarea', 'form'}
VOID = {'br', 'hr', 'img', 'input', 'meta', 'link', 'source', 'wbr', 'area', 'col', 'embed', 'param', 'track'}
ATTRS = {'colspan', 'rowspan'}
BLOCK_EMPTY_OK = {'br', 'hr', 'td', 'th'}


class _Cleaner(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=False)
        self.out = []
        self.stack = []      # (tag, out_index_at_open, kept)
        self.skip = 0

    def handle_starttag(self, tag, attrs):
        if self.skip:
            if tag in DROP_CONTENT:
                self.skip += 1
            return
        if tag in DROP_CONTENT:
            self.skip = 1
            return
        if tag in VOID:
            if tag in KEEP:
                self.out.append('<%s>' % tag)
            return
        kept = tag in KEEP
        self.stack.append((tag, len(self.out), kept))
        if kept:
            a = ''.join(' %s="%s"' % (k, html.escape(v or '', quote=True)) for k, v in attrs if k in ATTRS)
            self.out.append('<%s%s>' % (tag, a))

    def handle_startendtag(self, tag, attrs):
        if not self.skip and tag in KEEP and tag in VOID:
            self.out.append('<%s>' % tag)

    def handle_endtag(self, tag):
        if self.skip:
            if tag in DROP_CONTENT:
                self.skip -= 1
            return
        if tag in VOID:
            return
        # close up to the matching open tag
        for i in range(len(self.stack) - 1, -1, -1):
            if self.stack[i][0] == tag:
                while len(self.stack) > i:
                    t, idx, kept = self.stack.pop()
                    if kept:
                        inner = ''.join(self.out[idx + 1:])
                        if t not in BLOCK_EMPTY_OK and not re.sub(r'<br>|\s|&nbsp;|‎|‏', '', inner):
                            del self.out[idx:]          # empty element
                            if inner.strip():
                                self.out.append(' ')
                        else:
                            self.out.append('</%s>' % t)
                return

    def handle_data(self, data):
        if not self.skip:
            self.out.append(html.escape(html.unescape(data), quote=False))

    def handle_entityref(self, name):
        if not self.skip:
            self.out.append('&%s;' % name)

    def handle_charref(self, name):
        if not self.skip:
            self.out.append('&#%s;' % name)

    def result(self):
        while self.stack:
            t, idx, kept = self.stack.pop()
            if kept:
                self.out.append('</%s>' % t)
        s = ''.join(self.out)
        s = re.sub(r'[ \t\r\f\v]*\n[\s]*', '\n', s)
        s = re.sub(r'[ \t\r\f\v]{2,}', ' ', s)
        s = re.sub(r'>\s+<', '><', s)
        # unwrap div/span chains that carry no attributes and only wrap one element
        for _ in range(3):
            s2 = re.sub(r'<span>([^<]*)</span>', r'\1', s)
            s2 = re.sub(r'<div>(<div>.*?</div>)</div>', r'\1', s2)
            if s2 == s:
                break
            s = s2
        return s.strip()


def clean(s):
    if not s or '<' not in s:
        return s
    p = _Cleaner()
    try:
        p.feed(s)
        p.close()
    except Exception:
        return s
    return p.result()


_MARKS = '\u200e\u200f\xa0 :\n\t'
_ROW = re.compile(r'<tr><t[hd]>((?:(?!</t[hd]>).)*?)</t[hd]><td>((?:(?!</td>).)*?)</td></tr>', re.S)
_LI = re.compile(r'<li>([^<>]{1,60}?)\s*[\u200e\u200f]*\s*:\s*[\u200e\u200f]*\s*([^<>]{1,200})</li>', re.S)


def text(s):
    if not s:
        return ''
    t = re.sub(r'<[^>]+>', ' ', s)
    return re.sub(r'\s+', ' ', html.unescape(t)).strip()


def details(cleaned):
    """Product-detail key/value pairs from the cleaned description (tables and 'Key : Value' bullets)."""
    out = {}
    for rx in (_ROW, _LI):
        for m in rx.finditer(cleaned or ''):
            k = text(m.group(1)).strip(_MARKS)
            v = text(m.group(2)).strip(_MARKS)
            if k and v and len(k) <= 60 and k not in out:
                out[k] = v
    return out


def brand(det):
    for k in ('Brand', 'Brand Name', 'Manufacturer'):
        v = det.get(k)
        if v and len(v) <= 60:
            return v
    return None


def clean_one(args):
    pid, s = args
    c = clean(s)
    d = details(c)
    return pid, c, brand(d), d
