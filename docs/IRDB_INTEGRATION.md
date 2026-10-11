# irdb integration - v12

Source: https://github.com/probonopd/irdb
Branch: master
Runtime index: https://cdn.jsdelivr.net/gh/probonopd/irdb@master/codes/index
Runtime files: https://cdn.jsdelivr.net/gh/probonopd/irdb@master/codes/<manufacturer>/<devicetype>/<device>,<subdevice>.csv

The application treats irdb as a built-in source. The current upstream index is synchronized and CSV files can be stored in browser Cache Storage for offline use. `ensureIrdBOffline()` marks the cache complete only if every indexed file is cached without error.

Attribution remains visible in the UI and in `DB_LICENSES.md`.
