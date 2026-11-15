#!/usr/bin/env python3
"""Client assets for MapLibre GL, all served locally (no CDN at runtime):

  OUT/static/style.json                 OSM Bright (OpenMapTiles schema), URLs relative to the site root:
                                        tiles  /tiles/{z}/{x}/{y}.pbf, glyphs /glyphs/{fontstack}/{range}.pbf,
                                        sprite /sprites/sprite   (lib/tiles.js makes them absolute)
  OUT/static/glyphs/<fontstack>/*.pbf   Noto Sans Regular / Bold / Italic (SIL OFL 1.1)
  OUT/static/sprites/sprite{,@2x}.{json,png}

  python3 -I assets.py WORK/dl OUT/static
"""
import json, os, shutil, sys, zipfile

FONTS = ['Noto Sans Regular', 'Noto Sans Bold', 'Noto Sans Italic']
ATTRIBUTION = ('<a href="https://openmaptiles.org/" target="_blank">&copy; OpenMapTiles</a> '
               '<a href="https://www.openstreetmap.org/copyright" target="_blank">&copy; OpenStreetMap contributors</a>')


def main():
    dl, out = sys.argv[1], sys.argv[2]
    os.makedirs(out, exist_ok=True)
    # fonts
    with zipfile.ZipFile(os.path.join(dl, 'fonts-v2.0.zip')) as z:
        for n in z.namelist():
            top = n.split('/')[0]
            if top in FONTS and n.endswith('.pbf'):
                dest = os.path.join(out, 'glyphs', n)
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                with z.open(n) as src, open(dest, 'wb') as f:
                    shutil.copyfileobj(src, f)
    # style + sprites
    with zipfile.ZipFile(os.path.join(dl, 'osm-bright-v1.11.zip')) as z:
        os.makedirs(os.path.join(out, 'sprites'), exist_ok=True)
        for n in ['sprite.json', 'sprite.png', 'sprite@2x.json', 'sprite@2x.png']:
            with z.open(n) as src, open(os.path.join(out, 'sprites', n), 'wb') as f:
                shutil.copyfileobj(src, f)
        style = json.loads(z.read('style-local.json'))
    style['name'] = 'websandbox OSM Bright'
    style['sources'] = {'openmaptiles': {
        'type': 'vector', 'tiles': ['/tiles/{z}/{x}/{y}.pbf'], 'minzoom': 0, 'maxzoom': 14,
        'attribution': ATTRIBUTION}}
    style['glyphs'] = '/glyphs/{fontstack}/{range}.pbf'
    style['sprite'] = '/sprites/sprite'
    style['center'] = [-79.9436, 40.4443]
    style['zoom'] = 13
    style.pop('metadata', None)
    for l in style['layers']:
        f = l.get('layout', {}).get('text-font')
        if f:
            l['layout']['text-font'] = [x if x in FONTS else 'Noto Sans Regular' for x in f]
    with open(os.path.join(out, 'style.json'), 'w') as f:
        json.dump(style, f, separators=(',', ':'))
    n = sum(len(fs) for _, _, fs in os.walk(os.path.join(out, 'glyphs')))
    print(f'style.json ({len(style["layers"])} layers), {n} glyph ranges, sprites -> {out}')


if __name__ == '__main__':
    main()
