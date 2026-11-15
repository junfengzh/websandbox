"""Minimal pure-Python ZIM reader (format v5/v6, old namespace scheme).

libzim's Python binding only offers random access by path/id, which over NFS
means one cluster decompression per lookup. This reader instead exposes the raw
structures so the build can stream clusters sequentially and read uncompressed
image blobs with a single seek.

Format reference: https://wiki.openzim.org/wiki/ZIM_file_format
"""
import struct

import zstandard

try:
    import lzma
except ImportError:  # pragma: no cover
    lzma = None

MAGIC = 72173914
REDIRECT = 0xFFFF
LINKTARGET = 0xFFFE
DELETED = 0xFFFD


class Zim:
    def __init__(self, path):
        self.path = path
        self.f = open(path, 'rb', buffering=0)
        h = self._read(0, 80)
        (magic, self.major, self.minor) = struct.unpack_from('<IHH', h, 0)
        if magic != MAGIC:
            raise ValueError('not a ZIM file')
        (self.entry_count, self.cluster_count, self.path_ptr_pos, self.title_ptr_pos,
         self.cluster_ptr_pos, self.mime_list_pos, self.main_page, self.layout_page,
         self.checksum_pos) = struct.unpack_from('<IIQQQQIIQ', h, 24)
        self.mimes = self._read_mimes()
        self._cluster_ptrs = None

    def _read(self, off, n):
        self.f.seek(off)
        out = bytearray()
        while len(out) < n:
            b = self.f.read(n - len(out))
            if not b:
                break
            out += b
        return bytes(out)

    def _read_mimes(self):
        data = self._read(self.mime_list_pos, 64 * 1024)
        mimes = []
        pos = 0
        while True:
            end = data.index(b'\0', pos)
            if end == pos:
                break
            mimes.append(data[pos:end].decode())
            pos = end + 1
        return mimes

    def path_ptrs(self):
        raw = self._read(self.path_ptr_pos, 8 * self.entry_count)
        return struct.unpack('<%dQ' % self.entry_count, raw)

    def cluster_ptrs(self):
        if self._cluster_ptrs is None:
            raw = self._read(self.cluster_ptr_pos, 8 * self.cluster_count)
            ptrs = list(struct.unpack('<%dQ' % self.cluster_count, raw))
            ptrs.append(self.checksum_pos)
            self._cluster_ptrs = ptrs
        return self._cluster_ptrs

    def iter_dirents(self, chunk=64 * 1024 * 1024):
        """Yield (index, mime_or_kind, ns, cluster_or_redirect, blob, path, title)
        for every entry in path order. Reads the dirent region in big chunks
        (dirents are written contiguously by libzim's creator)."""
        ptrs = self.path_ptrs()
        order = sorted(range(len(ptrs)), key=ptrs.__getitem__)
        # dirents are contiguous; read the whole span in chunks
        start = ptrs[order[0]]
        buf = b''
        buf_off = start
        for idx in order:
            off = ptrs[idx]
            rel = off - buf_off
            if rel < 0 or rel + 4096 > len(buf):
                buf = self._read(off, chunk)
                buf_off = off
                rel = 0
            yield (idx,) + parse_dirent(buf, rel)

    def read_cluster_raw(self, cnum):
        p = self.cluster_ptrs()
        return self._read(p[cnum], p[cnum + 1] - p[cnum])

    def blob_direct(self, cnum, bnum):
        """Read one blob from an UNCOMPRESSED cluster without reading it all."""
        p = self.cluster_ptrs()
        base = p[cnum]
        info = self._read(base, 1)[0]
        comp = info & 0x0F
        ext = bool(info & 0x10)
        if comp not in (0, 1):
            blobs = decode_cluster(self.read_cluster_raw(cnum))
            return blobs[bnum]
        osz = 8 if ext else 4
        fmt = '<2Q' if ext else '<2I'
        a, b = struct.unpack(fmt, self._read(base + 1 + osz * bnum, 2 * osz))
        return self._read(base + 1 + a, b - a)


def parse_dirent(buf, pos):
    mime, plen, ns = struct.unpack_from('<HBc', buf, pos)
    ns = ns.decode('latin1')
    if mime == REDIRECT:
        (target,) = struct.unpack_from('<I', buf, pos + 8)
        p = pos + 12
        cl, bl = target, None
    elif mime in (LINKTARGET, DELETED):
        p = pos + 8
        cl, bl = None, None
    else:
        cl, bl = struct.unpack_from('<II', buf, pos + 8)
        p = pos + 16
    e = buf.index(b'\0', p)
    path = buf[p:e].decode('utf-8', 'replace')
    e2 = buf.index(b'\0', e + 1)
    title = buf[e + 1:e2].decode('utf-8', 'replace')
    return (mime, ns, cl, bl, path, title or path)


_zd = zstandard.ZstdDecompressor()


def decode_cluster(raw):
    """Return list of blobs (bytes) of a cluster given its raw bytes."""
    info = raw[0]
    comp = info & 0x0F
    ext = bool(info & 0x10)
    body = raw[1:]
    if comp in (0, 1):
        data = body
    elif comp == 5:
        data = _zd.decompressobj().decompress(body)
    elif comp == 4:
        data = lzma.decompress(body)
    else:
        raise ValueError('unsupported cluster compression %d' % comp)
    osz = 8 if ext else 4
    fmt = '<Q' if ext else '<I'
    (first,) = struct.unpack_from(fmt, data, 0)
    n = first // osz
    offs = struct.unpack_from('<%d%s' % (n, fmt[1]), data, 0)
    return [data[offs[i]:offs[i + 1]] for i in range(n - 1)]


def cluster_compression(raw_first_byte):
    return raw_first_byte & 0x0F
