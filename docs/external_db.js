(() => {
  'use strict';

  const FLIPPER = {
    id: 'flipper-official',
    name: 'FlipperDevices IRDB ufficiale',
    license: 'MIT',
    indexUrl: 'https://data.jsdelivr.com/v1/packages/gh/flipperdevices/IRDB@dev?structure=flat',
    githubTreeUrl: 'https://api.github.com/repos/flipperdevices/IRDB/git/trees/dev?recursive=1',
    baseUrl: 'https://cdn.jsdelivr.net/gh/flipperdevices/IRDB@dev'
  };

  const IRDB = {
    id: 'probonopd-irdb',
    name: 'irdb di Simon Peter e contributori',
    license: 'custom',
    indexUrl: 'https://cdn.jsdelivr.net/gh/probonopd/irdb@master/codes/index',
    baseUrl: 'https://cdn.jsdelivr.net/gh/probonopd/irdb@master/codes/'
  };

  const FLIPPER_INDEX_KEY = 'irRemoteLab.flipperIndex.v2';
  const IRDB_INDEX_KEY = 'irRemoteLab.irdbIndex.v1';
  const CACHE_NAME = 'ir-remote-lab-db-v2';
  const IRDB_OFFLINE_KEY = 'irRemoteLab.irdbOfflineComplete.v1';

  let flipperCatalog = null;
  let irdbCatalog = null;
  const sourceErrors = { flipper: null, irdb: null };

  function nowIso() { return new Date().toISOString(); }
  function clean(value) { return String(value || '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim(); }
  function safeDecode(value) { try { return decodeURIComponent(value); } catch { return value; } }
  function normalize(value) { return clean(String(value || '').replace(/^\uFEFF/, '')).toLowerCase(); }

  function loadJson(key) {
    try { return JSON.parse(localStorage.getItem(key) || 'null'); }
    catch { return null; }
  }

  function saveJson(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch { return false; }
  }

  function flipperCategoryToType(category) {
    const c = normalize(category).replace(/[^a-z0-9]+/g, '');
    const map = {
      tvs: 'tv', television: 'tv', televisions: 'tv',
      dvd: 'dvd', dvds: 'dvd', bluray: 'dvd', blurayplayers: 'dvd', vcr: 'dvd',
      soundbars: 'audio', speakers: 'audio', audio: 'audio', receivers: 'audio', amplifiers: 'audio',
      streamingdevices: 'stb', tvtuner: 'stb', stb: 'stb', settopboxes: 'stb',
      projectors: 'projector', projector: 'projector',
      airconditioners: 'ac', acs: 'ac', airpurifiers: 'purifier',
      fans: 'fan', fan: 'fan',
      cameras: 'camera', camera: 'camera',
      consoles: 'console', gameconsoles: 'console',
      vacuumcleaners: 'vacuum',
      toys: 'toy',
      lights: 'light', ledlights: 'light',
      heaters: 'heater',
      monitors: 'monitor',
      whiteboards: 'display', touchscreendisplays: 'display'
    };
    return map[c] || 'unknown';
  }

  function irdbTypeToType(type) {
    const t = normalize(type);
    if (t.includes('tv') || t.includes('television')) return 'tv';
    if (t.includes('dvd') || t.includes('blu') || t.includes('vcr') || t.includes('laser disc')) return 'dvd';
    if (t.includes('receiver') || t.includes('amplifier') || t.includes('audio') || t.includes('speaker') || t.includes('soundbar') || t.includes('cd player')) return 'audio';
    if (t.includes('sat') || t.includes('tuner') || t.includes('set-top') || t.includes('cable') || t.includes('media')) return 'stb';
    if (t.includes('projector')) return 'projector';
    if (t.includes('air conditioner')) return 'ac';
    if (t.includes('fan')) return 'fan';
    if (t.includes('camera')) return 'camera';
    if (t.includes('game console')) return 'console';
    if (t.includes('humidifier') || t.includes('purifier')) return 'purifier';
    return 'unknown';
  }

  function parseFlipperPath(path) {
    const p = safeDecode(path).replace(/^\//, '');
    if (!p.startsWith('database/categories/') || !p.endsWith('.ir')) return null;
    const parts = p.split('/');
    if (parts.length < 6 || parts.some(x => x === '.meta')) return null;
    const category = clean(parts[2]);
    const brand = clean(parts[3]);
    const modelFolder = clean(parts[4]);
    const fileName = clean(parts[parts.length - 1].replace(/\.ir$/i, ''));
    const model = modelFolder || fileName;
    return {
      source: FLIPPER.id,
      sourceName: FLIPPER.name,
      license: FLIPPER.license,
      id: `flipper:${p}`,
      path: `/${p}`,
      category,
      deviceType: flipperCategoryToType(category),
      brand,
      model,
      fileName
    };
  }

  function parseIrdBPath(path) {
    const p = safeDecode(String(path || '').trim()).replace(/^\/+/, '');
    if (!p || !p.endsWith('.csv')) return null;
    const parts = p.split('/');
    if (parts.length < 3) return null;
    const brand = clean(parts[0]);
    const typeName = clean(parts[1]);
    const file = parts.slice(2).join('/');
    const ds = file.replace(/\.csv$/i, '');
    return {
      source: IRDB.id,
      sourceName: IRDB.name,
      license: IRDB.license,
      id: `irdb:${p}`,
      path: p,
      category: typeName,
      deviceType: irdbTypeToType(typeName),
      brand,
      model: `${typeName} ${ds}`,
      deviceSubdevice: ds
    };
  }

  async function fetchTextCached(url) {
    if ('caches' in window) {
      const cache = await caches.open(CACHE_NAME);
      const hit = await cache.match(url);
      if (hit) return hit.text();
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status} per ${url}`);
      await cache.put(url, response.clone());
      return response.text();
    }
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status} per ${url}`);
    return response.text();
  }

  async function syncFlipper(force = false) {
    if (!force && flipperCatalog?.length) return flipperCatalog;
    const cached = loadJson(FLIPPER_INDEX_KEY);
    if (!force && cached?.items?.length) {
      flipperCatalog = cached.items;
      sourceErrors.flipper = null;
      return flipperCatalog;
    }

    let primaryError = null;
    try {
      const response = await fetch(FLIPPER.indexUrl, { cache: 'no-store' });
      if (!response.ok) throw new Error(`jsDelivr HTTP ${response.status}`);
      const payload = await response.json();
      const files = Array.isArray(payload.files) ? payload.files : [];
      const items = files.map(f => parseFlipperPath(f.name || f.path || '')).filter(Boolean);
      if (items.length) {
        flipperCatalog = items;
        sourceErrors.flipper = null;
        saveJson(FLIPPER_INDEX_KEY, { syncedAt: nowIso(), items, indexSource: 'jsdelivr' });
        return items;
      }
      primaryError = new Error('jsDelivr: indice senza file .ir riconoscibili');
    } catch (error) {
      primaryError = error;
    }

    // The jsDelivr package metadata endpoint returns 403 for very large GitHub
    // repositories. Fall back to GitHub's recursive tree API for the file list;
    // actual .ir content still comes from the CDN one file at a time.
    try {
      const response = await fetch(FLIPPER.githubTreeUrl, {
        cache: 'no-store',
        headers: { Accept: 'application/vnd.github+json' }
      });
      if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`);
      const payload = await response.json();
      const files = Array.isArray(payload.tree) ? payload.tree.filter(x => x.type === 'blob').map(x => x.path || '') : [];
      const items = files.map(parseFlipperPath).filter(Boolean);
      if (!items.length) throw new Error('GitHub: indice senza file .ir riconoscibili');
      flipperCatalog = items;
      sourceErrors.flipper = payload.truncated ? 'Indice Flipper GitHub ricevuto in forma parziale (tree truncated).' : null;
      saveJson(FLIPPER_INDEX_KEY, { syncedAt: nowIso(), items, indexSource: 'github-tree', truncated: !!payload.truncated });
      return items;
    } catch (fallbackError) {
      sourceErrors.flipper = `Indice Flipper non disponibile: ${primaryError?.message || 'errore jsDelivr'}; ${fallbackError.message}`;
      if (cached?.items?.length) {
        flipperCatalog = cached.items;
        return flipperCatalog;
      }
      flipperCatalog = [];
      return flipperCatalog;
    }
  }

  // v11: irdb is part of the product by default. The user confirmed the license obligations are handled.
  function isIrdBAcknowledged() { return true; }
  function setIrdBAcknowledged(_value) { /* retained for backward compatibility */ }

  async function syncIrdB(force = false) {
    if (!force && irdbCatalog?.length) return irdbCatalog;
    const cached = loadJson(IRDB_INDEX_KEY);
    if (!force && cached?.items?.length) {
      irdbCatalog = cached.items;
      sourceErrors.irdb = null;
      return irdbCatalog;
    }
    try {
      const text = await fetchTextCached(IRDB.indexUrl);
      const items = text.split(/\r?\n/).map(parseIrdBPath).filter(Boolean);
      if (!items.length) throw new Error('indice ricevuto ma vuoto');
      irdbCatalog = items;
      sourceErrors.irdb = null;
      saveJson(IRDB_INDEX_KEY, { syncedAt: nowIso(), items });
      return items;
    } catch (error) {
      sourceErrors.irdb = `Indice irdb non disponibile: ${error.message}`;
      if (cached?.items?.length) {
        irdbCatalog = cached.items;
        return irdbCatalog;
      }
      irdbCatalog = [];
      return irdbCatalog;
    }
  }

  async function sync(options = {}) {
    const result = { flipper: 0, irdb: 0, errors: {} };
    const [flipper, irdb] = await Promise.all([
      syncFlipper(!!options.force),
      options.includeIrdB === false ? Promise.resolve([]) : syncIrdB(!!options.force)
    ]);
    result.flipper = flipper.length;
    result.irdb = irdb.length;
    if (sourceErrors.flipper) result.errors.flipper = sourceErrors.flipper;
    if (sourceErrors.irdb) result.errors.irdb = sourceErrors.irdb;
    return result;
  }

  function matchEntry(entry, filters) {
    const type = filters.deviceType || 'unknown';
    const brand = normalize(filters.brand);
    const model = normalize(filters.model);
    if (type !== 'unknown' && entry.deviceType !== type) return false;
    if (brand && !normalize(entry.brand).includes(brand)) return false;
    if (model && !(`${normalize(entry.model)} ${normalize(entry.fileName || '')}`).includes(model)) return false;
    return true;
  }

  async function search(filters = {}) {
    const limit = Math.max(1, Math.min(1000, Number(filters.limit) || 100));
    const results = [];
    const sources = await Promise.all([
      syncFlipper(false),
      filters.includeIrdB === false ? Promise.resolve([]) : syncIrdB(false)
    ]);
    for (const catalog of sources) {
      for (const entry of catalog) {
        if (matchEntry(entry, filters)) results.push(entry);
        if (results.length >= limit) return results;
      }
    }
    return results;
  }

  function parseHexBytes(value) {
    return String(value || '').trim().split(/\s+/).filter(Boolean).map(x => parseInt(x, 16)).filter(Number.isFinite);
  }

  function parseFlipperIr(text) {
    const lines = String(text || '').split(/\r?\n/);
    const blocks = [];
    let current = null;
    for (const sourceLine of lines) {
      const line = sourceLine.trim();
      if (!line || /^Filetype:/i.test(line) || /^Version:/i.test(line)) continue;
      if (line === '#') {
        if (current?.name) blocks.push(current);
        current = null;
        continue;
      }
      if (line.startsWith('#')) continue;
      const m = line.match(/^([^:]+):\s*(.*)$/);
      if (!m) continue;
      if (!current) current = {};
      current[m[1].trim().toLowerCase()] = m[2].trim();
    }
    if (current?.name) blocks.push(current);
    return blocks.map((b, index) => {
      const type = normalize(b.type);
      if (type === 'raw') {
        const raw = String(b.data || '').split(/\s+/).filter(Boolean).map(Number).filter(Number.isFinite);
        return {
          id: `sig_${index}`,
          name: b.name || `Button ${index + 1}`,
          signal: { protocol: 'RAW', carrierHz: Number(b.frequency) || 38000, raw, sourceEncoding: 'FLIPPER_RAW' }
        };
      }
      if (type === 'parsed') {
        return {
          id: `sig_${index}`,
          name: b.name || `Button ${index + 1}`,
          signal: {
            protocol: 'FLIPPER_PARSED',
            carrierHz: 38000,
            parsed: {
              protocol: b.protocol || '',
              address: parseHexBytes(b.address),
              command: parseHexBytes(b.command)
            },
            sourceEncoding: 'FLIPPER_PARSED'
          }
        };
      }
      return null;
    }).filter(Boolean);
  }

  function parseCsvLine(line) {
    const out = [];
    let value = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        if (quoted && line[i + 1] === '"') { value += '"'; i++; }
        else quoted = !quoted;
      } else if (c === ',' && !quoted) { out.push(value); value = ''; }
      else value += c;
    }
    out.push(value);
    return out.map(x => x.trim());
  }

  function parseIrdBCsv(text) {
    const lines = String(text || '').split(/\r?\n/).filter(x => x.trim());
    if (!lines.length) return [];
    const header = parseCsvLine(lines[0]).map(normalize);
    const ix = name => header.indexOf(name);
    const out = [];
    for (let i = 1; i < lines.length; i++) {
      const row = parseCsvLine(lines[i]);
      if (!row.length) continue;
      const functionName = row[ix('functionname')] || `Function ${i}`;
      const protocol = row[ix('protocol')] || '';
      const device = Number(row[ix('device')]);
      const subdevice = Number(row[ix('subdevice')]);
      const fn = Number(row[ix('function')]);
      out.push({
        id: `sig_${i}`,
        name: functionName,
        signal: {
          protocol: 'IRDB_PDF',
          carrierHz: 38000,
          parsed: { protocol, device, subdevice, function: fn },
          sourceEncoding: 'IRDB_PDF'
        }
      });
    }
    return out;
  }

  async function loadRemote(meta) {
    if (meta.source === FLIPPER.id) {
      const text = await fetchTextCached(`${FLIPPER.baseUrl}${meta.path}`);
      const buttons = parseFlipperIr(text);
      return { ...meta, buttons, sourceTextType: 'flipper-ir' };
    }
    if (meta.source === IRDB.id) {
      const text = await fetchTextCached(`${IRDB.baseUrl}${meta.path.split('/').map(encodeURIComponent).join('/')}`);
      const buttons = parseIrdBCsv(text);
      return { ...meta, buttons, sourceTextType: 'irdb-csv' };
    }
    throw new Error('Sorgente database sconosciuta.');
  }

  function bitArray(value, count, lsbFirst = true) {
    const bits = [];
    for (let i = 0; i < count; i++) bits.push((value >> (lsbFirst ? i : (count - 1 - i))) & 1);
    return bits;
  }

  function bytesToValueLE(bytes) {
    let v = 0;
    for (let i = 0; i < Math.min(4, bytes.length); i++) v |= (bytes[i] & 0xFF) << (8 * i);
    return v >>> 0;
  }

  function pulseDistanceRaw(headerMark, headerSpace, mark, zeroSpace, oneSpace, bytes) {
    const raw = [headerMark, headerSpace];
    for (const byte of bytes) {
      for (let b = 0; b < 8; b++) {
        raw.push(mark, (byte & (1 << b)) ? oneSpace : zeroSpace);
      }
    }
    raw.push(mark);
    return raw;
  }

  function sonyRaw(bits, bitCount) {
    const raw = [2400, 600];
    for (let i = 0; i < bitCount; i++) raw.push(((bits >> i) & 1) ? 1200 : 600, 600);
    if (raw.length && raw.length % 2 === 0) raw.pop();
    return raw;
  }

  function rc5Raw(address, command) {
    // RC5: 14 Manchester bits, half-bit 889 us, 36 kHz. Start bits=11,
    // toggle=0. Encode transitions as alternating mark/space durations.
    const bits = [1, 1, 0, ...bitArray(address & 0x1F, 5, false), ...bitArray(command & 0x3F, 6, false)];
    const levels = [];
    // RC5 bit: 1 = space/mark, 0 = mark/space. We invert logical level so the
    // first emitted segment can be a mark when required by the actual sequence.
    for (const bit of bits) levels.push(bit ? 0 : 1, bit ? 1 : 0);
    return levelsToRaw(levels, 889);
  }

  function levelsToRaw(levels, unitUs) {
    if (!levels.length) return [];
    const segments = [];
    let last = levels[0], count = 1;
    for (let i = 1; i < levels.length; i++) {
      if (levels[i] === last) count++;
      else { segments.push({ level: last, us: count * unitUs }); last = levels[i]; count = 1; }
    }
    segments.push({ level: last, us: count * unitUs });
    // Our Arduino sender starts from the first emitted MARK. An initial RC5
    // SPACE is just idle before the first carrier burst, so do not invent a
    // 1 us MARK (that would alter the Manchester waveform). Drop only that
    // leading idle segment; preserve every following transition exactly.
    if (segments[0].level === 0) segments.shift();
    return segments.map(s => Math.round(s.us));
  }

  function flipperParsedToRaw(signal) {
    const p = signal?.parsed || {};
    const protocol = String(p.protocol || '').trim().toUpperCase();
    const a = Array.isArray(p.address) ? p.address : [];
    const c = Array.isArray(p.command) ? p.command : [];

    if (protocol === 'NEC') {
      const address = a[0] || 0;
      const command = c[0] || 0;
      return { protocol: 'RAW', carrierHz: 38000, raw: pulseDistanceRaw(9000, 4500, 560, 560, 1690, [address, (~address) & 0xFF, command, (~command) & 0xFF]), sourceEncoding: 'FLIPPER_NEC' };
    }
    if (protocol === 'NECEXT') {
      const bytes = [a[0] || 0, a[1] || 0, c[0] || 0, c[1] != null ? c[1] : ((~(c[0] || 0)) & 0xFF)];
      return { protocol: 'RAW', carrierHz: 38000, raw: pulseDistanceRaw(9000, 4500, 560, 560, 1690, bytes), sourceEncoding: 'FLIPPER_NECEXT' };
    }
    // NEC42 / NEC42ext are genuine 42-bit variants. They must not be reduced to
    // a 32-bit NECext frame. Keep the parsed entry in the database and ask the
    // user to learn that button as RAW until a verified 42-bit encoder is added.
    if (protocol === 'NEC42' || protocol === 'NEC42EXT') return null;
    if (protocol === 'SAMSUNG32') {
      const address0 = a[0] || 0;
      const address1 = a[1] || address0;
      const command = c[0] || 0;
      return { protocol: 'RAW', carrierHz: 38000, raw: pulseDistanceRaw(4500, 4500, 560, 560, 1690, [address0, address1, command, (~command) & 0xFF]), sourceEncoding: 'FLIPPER_SAMSUNG32' };
    }
    if (protocol === 'SIRC' || protocol === 'SIRC15' || protocol === 'SIRC20') {
      const bitCount = protocol === 'SIRC15' ? 15 : protocol === 'SIRC20' ? 20 : 12;
      const command = c[0] & 0x7F;
      const addressValue = bytesToValueLE(a);
      let payload = command | (addressValue << 7);
      return { protocol: 'RAW', carrierHz: 40000, raw: sonyRaw(payload, bitCount), sourceEncoding: `FLIPPER_${protocol}` };
    }
    if (protocol === 'RC5') {
      return { protocol: 'RAW', carrierHz: 36000, raw: rc5Raw(a[0] || 0, c[0] || 0), sourceEncoding: 'FLIPPER_RC5' };
    }

    return null;
  }

  function irdbPdfToRaw(signal) {
    const p = signal?.parsed || {};
    const name = String(p.protocol || '').toUpperCase();
    const device = Number(p.device) || 0;
    const subdevice = Number(p.subdevice);
    const fn = Number(p.function) || 0;
    if (name.startsWith('NEC') && !name.includes('42')) {
      if (Number.isFinite(subdevice) && subdevice >= 0) {
        return { protocol: 'RAW', carrierHz: 38000, raw: pulseDistanceRaw(9000, 4500, 560, 560, 1690, [device & 0xFF, subdevice & 0xFF, fn & 0xFF, (~fn) & 0xFF]), sourceEncoding: `IRDB_${p.protocol}` };
      }
      return { protocol: 'RAW', carrierHz: 38000, raw: pulseDistanceRaw(9000, 4500, 560, 560, 1690, [device & 0xFF, (~device) & 0xFF, fn & 0xFF, (~fn) & 0xFF]), sourceEncoding: `IRDB_${p.protocol}` };
    }
    if (name.startsWith('SAMSUNG')) {
      const s = Number.isFinite(subdevice) && subdevice >= 0 ? subdevice : device;
      return { protocol: 'RAW', carrierHz: 38000, raw: pulseDistanceRaw(4500, 4500, 560, 560, 1690, [device & 0xFF, s & 0xFF, fn & 0xFF, (~fn) & 0xFF]), sourceEncoding: `IRDB_${p.protocol}` };
    }
    if (name.startsWith('SONY')) {
      const m = name.match(/(12|15|20)/);
      const bitCount = m ? Number(m[1]) : 12;
      const payload = (fn & 0x7F) | ((device & 0x1FFF) << 7);
      return { protocol: 'RAW', carrierHz: 40000, raw: sonyRaw(payload, bitCount), sourceEncoding: `IRDB_${p.protocol}` };
    }
    if (name === 'RC5' || name.startsWith('RC5')) {
      return { protocol: 'RAW', carrierHz: 36000, raw: rc5Raw(device, fn), sourceEncoding: `IRDB_${p.protocol}` };
    }
    return null;
  }

  function synthesisSupport(signal) {
    if (!signal) return { supported: false, reason: 'Segnale mancante' };
    if (signal.protocol === 'RAW') return { supported: true, mode: 'raw' };
    if (signal.protocol === 'FLIPPER_PARSED') {
      const name = String(signal.parsed?.protocol || '').trim().toUpperCase();
      const supported = new Set(['NEC', 'NECEXT', 'SAMSUNG32', 'SIRC', 'SIRC15', 'SIRC20', 'RC5']);
      if (supported.has(name)) return { supported: true, mode: 'synthesized', protocol: name };
      return { supported: false, protocol: name, reason: `Protocollo ${name || 'sconosciuto'} presente nel DB ma non ancora sintetizzato in modo verificato` };
    }
    if (signal.protocol === 'IRDB_PDF') {
      const name = String(signal.parsed?.protocol || '').trim().toUpperCase();
      if (name.startsWith('NEC') && !name.includes('42')) return { supported: true, mode: 'synthesized', protocol: name };
      if (name.startsWith('SAMSUNG') || name.startsWith('SONY') || name.startsWith('RC5')) return { supported: true, mode: 'synthesized', protocol: name };
      return { supported: false, protocol: name, reason: `Protocollo ${name || 'sconosciuto'} presente nel DB ma non ancora sintetizzato in modo verificato` };
    }
    return { supported: false, reason: `Formato ${signal.protocol || 'sconosciuto'} non supportato` };
  }

  function toRaw(signal) {
    if (!signal) return null;
    if (signal.protocol === 'RAW') return signal;
    if (signal.protocol === 'FLIPPER_PARSED') return flipperParsedToRaw(signal);
    if (signal.protocol === 'IRDB_PDF') return irdbPdfToRaw(signal);
    return null;
  }

  function canonicalButtonId(name, used) {
    const n = normalize(name);
    const map = [
      [/power|on\/off|standby/, 'power'], [/vol(ume)?[ _+]|vol_up|volume up/, 'vol_up'], [/vol(ume)?[ _-]|vol_dn|volume down/, 'vol_down'],
      [/ch(annel)?[ _+]|ch_next|channel up/, 'ch_up'], [/ch(annel)?[ _-]|ch_prev|channel down/, 'ch_down'], [/mute/, 'mute'],
      [/^up$|arrow up/, 'up'], [/^down$|arrow down/, 'down'], [/^left$|arrow left/, 'left'], [/^right$|arrow right/, 'right'],
      [/enter|^ok$|select/, 'ok'], [/home/, 'home'], [/back|return/, 'back'], [/menu/, 'menu'], [/input|source/, 'input'],
      [/play/, 'play'], [/pause/, 'pause'], [/stop/, 'stop'], [/next|skip next/, 'next'], [/prev|previous|skip prev/, 'prev'], [/eject|open close/, 'eject']
    ];
    for (const [re, id] of map) {
      if (re.test(n) && !used.has(id)) { used.add(id); return id; }
    }
    const digit = n.match(/(?:^|\D)([0-9])(?:$|\D)/);
    if (digit && !used.has(`key_${digit[1]}`)) { const id = `key_${digit[1]}`; used.add(id); return id; }
    let id = n.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'key';
    if (!/^[a-z]/.test(id)) id = `key_${id}`;
    let base = id, i = 2;
    while (used.has(id)) id = `${base}_${i++}`;
    used.add(id);
    return id;
  }

  function remoteToAppDefinition(remote, patternId = null) {
    const used = new Set();
    const buttons = remote.buttons.map(item => ({ ...item, buttonId: canonicalButtonId(item.name, used) }));
    const power = buttons.find(x => x.buttonId === 'power');
    return {
      schema: 'external-remote-v1',
      source: remote.source,
      sourceName: remote.sourceName,
      sourceId: remote.id,
      license: remote.license,
      deviceType: remote.deviceType,
      brand: remote.brand,
      model: remote.model,
      patternId: patternId || choosePatternId(remote.deviceType),
      buttons,
      powerButtonId: power?.buttonId || null
    };
  }

  function choosePatternId(type) {
    const map = {
      tv: 'smart_tv', dvd: 'media', audio: 'audio_receiver', stb: 'settop', projector: 'projector', ac: 'ac', fan: 'fan', camera: 'camera', console: 'streaming', purifier: 'purifier', vacuum: 'compact', light: 'led_light', heater: 'heater'
    };
    return map[type] || 'compact';
  }

  async function loadAppRemote(meta) {
    return remoteToAppDefinition(await loadRemote(meta));
  }

  async function downloadAllFlipper(onProgress) {
    const catalog = await syncFlipper(false);
    if (!catalog.length) return { done: 0, total: 0, failed: 0, skipped: true, reason: sourceErrors.flipper || 'Indice Flipper non disponibile' };
    if (!('caches' in window)) throw new Error('Cache Storage non disponibile in questo browser.');
    const cache = await caches.open(CACHE_NAME);
    let done = 0, failed = 0;
    const queue = catalog.slice();
    async function worker() {
      while (queue.length) {
        const item = queue.shift();
        const url = `${FLIPPER.baseUrl}${item.path}`;
        try {
          const hit = await cache.match(url);
          if (!hit) {
            const r = await fetch(url);
            if (!r.ok) throw new Error(String(r.status));
            await cache.put(url, r.clone());
          }
        } catch { failed++; }
        done++;
        if (onProgress && (done % 5 === 0 || done === catalog.length)) onProgress({ done, total: catalog.length, failed });
      }
    }
    await Promise.all(Array.from({ length: 6 }, worker));
    return { done, total: catalog.length, failed };
  }

  async function downloadAllIrdB(onProgress) {
    const catalog = await syncIrdB(false);
    if (!('caches' in window)) throw new Error('Cache Storage non disponibile in questo browser.');
    const cache = await caches.open(CACHE_NAME);
    let done = 0, failed = 0;
    const queue = catalog.slice();
    async function worker() {
      while (queue.length) {
        const item = queue.shift();
        const encodedPath = item.path.split('/').map(encodeURIComponent).join('/');
        const url = `${IRDB.baseUrl}${encodedPath}`;
        try {
          const hit = await cache.match(url);
          if (!hit) {
            const r = await fetch(url);
            if (!r.ok) throw new Error(String(r.status));
            await cache.put(url, r.clone());
          }
        } catch { failed++; }
        done++;
        if (onProgress && (done % 10 === 0 || done === catalog.length)) onProgress({ done, total: catalog.length, failed });
      }
    }
    await Promise.all(Array.from({ length: 6 }, worker));
    if (failed === 0 && done === catalog.length) localStorage.setItem(IRDB_OFFLINE_KEY, 'yes');
    else localStorage.removeItem(IRDB_OFFLINE_KEY);
    return { done, total: catalog.length, failed };
  }

  async function ensureIrdBOffline(onProgress) {
    const catalog = await syncIrdB(false);
    if (localStorage.getItem(IRDB_OFFLINE_KEY) === 'yes') {
      return { done: catalog.length, total: catalog.length, failed: 0, alreadyCached: true };
    }
    return downloadAllIrdB(onProgress);
  }

  function getStatus() {
    const f = loadJson(FLIPPER_INDEX_KEY);
    const i = loadJson(IRDB_INDEX_KEY);
    return {
      flipperCount: flipperCatalog?.length || f?.items?.length || 0,
      flipperSyncedAt: f?.syncedAt || null,
      irdbCount: irdbCatalog?.length || i?.items?.length || 0,
      irdbSyncedAt: i?.syncedAt || null,
      irdbAcknowledged: true,
      irdbOfflineComplete: localStorage.getItem(IRDB_OFFLINE_KEY) === 'yes',
      flipperError: sourceErrors.flipper,
      irdbError: sourceErrors.irdb
    };
  }

  window.IR_EXTERNAL_DB = {
    sources: { flipper: FLIPPER, irdb: IRDB },
    sync,
    search,
    loadRemote,
    loadAppRemote,
    toRaw,
    synthesisSupport,
    downloadAllFlipper,
    downloadAllIrdB,
    ensureIrdBOffline,
    getStatus,
    isIrdBAcknowledged,
    setIrdBAcknowledged,
    syncIrdB,
    choosePatternId
  };
})();
