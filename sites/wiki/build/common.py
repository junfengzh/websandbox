"""Shared paths and settings for the wiki build."""
import os

ZIM = os.environ.get('WIKI_ZIM', '$WEBARENA_SRC/wikipedia_en_all_maxi_2022-05.zim')
WORK = os.environ.get('WIKI_WORK', '$WSB_WORK/wiki')
OUT = os.environ.get('WIKI_OUT', '$WSB_DATA_ROOT/wiki')
TASKS = os.environ.get('WEBARENA_TASKS', '$WEBARENA_TASKS')
os.makedirs(WORK, exist_ok=True)
os.makedirs(OUT, exist_ok=True)
