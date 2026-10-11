from pathlib import Path
import json, subprocess, time, os, signal, sys, traceback, re
from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeoutError

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / 'docs'
URL = (WEB / 'index.html').as_uri()


def pd32(header_mark, header_space, bit_mark, zero_space, one_space, data):
    raw = [header_mark, header_space]
    for byte in data:
        for bit in range(8):
            raw += [bit_mark, one_space if (byte >> bit) & 1 else zero_space]
    raw.append(bit_mark)
    return raw

LISTO = lambda cmd: pd32(4580, 4408, 640, 480, 1590, [0x0E, 0x0E, cmd, (~cmd) & 0xFF])

FAKE_SERIAL_JS = r'''
(() => {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const fake = {
    captures: [], commands: [], dialogs: [], captureId: 0,
    queueCapture(raw, opts={}) { this.captures.push({raw:[...raw], glitches:opts.glitches||0, overflow:!!opts.overflow, delayMs:opts.delayMs??8}); },
    clear() { this.captures.length=0; this.commands.length=0; }
  };
  window.__fakeSerial = fake;
  window.__fakeSerialQueueCapture = (raw, opts={}) => fake.queueCapture(raw, opts);

  class FakePort {
    constructor() { this.controller=null; this.opened=false; this.loaded=0; this.expected=0; this.pendingText=''; }
    async open() {
      this.opened=true;
      this.readable = new ReadableStream({start: c => { this.controller=c; }});
      this.writable = new WritableStream({write: chunk => this.onWrite(chunk)});
      setTimeout(() => this.emit('READY UNO_IR_6 RAW'), 5);
    }
    async close() { this.opened=false; try { this.controller?.close(); } catch {} }
    emit(line) { if (!this.opened || !this.controller) return; this.controller.enqueue(enc.encode(line+'\n')); }
    onWrite(chunk) {
      this.pendingText += dec.decode(chunk, {stream:true});
      let i;
      while ((i=this.pendingText.indexOf('\n'))>=0) {
        const line=this.pendingText.slice(0,i).trim(); this.pendingText=this.pendingText.slice(i+1);
        if (line) this.handle(line);
      }
    }
    handle(line) {
      fake.commands.push(line);
      const p=line.split(/\s+/);
      if (p[0]==='PING') return setTimeout(()=>this.emit('PONG UNO_IR_6 RAW'),1);
      if (p[0]==='DEBUG') return setTimeout(()=>this.emit('DEBUG '+(p[1]||'1')),1);
      if (p[0]==='STATUS') return setTimeout(()=>this.emit('DBG STATUS tag=HOST armed=0 active=0 aco=0 count=0 glitches=0'),1);
      if (p[0]==='CANCEL') return setTimeout(()=>this.emit('CANCELLED'),4);
      if (p[0]==='LEARN') {
        this.emit('ARMED RAW');
        const cap=fake.captures.shift();
        if (!cap) return;
        const id=++fake.captureId;
        setTimeout(()=>{
          this.emit(`RXBEGIN ${id} ${cap.raw.length} ${cap.glitches} ${cap.overflow?1:0}`);
          for (let off=0; off<cap.raw.length; off+=16) this.emit(`RXDATA ${id} ${off} ${cap.raw.slice(off,off+16).join(' ')}`);
          this.emit(`RXEND ${id}`);
        }, cap.delayMs);
        return;
      }
      if (p[0]==='TXRAW_BEGIN') { this.expected=Number(p[2]); this.loaded=0; return setTimeout(()=>this.emit(`TXRAW READY ${this.expected}`),1); }
      if (p[0]==='TXRAW_DATA') { const off=Number(p[1]); const vals=p.slice(2); if (off!==this.loaded) return this.emit('ERR TXRAW_OFFSET'); this.loaded += vals.length; return setTimeout(()=>this.emit(`TXRAW LOADED ${this.loaded}`),1); }
      if (p[0]==='TXRAW_GO') return setTimeout(()=>this.emit(this.loaded===this.expected?'TXOK':`ERR TXRAW_INCOMPLETE ${this.loaded} ${this.expected}`),1);
      this.emit('ERR UNKNOWN_CMD');
    }
  }
  const serial = { requestPort: async () => new FakePort() };
  Object.defineProperty(navigator, 'serial', {value: serial, configurable: true});
  window.__copiedText = '';
  Object.defineProperty(navigator, 'clipboard', {value: {writeText: async text => { window.__copiedText=String(text); }}, configurable: true});

  // about:blank has an opaque origin in the sandbox, so provide the same
  // synchronous Storage API the application uses at localhost.
  const storageMap = new Map();
  const fakeStorage = {
    get length() { return storageMap.size; },
    key(i) { return Array.from(storageMap.keys())[i] ?? null; },
    getItem(k) { k=String(k); return storageMap.has(k) ? storageMap.get(k) : null; },
    setItem(k,v) { storageMap.set(String(k), String(v)); },
    removeItem(k) { storageMap.delete(String(k)); },
    clear() { storageMap.clear(); }
  };
  Object.defineProperty(window, 'localStorage', {value: fakeStorage, configurable: true});

  // Small in-memory Cache Storage mock so offline DB paths can be tested even
  // when the harness loads index.html from file:// in the sandbox.
  const cacheMap = new Map();
  const fakeCaches = {
    async open(name) {
      return {
        async match(key) { const r=cacheMap.get(String(key)); return r ? r.clone() : undefined; },
        async put(key, response) { cacheMap.set(String(key), response.clone()); }
      };
    }
  };
  Object.defineProperty(window, 'caches', {value: fakeCaches, configurable: true});
})();
'''

