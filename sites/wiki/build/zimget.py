"""Random access to ZIM articles/images through work/dirents.db + zimraw.

Usage as a CLI (for inspection):  python -I zimget.py "Christopher_Nolan" [out.html]
"""
import os
import sqlite3
import sys
from collections import OrderedDict

sys.path.insert(0, os.path.dirname(__file__))
import zimraw  # noqa: E402
from common import ZIM, WORK  # noqa: E402


class ZimGet:
    def __init__(self, cache=64):
        self.z = zimraw.Zim(ZIM)
        self.db = sqlite3.connect(os.path.join(WORK, 'dirents.db'))
        self.cache = OrderedDict()
        self.cache_n = cache

    def resolve(self, path, hops=8):
        """path (without 'A/') -> (id, path, title) of the content article, or None."""
        r = self.db.execute('select id, path, title, redir from art where path=?', (path,)).fetchone()
        while r and r[3] is not None and hops > 0:
            r = self.db.execute('select id, path, title, redir from art where id=?', (r[3],)).fetchone()
            hops -= 1
        if not r or r[3] is not None:
            return None
        return r[:3]

    def cluster(self, cl):
        if cl in self.cache:
            self.cache.move_to_end(cl)
            return self.cache[cl]
        blobs = zimraw.decode_cluster(self.z.read_cluster_raw(cl))
        self.cache[cl] = blobs
        if len(self.cache) > self.cache_n:
            self.cache.popitem(last=False)
        return blobs

    def html_by_id(self, aid):
        cl, bl = self.db.execute('select cl, bl from art where id=?', (aid,)).fetchone()
        return self.cluster(cl)[bl]

    def html(self, path):
        r = self.resolve(path)
        return None if r is None else self.html_by_id(r[0])

    def image(self, path):
        r = self.db.execute('select cl, bl from img where path=?', (path,)).fetchone()
        if not r:
            return None
        return self.z.blob_direct(r[0], r[1])


if __name__ == '__main__':
    g = ZimGet()
    r = g.resolve(sys.argv[1])
    print(r)
    if r and len(sys.argv) > 2:
        open(sys.argv[2], 'wb').write(g.html_by_id(r[0]))
