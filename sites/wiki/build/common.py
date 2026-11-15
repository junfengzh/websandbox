"""Shared paths and settings for the wiki build."""
import os

REPO = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..'))
# WIKI_ZIM: wikipedia_en_all_maxi_2022-05.zim (from the WebArena release; required for the ZIM steps)
ZIM = os.environ.get('WIKI_ZIM', '')
WORK = os.environ.get('WIKI_WORK', os.path.join(os.environ.get('WSB_WORK', os.path.join(REPO, 'work')), 'wiki'))
OUT = os.environ.get('WIKI_OUT', os.path.join(os.environ.get('WSB_DATA_ROOT', os.path.join(REPO, 'data')), 'wiki'))
TASKS = os.environ.get('WEBARENA_TASKS', os.path.join(REPO, '..', '3rd-party', 'webarena', 'config_files', 'test.raw.json'))
os.makedirs(WORK, exist_ok=True)
os.makedirs(OUT, exist_ok=True)