IRDB_INDEX = "TestBrand/TV/1,-1.csv\nSamsung/TV/7,7.csv\n"
TEST_CSV = "functionname,protocol,device,subdevice,function\nPower,NEC1,1,-1,12\nVolume Up,NEC1,1,-1,16\nVolume Down,NEC1,1,-1,17\n"
SAMSUNG_CSV = "functionname,protocol,device,subdevice,function\nPower,SAMSUNG32,7,7,2\n"


def assert_true(cond, msg):
    if not cond:
        raise AssertionError(msg)


def main():
    report=[]
    def log(msg):
        report.append(msg)
        print(msg, flush=True)
    try:
      firmware=(ROOT/'arduino'/'IRUniversalUno_v06.ino').read_text(encoding='utf-8')
      for token in ('LEARN','CANCEL','PING','DEBUG','STATUS','TXRAW_BEGIN','TXRAW_DATA','TXRAW_GO','RXBEGIN','RXDATA','RXEND','MAX_TIMINGS = 520','Serial.begin(115200)'):
          assert_true(token in firmware, f'Firmware/web protocol token missing: {token}')
      log('PASS static Arduino v06 <-> web serial protocol contract')


      index=(WEB/'index.html').read_text(encoding='utf-8')
      manifest=json.loads((WEB/'manifest.webmanifest').read_text(encoding='utf-8'))
      sw=(WEB/'service-worker.js').read_text(encoding='utf-8')
      assert_true(manifest.get('start_url')=='./' and manifest.get('scope')=='./', 'PWA manifest is not subpath-safe')
      assert_true('service-worker.js' in (WEB/'app.js').read_text(encoding='utf-8'), 'Service worker registration missing')
      assert_true('src="/' not in index and 'href="/' not in index, 'Absolute local asset path breaks GitHub Pages project subpath')
      assert_true((WEB/'.nojekyll').exists(), '.nojekyll missing for GitHub Pages')
      assert_true('ir-remote-lab-static-v11.0.0' in sw, 'Service worker cache version missing')
      log('PASS GitHub Pages/PWA relative-path contract')

      with sync_playwright() as pw:
        browser=pw.chromium.launch(
            headless=True, executable_path='/usr/bin/chromium',
            args=['--no-sandbox','--allow-file-access-from-files','--disable-web-security']
        )
        context=browser.new_context(accept_downloads=True)
        page=context.new_page()
        page.add_init_script(FAKE_SERIAL_JS)
        console_errors=[]
        dialogs=[]
        prompt_answers=[]
        confirm_answers=[]
        page.on('console', lambda m: console_errors.append(m.text) if m.type=='error' else None)
        page.on('pageerror', lambda e: console_errors.append('PAGEERROR '+str(e)))
        def handle_dialog(d):
            if d.type == 'prompt' and prompt_answers:
                answer=prompt_answers.pop(0)
                dialogs.append('EXPECTED:'+d.message)
                d.accept(answer)
            elif d.type == 'confirm' and confirm_answers:
                answer=confirm_answers.pop(0)
                dialogs.append('EXPECTED:'+d.message)
                d.accept() if answer else d.dismiss()
            else:
                dialogs.append(d.message)
                d.dismiss()
        page.on('dialog', handle_dialog)

        # Build the stripped HTML before routing the synthetic app origin.
        app_html=(WEB/'index.html').read_text(encoding='utf-8')
        app_html=re.sub(r'<script[^>]+src=["\'][^"\']+["\'][^>]*>\s*</script>', '', app_html, flags=re.I)
        app_html=re.sub(r'<link[^>]+rel=["\']stylesheet["\'][^>]*>', '', app_html, flags=re.I)

        def route_handler(route):
            u=route.request.url
            if u == 'https://app.test/' or u == 'https://app.test':
                return route.fulfill(status=200, content_type='text/html', body=app_html)
            if 'data.jsdelivr.com/v1/packages/gh/flipperdevices/IRDB' in u:
                return route.fulfill(status=200, content_type='application/json', body='{"files":[]}')
            if 'api.github.com/repos/flipperdevices/IRDB/git/trees/dev' in u:
                tree={"truncated":False,"tree":[{"type":"blob","path":"database/categories/TVs/TestFlipper/Remote1/Remote1.ir"}]}
                return route.fulfill(status=200, content_type='application/json', body=json.dumps(tree))
            if 'cdn.jsdelivr.net/gh/flipperdevices/IRDB@dev/database/categories/TVs/TestFlipper/Remote1/Remote1.ir' in u:
                body='Filetype: IR signals file\nVersion: 1\n#\nname: Power\ntype: raw\nfrequency: 38000\nduty_cycle: 0.330000\ndata: 9000 4500 560 560 560 1690 560\n'
                return route.fulfill(status=200, content_type='text/plain', body=body)
            if 'cdn.jsdelivr.net/gh/probonopd/irdb@master/codes/index' in u:
                return route.fulfill(status=200, content_type='text/plain', body=IRDB_INDEX)
            if 'cdn.jsdelivr.net/gh/probonopd/irdb@master/codes/TestBrand/TV/1%2C-1.csv' in u or 'cdn.jsdelivr.net/gh/probonopd/irdb@master/codes/TestBrand/TV/1,-1.csv' in u:
                return route.fulfill(status=200, content_type='text/csv', body=TEST_CSV)
            if 'cdn.jsdelivr.net/gh/probonopd/irdb@master/codes/Samsung/TV/7%2C7.csv' in u or 'cdn.jsdelivr.net/gh/probonopd/irdb@master/codes/Samsung/TV/7,7.csv' in u:
                return route.fulfill(status=200, content_type='text/csv', body=SAMSUNG_CSV)
            return route.continue_()
        page.route('**/*', route_handler)

        # The sandbox blocks every top-level navigation. Load the exact DOM and
        # inject browser API mocks before the real application scripts.
        page.set_content(app_html, wait_until='domcontentloaded')
        page.evaluate(FAKE_SERIAL_JS)
        page.add_style_tag(content=(WEB/'styles.css').read_text(encoding='utf-8'))
        for script_name in ('remotes_db.js','external_db.js','app.js'):
            page.add_script_tag(content=(WEB/script_name).read_text(encoding='utf-8'))
        page.wait_for_selector('text=IR Remote Lab')
        assert_true(page.locator('.version-badge').inner_text()=='v11','Version badge missing')
        log('PASS load/home/version')

        # Connect serial.
        page.get_by_role('button', name='Collega Arduino').click()
        page.wait_for_function("document.getElementById('serialStatus').textContent.includes('collegato')")
        log('PASS serial connect/handshake')

        # Database panel: jsDelivr metadata can fail/return empty for the large
        # Flipper repository. The GitHub tree fallback and irdb must still load.
        page.locator('.add-card').click()
        page.wait_for_selector('#dbStatus')
        page.wait_for_function("window.IR_EXTERNAL_DB.getStatus().irdbCount===2 && window.IR_EXTERNAL_DB.getStatus().flipperCount===1", timeout=10000)
        dbtxt=page.locator('#dbStatus').inner_text()
        assert_true(page.evaluate('window.IR_EXTERNAL_DB.getStatus().irdbCount')==2, 'irdb catalog not loaded')
        assert_true(page.evaluate('window.IR_EXTERNAL_DB.getStatus().flipperCount')==1, 'Flipper GitHub fallback catalog not loaded: '+dbtxt)
        assert_true(page.get_by_text('Abilita anche irdb').count()==0, 'Old irdb checkbox still present')
        log('PASS DB fallback: Flipper GitHub tree + irdb both load')

        # Manual DB sync.
        page.locator('#dbSync').click()
        page.wait_for_function("window.IR_EXTERNAL_DB.getStatus().irdbCount===2", timeout=10000)
        log('PASS DB manual sync')

        # Clone built-in pattern: Skip and Cancel must abort the active LEARN cleanly.
        page.get_by_text('Clona telecomando', exact=True).click()
        page.locator('#patternNext').click(); page.locator('#cloneName').fill('Skip test'); page.locator('#startLearning').click()
        page.wait_for_selector('#skipButton'); first_prompt=page.locator('#learnStatus').inner_text()
        page.locator('#skipButton').click(); page.wait_for_timeout(120)
        second_prompt=page.locator('#learnStatus').inner_text()
        assert_true(first_prompt != second_prompt, 'Skip did not advance to the next clone button')
        page.locator('#cancelClone').click(); page.wait_for_selector('h1:has-text("Aggiungi telecomando")')
        log('PASS clone built-in pattern / skip / cancel')

        # Navigation while acquisition active must not show stale cancellation dialog.
        page.get_by_text('Riconosci telecomando', exact=True).click()
        page.locator('#recognizeStart').click()
        page.wait_for_timeout(40)
        page.locator('#backAdd').click()
        page.wait_for_timeout(150)
        assert_true(not dialogs, 'Unexpected dialog after cancelled acquisition: '+repr(dialogs))
        assert_true(page.get_by_role('heading', name='Aggiungi telecomando').count()==1, 'Navigation after cancel failed')
        log('PASS acquisition cancellation/navigation leak')

        # Recognition: local Listo, three captured buttons are preserved in saved remote.
        page.get_by_text('Riconosci telecomando', exact=True).click()
        for cmd in (0x0C,0x01,0x02):
            page.evaluate('(raw)=>window.__fakeSerialQueueCapture(raw)', LISTO(cmd))
        page.locator('#recognizeStart').click()
        page.wait_for_selector('text=Listo Captured 0E family', timeout=15000)
        row=page.locator('.candidate').filter(has_text='Listo Captured 0E family').first
        row.get_by_role('button', name='Usa').click()
        page.wait_for_selector('h2:has-text("Listo Captured 0E family")')
        saved=page.evaluate("JSON.parse(localStorage.getItem('irRemoteLab.remotes.v1'))")[-1]
        for k in ('learned_1','learned_2','learned_3'):
            assert_true(k in saved['mapping'] and saved['mapping'][k].get('raw'), f'Recognition capture {k} missing')
        assert_true(not page.locator('.info-panel .notice').first.inner_text().strip().startswith('0/'), 'Recognized remote UI incorrectly shows zero ready buttons')
        log('PASS recognition saves the 3 physically learned buttons + accurate ready count')

        # Relearn from editor with visible modal.
        page.get_by_role('button', name='Modifica tasti').click()
        row=page.locator('.button-editor-row').filter(has_text='Tasto 1').first
        page.evaluate('(raw)=>window.__fakeSerialQueueCapture(raw)', LISTO(0x03))
        row.get_by_role('button', name='Riapprendi').click()
        page.wait_for_selector('#relearnStatus')
        page.wait_for_function("document.querySelector('#modalRoot').textContent.trim()===''", timeout=10000)
        saved=page.evaluate("JSON.parse(localStorage.getItem('irRemoteLab.remotes.v1'))")[-1]
        assert_true(saved['mapping']['learned_1']['decoded']['bytes'][2]==3, 'Relearn did not replace button signal')
        assert_true(not dialogs, 'Unexpected alert during relearn')
        log('PASS edit/relearn button')

        # Home then clone custom one-button; mismatch A/B/B must recover automatically.
        page.locator('#backRemote').click()
        page.get_by_role('button', name='Home').click()
        page.locator('.add-card').click()
        page.get_by_text('Clona telecomando', exact=True).click()
        assert_true(page.locator('.pattern-tile').count() >= 23, 'Expected at least 23 built-in patterns')
        bad_geometry=page.evaluate('''()=>[...document.querySelectorAll(".pattern-mini svg")].flatMap((svg,si)=>{const vb=svg.viewBox.baseVal; return [...svg.querySelectorAll(".remote-button")].map((r,ri)=>({si,ri,x:+r.getAttribute("x"),y:+r.getAttribute("y"),w:+r.getAttribute("width"),h:+r.getAttribute("height"),vw:vb.width,vh:vb.height})).filter(o=>o.x<0||o.y<0||o.x+o.w>o.vw||o.y+o.h>o.vh);})''')
        assert_true(not bad_geometry, 'Built-in pattern has out-of-bounds buttons: '+repr(bad_geometry[:5]))
        page.locator('#customPattern').click()
        prompt_text=page.locator('#aiPrompt').input_value()
        assert_true('ABSOLUTE OUTPUT RULE' in prompt_text and 'Count every independently pressable' in prompt_text, 'AI prompt not precise enough')
        page.locator('#copyPrompt').click(); page.wait_for_function('window.__copiedText.length > 100')
        assert_true(page.evaluate('window.__copiedText') == prompt_text, 'Copy AI prompt failed')
        custom={"schema":"ir-pattern-v1","name":"Test one key","width":280,"height":480,"body":{"x":20,"y":10,"w":240,"h":460,"rx":45},"decorations":[],"buttons":[{"id":"power","label":"Power","x":100,"y":100,"w":80,"h":44,"shape":"rounded","semantic":"power"}]}
        page.locator('#customPatternJson').fill('{}'); page.locator('#usePatternJson').click()
        page.wait_for_selector('#customPatternStatus.notice.warn')
        page.locator('#customPatternJson').fill(json.dumps(custom))
        page.locator('#usePatternJson').click()
        page.locator('#patternNext').click()
        page.locator('#cloneName').fill('Mismatch clone')
        A=[1000,1000,1000,1000,1000]
        B=[3000,3000,3000,3000,3000]
        for raw in (A,B,B): page.evaluate('(r)=>window.__fakeSerialQueueCapture(r)', raw)
        page.locator('#startLearning').click()
        page.wait_for_selector('h2:has-text("Mismatch clone")', timeout=15000)
        saved=page.evaluate("JSON.parse(localStorage.getItem('irRemoteLab.remotes.v1'))")[-1]
        assert_true(saved['mapping']['power']['raw']==B, 'Mismatch recovery did not save stable capture')
        log('PASS clone/custom pattern + mismatch auto-retry')

        # Transmit virtual button.
        page.evaluate('window.__fakeSerial.commands=[]')
        page.locator('#remoteStage g').filter(has_text='Power').click()
        page.wait_for_function("window.__fakeSerial.commands.includes('TXRAW_GO')")
        cmds=page.evaluate('window.__fakeSerial.commands')
        assert_true(any(c.startswith('TXRAW_BEGIN') for c in cmds) and 'TXRAW_GO' in cmds, 'Virtual remote did not transmit RAW')
        log('PASS virtual remote transmit')

        # Model search external irdb + Test Power + import.
        page.get_by_role('button', name='Home').click(); page.locator('.add-card').click(); page.get_by_text('Ricerca modello', exact=True).click()
        page.locator('#modelType').select_option('tv')
        # Flipper fallback catalog: search and transmit a RAW Power button.
        page.locator('#modelBrand').fill('TestFlipper'); page.locator('#modelSearchButton').click()
        page.wait_for_selector('.candidate:has-text("TestFlipper Remote1")', timeout=10000)
        fcand=page.locator('.candidate').filter(has_text='TestFlipper Remote1').first
        page.evaluate('window.__fakeSerial.commands=[]'); fcand.get_by_role('button', name='Test Power').click()
        page.wait_for_function("window.__fakeSerial.commands.includes('TXRAW_GO')")
        # irdb catalog: search, test and import.
        page.locator('#modelBrand').fill('TestBrand'); page.locator('#modelSearchButton').click()
        page.wait_for_selector('.candidate:has-text("TestBrand TV 1,-1")', timeout=10000)
        cand=page.locator('.candidate').filter(has_text='TestBrand TV 1,-1').first
        page.evaluate('window.__fakeSerial.commands=[]')
        cand.get_by_role('button', name='Test Power').click()
        page.wait_for_function("window.__fakeSerial.commands.includes('TXRAW_GO')")
        cand.get_by_role('button', name='Usa').click()
        page.wait_for_selector('h2:has-text("TestBrand TV 1,-1")')
        saved=page.evaluate("JSON.parse(localStorage.getItem('irRemoteLab.remotes.v1'))")[-1]
        assert_true(saved['mapping'].get('power',{}).get('raw'), 'External model Power not converted/saved')
        # Switch between saved remotes from the virtual-remote toolbar.
        options=page.locator('#remoteSwitch option').all()
        assert_true(len(options) >= 2, 'Remote switcher did not list saved remotes')
        current=page.locator('#remoteSwitch').input_value()
        target=next(o.get_attribute('value') for o in options if o.get_attribute('value') != current)
        target_name=next(o.inner_text() for o in options if o.get_attribute('value') == target)
        page.locator('#remoteSwitch').select_option(target)
        page.wait_for_function('(name)=>document.querySelector(".info-panel h2")?.textContent===name', arg=target_name)
        log('PASS model search / Flipper fallback + irdb / power tests / import / remote switcher')

        # Auto search local LG power and reacted.
        page.get_by_role('button', name='Home').click(); page.locator('.add-card').click(); page.get_by_text('Ricerca automatica', exact=True).click()
        # Stop must interrupt a running search cleanly.
        page.locator('#autoStart').click(); page.wait_for_selector('#autoStop:not(.hidden)'); page.locator('#autoStop').click()
        page.wait_for_function('document.getElementById("autoStop").classList.contains("hidden")')
        page.locator('#autoType').select_option('dvd'); page.locator('#autoBrand').fill('LG'); page.locator('#autoStart').click()
        page.wait_for_function("document.getElementById('autoStatus').textContent.includes('LG COV33662801')", timeout=10000)
        page.locator('#autoReacted').click()
        page.wait_for_selector('h2:has-text("LG COV33662801")')
        log('PASS automatic search / stop / reacted / save')

        # Import JSON and export.
        page.get_by_role('button', name='Home').click(); page.locator('.add-card').click(); page.get_by_text('Importa JSON', exact=True).click()
        imported={"schema":"ir-remote-v1","id":"old","name":"Imported test","deviceType":"tv","brand":"X","model":"Y","pattern":custom,"mapping":{"power":{"protocol":"RAW","carrierHz":38000,"raw":LISTO(0x04)}},"createdAt":"2026-01-01T00:00:00Z"}
        page.locator('#importText').fill('{bad json'); page.locator('#importButton').click(); page.wait_for_selector('#importStatus.notice.warn')
        page.locator('#importText').fill(json.dumps(imported)); page.locator('#importButton').click(); page.wait_for_selector('h2:has-text("Imported test")')
        with page.expect_download(timeout=5000) as di:
            page.locator('#exportButton').click()
        download=di.value
        assert_true(download.suggested_filename.endswith('.json'),'Export filename invalid')
        log('PASS JSON invalid handling / import / export')

        # Rename, add+learn, remove.
        page.get_by_role('button', name='Modifica tasti').click()
        prompt_answers.append('Power Renamed')
        page.locator('.button-editor-row').first.get_by_role('button', name='Rinomina').click()
        page.wait_for_selector('.button-editor-row:has-text("Power Renamed")')
        prompt_answers.append('Extra')
        page.evaluate('(raw)=>window.__fakeSerialQueueCapture(raw)', LISTO(0x05))
        page.locator('#addButton').click()
        page.wait_for_function("document.querySelector('#modalRoot').textContent.trim()===''", timeout=10000)
        page.wait_for_selector('.button-editor-row:has-text("Extra")')
        extra=page.locator('.button-editor-row').filter(has_text='Extra').first
        extra.get_by_role('button', name='Elimina').click()
        assert_true(page.locator('.button-editor-row').filter(has_text='Extra').count()==0, 'Remove button failed')
        log('PASS rename / add+learn / remove button')


        # Position editor: mouse/touch style drag must persist coordinates; undo restores them.
        before=page.evaluate("JSON.parse(localStorage.getItem('irRemoteLab.remotes.v1')).find(r=>r.name==='Imported test').pattern.buttons.find(b=>b.id==='power')")
        page.locator('#moveMode').click()
        group=page.locator('#editorStage g[data-button-id="power"]')
        box=group.bounding_box()
        assert_true(box is not None, 'Movable power button has no geometry')
        page.mouse.move(box['x']+box['width']/2, box['y']+box['height']/2)
        page.mouse.down()
        page.mouse.move(box['x']+box['width']/2+28, box['y']+box['height']/2+18, steps=4)
        page.mouse.up()
        page.wait_for_timeout(120)
        after=page.evaluate("JSON.parse(localStorage.getItem('irRemoteLab.remotes.v1')).find(r=>r.name==='Imported test').pattern.buttons.find(b=>b.id==='power')")
        assert_true((after['x'],after['y']) != (before['x'],before['y']), 'Drag did not persist button position')
        assert_true(page.locator('#undoMove').is_enabled(), 'Undo move did not become available')
        page.locator('#undoMove').click(); page.wait_for_timeout(80)
        undone=page.evaluate("JSON.parse(localStorage.getItem('irRemoteLab.remotes.v1')).find(r=>r.name==='Imported test').pattern.buttons.find(b=>b.id==='power')")
        assert_true((undone['x'],undone['y']) == (before['x'],before['y']), 'Undo did not restore original button position')
        # Keyboard nudge for precise positioning.
        group=page.locator('#editorStage g[data-button-id="power"]')
        group.focus(); page.keyboard.press('ArrowRight'); page.wait_for_timeout(50)
        nudged=page.evaluate("JSON.parse(localStorage.getItem('irRemoteLab.remotes.v1')).find(r=>r.name==='Imported test').pattern.buttons.find(b=>b.id==='power')")
        assert_true(nudged['x'] == before['x'] + 1, 'Keyboard nudge did not move by 1 px')
        log('PASS button position editor drag / undo / keyboard nudge')


        # Mobile viewport: editor must stay usable without horizontal page overflow.
        page.set_viewport_size({'width':390,'height':844})
        page.wait_for_timeout(80)
        overflow=page.evaluate('document.documentElement.scrollWidth - window.innerWidth')
        assert_true(overflow <= 1, f'Mobile editor horizontal overflow: {overflow}')
        assert_true(page.locator('#moveMode').is_visible() and page.locator('#addButton').is_visible(), 'Mobile editor controls are not visible')
        page.set_viewport_size({'width':1280,'height':800})
        log('PASS mobile 390px editor layout')

        # Advanced send + validation.
        page.locator('#backRemote').click(); page.get_by_role('button', name='Home').click(); page.locator('.add-card').click(); page.get_by_text('Modalita avanzata', exact=True).click()
        page.evaluate('window.__fakeSerial.commands=[]'); page.locator('#advSend').click(); page.wait_for_selector('#advStatus.notice.ok')
        page.locator('#advCarrier').fill('100'); page.locator('#advSend').click(); page.wait_for_selector('#advStatus.notice.warn')
        assert_true('30000' in page.locator('#advStatus').inner_text(), 'Advanced validation missing')
        log('PASS advanced send + validation')

        # DB offline button on small mocked catalog.
        page.locator('#backAdd').click(); page.locator('#dbDownload').click()
        page.wait_for_function("document.getElementById('dbStatus').textContent.includes('Cache offline completata')", timeout=15000)
        log('PASS offline DB cache flow')

        # Delete remote with confirmation and verify persistence count.
        page.locator('#backHome').click()
        cards_before=page.locator('.remote-card').count()
        assert_true(cards_before > 0, 'No remote available for delete test')
        page.locator('.remote-card').last.click(); page.locator('#editButton').click()
        confirm_answers.append(True); page.locator('#deleteRemote').click()
        page.wait_for_selector('h1:has-text("I tuoi telecomandi")')
        assert_true(page.locator('.remote-card').count() == cards_before - 1, 'Remote delete did not update Home/persistence')
        log('PASS remote delete + Home refresh')


        # Full backup export/import, useful when moving from localhost to GitHub Pages origin.
        with page.expect_download(timeout=5000) as backup_download:
            page.locator('#backupExport').click()
        assert_true(backup_download.value.suggested_filename.startswith('ir-remote-lab-backup-'), 'Full backup filename invalid')
        backup_remote={"schema":"ir-remote-v1","id":"backup-special","name":"Backup restored","deviceType":"tv","brand":"B","model":"R","pattern":{"schema":"ir-pattern-v1","id":"backup-p","name":"Backup","width":280,"height":480,"body":{"x":20,"y":10,"w":240,"h":460,"rx":45},"decorations":[],"buttons":[{"id":"power","label":"Power","x":100,"y":100,"w":80,"h":44,"shape":"rounded","semantic":"power"}]},"mapping":{"power":{"protocol":"RAW","carrierHz":38000,"raw":LISTO(0x06)}},"createdAt":"2026-01-01T00:00:00Z"}
        backup_payload=json.dumps({"schema":"ir-remote-lab-backup-v1","appVersion":"11.0.0","remotes":[backup_remote]}).encode('utf-8')
        page.locator('#backupFile').set_input_files({"name":"backup.json","mimeType":"application/json","buffer":backup_payload})
        page.wait_for_selector('.remote-card:has-text("Backup restored")')
        log('PASS full backup export / import')

        # Disconnect UI.
        page.get_by_role('button', name='Scollega').click(); page.wait_for_function("document.getElementById('serialStatus').textContent.includes('non collegato')")
        log('PASS serial disconnect')

        # Ignore expected prompt dialogs logged with EXPECTED marker; any other dialog is failure.
        unexpected=[d for d in dialogs if not d.startswith('EXPECTED:')]
        assert_true(not unexpected, 'Unexpected browser dialogs: '+repr(unexpected))
        assert_true(not console_errors, 'Console/page errors: '+repr(console_errors))
        log('PASS no uncaught JS/console errors')
        browser.close()

      (ROOT/'tests'/'TEST_REPORT.txt').write_text('\n'.join(report)+'\n', encoding='utf-8')
      return 0
    except Exception:
      traceback.print_exc()
      try:
        (ROOT/'tests'/'TEST_REPORT.txt').write_text('\n'.join(report)+"\nFAIL\n"+traceback.format_exc(), encoding='utf-8')
      except Exception:
        pass
      return 1

if __name__=='__main__':
    raise SystemExit(main())
