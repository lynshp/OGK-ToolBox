const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');

// Run the production renderer with anonymous in-memory saves. Never load the
// application's main process, personal settings, game files, or controller.
const output = path.resolve(__dirname, '../../../artifacts/player-focus-image-review');
if (!process.versions.electron) {
  const env = { ...process.env, OGK_RATING_UI_TEST: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(require('electron'), [__filename], {
    env, stdio: 'inherit', windowsHide: true
  });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, nativeImage } = require('electron');
  fs.mkdirSync(output, { recursive: true });
  const profile = path.join(output, `profile-${Date.now()}`);
  fs.mkdirSync(profile, { recursive: true });
  const preload = path.join(profile, 'focus-image.preload.cjs');
  fs.writeFileSync(preload, `
    require(${JSON.stringify(path.join(__dirname, 'player-saves.preload.cjs'))});
    const probe = window.__playerFocusImageTest = {
      saveMode: 'cancel', saveCalls: [], coverMode: 'ok', coverCalls: 0,
      text: [], imageCount: 0, pngs: [], failGeneration: false, slowCovers: false, sparse: false, playTimesMode: 'recorded',
      resetCanvas() { this.text = []; this.imageCount = 0; this.pngs = []; }
    };
    const fixtureCanvas = document.createElement('canvas'); fixtureCanvas.width = 64; fixtureCanvas.height = 64;
    const fixtureContext = fixtureCanvas.getContext('2d');
    fixtureContext.fillStyle = '#7b8faa'; fixtureContext.fillRect(0, 0, 64, 64);
    fixtureContext.fillStyle = '#d0dbea'; fixtureContext.fillRect(0, 40, 64, 24);
    const fixtureThumbnail = fixtureCanvas.toDataURL('image/png');
    const originalPlayerSaves = window.ogk.playerSaves;
    window.ogk.playerSaves = async (...args) => {
      const state = await originalPlayerSaves(...args);
      if (probe.sparse) for (const save of state.saves) {
        const old = save.scores.find(score => score.musicId >= 1015);
        save.scores = old ? [old] : [];
      }
      for (const save of state.saves) {
        if (probe.playTimesMode === 'none') save.recentPlays = [];
        else if (probe.playTimesMode === 'invalid') save.recentPlays = [{ musicId: 1000, playedAt: 'invalid fixture timestamp' }];
        else if (probe.playTimesMode === 'mixed') save.recentPlays = [
          { musicId: 1000, playedAt: '2026-10-01T12:01:00Z' },
          { musicId: 1001, playedAt: 'invalid fixture timestamp' },
          { musicId: 1002, playedAt: '2026-10-02T00:03:00Z' },
          { musicId: 1003, playedAt: '2026-09-30T23:00:00Z' }
        ];
      }
      return state;
    };
    window.ogk.thumbnail = async (...args) => {
      probe.coverCalls++;
      if (probe.slowCovers) await new Promise(resolve => setTimeout(resolve, 450));
      if (probe.coverMode === 'fail') throw new Error('fixture artwork unavailable');
      if (probe.coverMode === 'invalid') return 'data:image/png;base64,broken';
      return fixtureThumbnail;
    };
    window.ogk.savePlayerScoreImage = async request => {
      probe.saveCalls.push({ dataUrl: request.dataUrl, fileName: request.fileName });
      if (probe.saveMode === 'error') throw new Error('fixture image save failure');
      return probe.saveMode === 'success';
    };
    const fillText = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function(text, ...args) {
      probe.text.push({ text: String(text), x: args[0], y: args[1], font: this.font });
      return fillText.call(this, text, ...args);
    };
    const drawImage = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function(...args) {
      probe.imageCount++;
      return drawImage.apply(this, args);
    };
    const toDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function(...args) {
      if (probe.failGeneration) throw new Error('fixture image generation failure');
      const dataUrl = toDataURL.apply(this, args);
      probe.pngs.push({ width: this.width, height: this.height, dataUrl });
      return dataUrl;
    };
  `);
  app.setPath('userData', profile);
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('in-process-gpu');

  app.whenReady().then(async () => {
    const win = new BrowserWindow({
      show: false, width: 1440, height: 900,
      webPreferences: { preload, contextIsolation: false, sandbox: false, offscreen: true }
    });
    const rendererErrors = [], report = { layouts: [], images: [], previewLayouts: [] };
    win.webContents.on('console-message', detail => {
      if (detail.level === 'error' && !detail.message.includes('frame-ancestors') &&
          !detail.message.includes('ERR_INVALID_URL')) rendererErrors.push(detail.message);
    });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] },
      (_event, done) => done({ cancel: true }));
    const run = code => win.webContents.executeJavaScript(code, true);
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const wait = async (condition, timeout = 10000) => {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        if (await run(`Boolean(${condition})`)) return;
        await sleep(40);
      }
      throw new Error(`Timeout: ${condition}`);
    };
    const press = selector => run(`(() => {
      const button = document.querySelector(${JSON.stringify(selector)});
      if (!button) throw new Error('Missing control: ' + ${JSON.stringify(selector)});
      button.focus(); button.click();
    })()`);
    const key = value => {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: value });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: value });
    };
    const snapshot = async name => {
      for (let attempt = 0; attempt < 3; attempt++) {
        await sleep(150);
        const capture = await win.webContents.capturePage();
        const png = capture.toPNG();
        if (!capture.isEmpty() && png.length > 100) {
          assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
          fs.writeFileSync(path.join(output, `${name}.png`), png);
          return;
        }
      }
      throw new Error(`Empty screenshot: ${name}`);
    };
    const progress = () => run(`Number(getComputedStyle(document.querySelector('.player-save-results')).getPropertyValue('--player-focus'))`);
    const layout = async label => {
      await sleep(100);
      const value = await run(`(() => {
        const rect = selector => {
          const r = document.querySelector(selector).getBoundingClientRect();
          return { top: r.top, left: r.left, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
        };
        const workspace = document.querySelector('.workspace'), list = document.querySelector('.player-best-scroll');
        return {
          focus: Number(getComputedStyle(document.querySelector('.player-save-results')).getPropertyValue('--player-focus')),
          summary: rect('.player-summary-collapse'), aside: rect('.player-resource-aside'), list: rect('.player-best-scroll'),
          title: rect('.page-title'), direct: rect('.player-direct-panel'), directCollapse: rect('.player-direct-collapse'), scrollTop: list.scrollTop,
          pageOverflow: workspace.scrollHeight > workspace.clientHeight + 1 || workspace.scrollWidth > workspace.clientWidth + 1,
          listOverflow: list.scrollWidth > list.clientWidth + 1,
          summaryHidden: document.querySelector('.player-summary-collapse').getAttribute('aria-hidden'),
          summaryInert: document.querySelector('.player-summary-collapse').inert,
          asideInert: document.querySelector('.player-resource-aside').inert,
          directInert: document.querySelector('.player-direct-collapse').inert
        };
      })()`);
      assert.equal(value.pageOverflow, false, `${label}: workspace overflow`);
      assert.equal(value.listOverflow, false, `${label}: list horizontal overflow`);
      report.layouts.push({ label, ...value });
      return value;
    };
    const wheel = async amount => {
      const point = await run(`(() => { const r = document.querySelector('.player-best-scroll').getBoundingClientRect(); return { x: Math.floor(r.left + r.width / 2), y: Math.floor(r.top + Math.min(r.height / 2, 80)) }; })()`);
      win.webContents.sendInputEvent({ type: 'mouseMove', ...point });
      win.webContents.sendInputEvent({ type: 'mouseWheel', ...point, deltaX: 0, deltaY: -amount, canScroll: true });
      await sleep(180);
    };
    const returnOverview = async () => {
      if (await progress() > 0) await press('[data-player-focus-toggle]');
      await wait(`Number(getComputedStyle(document.querySelector('.player-save-results')).getPropertyValue('--player-focus')) === 0`);
      await wait(`document.querySelector('.player-best-scroll').scrollTop === 0`);
      await wait(`!document.querySelector('.player-direct-collapse').inert`);
    };
    const measureScrollPerformance = async label => {
      const trace = [], phaseSamples = [];
      let complete;
      const finished = new Promise(resolve => { complete = resolve; });
      const receive = (_event, method, params) => {
        if (method === 'Tracing.dataCollected') trace.push(...params.value);
        if (method === 'Tracing.tracingComplete') complete();
      };
      win.webContents.debugger.on('message', receive);
      await win.webContents.debugger.sendCommand('Tracing.start', {
        categories: 'devtools.timeline,blink.user_timing,disabled-by-default-devtools.timeline.frame',
        options: 'record-as-much-as-possible', transferMode: 'ReportEvents'
      });
      const phase = async (name, amount) => {
        await run(`(() => {
          const p = window.__playerScrollPerformance = { frames: [], previous: 0, running: true };
          performance.mark('ogk-perf-${name}-start');
          const frame = time => { if (!p.running) return; if (p.previous) p.frames.push(time - p.previous); p.previous = time; p.id = requestAnimationFrame(frame); };
          p.id = requestAnimationFrame(frame);
        })()`);
        const point = await run(`(() => { const r = document.querySelector('.player-best-scroll').getBoundingClientRect(); return { x: Math.floor(r.left + r.width / 2), y: Math.floor(r.bottom - 70) }; })()`);
        win.webContents.sendInputEvent({ type: 'mouseMove', ...point });
        for (let step = 0; step < 48; step++) {
          win.webContents.sendInputEvent({ type: 'mouseWheel', ...point, deltaX: 0, deltaY: -amount, canScroll: true });
          await sleep(16);
        }
        await sleep(120);
        phaseSamples.push(await run(`(() => { const p = window.__playerScrollPerformance, list = document.querySelector('.player-best-scroll');
          p.running = false; cancelAnimationFrame(p.id); performance.mark('ogk-perf-${name}-end');
          return { name: '${name}', frames: p.frames, scrollTop: list.scrollTop }; })()`));
      };
      try {
        await run(`document.querySelector('.player-best-scroll').scrollTop = 0`); await sleep(450);
        await phase('expand', 4);
        await phase('native', 4);
        await run(`document.querySelector('.player-best-scroll').scrollTop = 180`); await sleep(200);
        await phase('collapse', -4);
        await win.webContents.debugger.sendCommand('Tracing.end');
        await Promise.race([finished, sleep(9000).then(() => { throw new Error('Performance trace timed out'); })]);
      } finally { win.webContents.debugger.removeListener('message', receive); }
      const percentile = (values, fraction) => values[Math.min(values.length - 1, Math.floor(values.length * fraction))] ?? 0;
      const samples = phaseSamples.map(sample => {
        const sorted = [...sample.frames].sort((a, b) => a - b), mean = sorted.reduce((sum, value) => sum + value, 0) / (sorted.length || 1);
        const start = trace.find(event => event.name === `ogk-perf-${sample.name}-start`), end = trace.find(event => event.name === `ogk-perf-${sample.name}-end`);
        const events = start && end ? trace.filter(event => event.ph === 'X' && event.ts >= start.ts && event.ts < end.ts) : [];
        const costs = {};
        for (const name of ['UpdateLayoutTree', 'Layout', 'Paint', 'PrePaint', 'FunctionCall', 'FireAnimationFrame']) {
          const selected = events.filter(event => event.name === name);
          costs[name] = { count: selected.length, totalMs: selected.reduce((sum, event) => sum + (event.dur ?? 0), 0) / 1000,
            maxMs: Math.max(0, ...selected.map(event => (event.dur ?? 0) / 1000)),
            affectedElements: selected.reduce((sum, event) => sum + (event.args?.elementCount ?? 0), 0) };
        }
        return { name: sample.name, intervalCount: sorted.length, meanIntervalMs: mean,
          p50IntervalMs: percentile(sorted, .5), p95IntervalMs: percentile(sorted, .95), maxIntervalMs: sorted.at(-1) ?? 0,
          intervalsOver25Ms: sorted.filter(value => value > 25).length, intervalsOver50Ms: sorted.filter(value => value > 50).length,
          scrollTop: sample.scrollTop, traceDurationMs: start && end ? (end.ts - start.ts) / 1000 : undefined, costs };
      });
      const result = { label, environment: { electron: process.versions.electron, chromium: process.versions.chrome,
        width: 1440, height: 900, offscreen: true, hardwareAcceleration: false, anonymousCharts: 110,
        wheelEventsPerPhase: 48, wheelIntervalMs: 16, wheelDelta: 4 }, samples,
        source: fs.readFileSync(path.resolve(__dirname, '../dist/index.html'), 'utf8').match(/index-[\w-]+\.(?:js|css)/g),
        limitation: 'rAF and trace measurements from an isolated software-rendered offscreen window; not a claim about the visible user window frame rate.' };
      fs.writeFileSync(path.join(output, `performance-${label}.json`), JSON.stringify(result, null, 2));
      fs.writeFileSync(path.join(output, `performance-${label}-trace.json`), JSON.stringify({ traceEvents: trace }));
      console.log(JSON.stringify(result, null, 2));
      await returnOverview();
    };
    const openImage = async () => {
      await run(`window.__playerFocusImageTest.resetCanvas()`);
      await press('[data-score-image-generate]');
      await wait(`document.querySelector('.player-score-image-preview [data-score-image-save]') && !document.querySelector('[data-score-image-save]').disabled`, 20000);
      await wait(`document.querySelector('.player-score-image-artwork')?.complete && document.querySelector('.player-score-image-artwork').naturalWidth > 0`);
    };
    const closeImage = async () => {
      await press('[data-score-image-close]');
      await wait(`!document.querySelector('.player-score-image-preview')`);
      await wait(`document.activeElement.hasAttribute('data-score-image-generate')`);
    };
    const checkPreviewSize = async label => {
      const measure = () => run(`(() => { const stage = document.querySelector('.player-score-image-stage'), image = document.querySelector('.player-score-image-artwork'), r = image.getBoundingClientRect(), s = stage.getBoundingClientRect(), style = getComputedStyle(stage);
        return { width: r.width, height: r.height, stageWidth: stage.clientWidth, stageHeight: stage.clientHeight,
          scrollWidth: stage.scrollWidth, scrollHeight: stage.scrollHeight, original: stage.classList.contains('is-original'),
          imageLeft: r.left, imageTop: r.top, imageRight: r.right, imageBottom: r.bottom,
          stageLeft: s.left, stageTop: s.top, paddingLeft: parseFloat(style.paddingLeft), paddingTop: parseFloat(style.paddingTop),
          paddingRight: parseFloat(style.paddingRight), paddingBottom: parseFloat(style.paddingBottom) }; })()`);
      await sleep(100);
      const fit = await measure();
      assert.equal(fit.original, false);
      assert.ok(fit.scrollHeight <= fit.stageHeight + 1, `${label}: fitted image has no vertical scroll`);
      assert.ok(fit.scrollWidth <= fit.stageWidth + 1, `${label}: fitted image has no horizontal scroll`);
      await press('[data-score-image-size]');
      await wait(`document.querySelector('.player-score-image-stage').classList.contains('is-original')`);
      const original = await measure();
      assert.equal(original.width, 2860);
      assert.equal(original.height, 1972);
      assert.ok(original.scrollHeight > original.stageHeight, `${label}: full PNG scrolls vertically`);
      assert.ok(original.scrollWidth > original.stageWidth, `${label}: full PNG scrolls horizontally`);
      assert.ok(original.imageLeft >= original.stageLeft + original.paddingLeft - 1, `${label}: full-size left edge starts in scrollable area`);
      assert.ok(original.imageTop >= original.stageTop + original.paddingTop - 1, `${label}: full-size top edge starts in scrollable area`);
      assert.ok(original.scrollWidth >= original.width + original.paddingLeft + original.paddingRight - 1,
        `${label}: full width is reachable rather than negatively centered`);
      await run(`(() => { const stage = document.querySelector('.player-score-image-stage'); stage.scrollLeft = stage.scrollWidth; stage.scrollTop = stage.scrollHeight; })()`);
      const bottomRight = await measure();
      assert.ok(bottomRight.imageRight <= bottomRight.stageLeft + bottomRight.stageWidth - bottomRight.paddingRight + 1,
        `${label}: rightmost image edge is reachable`);
      assert.ok(bottomRight.imageBottom <= bottomRight.stageTop + bottomRight.stageHeight - bottomRight.paddingBottom + 1,
        `${label}: bottom image edge is reachable`);
      await press('[data-score-image-size]');
      await wait(`!document.querySelector('.player-score-image-stage').classList.contains('is-original')`);
      const restored = await measure();
      assert.ok(restored.scrollHeight <= restored.stageHeight + 1 && restored.scrollWidth <= restored.stageWidth + 1,
        `${label}: original-to-fit restores whole-image preview`);
      report.previewLayouts.push({ label, fit, original, bottomRight, restored });
    };
    const checkImage = async (label, expectedPlayTime = '2026/10/1 20:09:00') => {
      const data = await run(`(() => {
        const p = window.__playerFocusImageTest, image = document.querySelector('.player-score-image-artwork');
        return { dataUrl: image.src, width: image.naturalWidth, height: image.naturalHeight,
          text: p.text, imageCount: p.imageCount, coverCalls: p.coverCalls };
      })()`);
      assert.equal(data.width, 2860, `${label}: PNG width`);
      assert.equal(data.height, 1972, `${label}: PNG height`);
      assert.ok(data.dataUrl.startsWith('data:image/png;base64,'), `${label}: PNG data URL`);
      const png = Buffer.from(data.dataUrl.split(',')[1], 'base64');
      assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      const decoded = nativeImage.createFromBuffer(png);
      assert.deepEqual(decoded.getSize(), { width: 2860, height: 1972 });
      const text = data.text.map(entry => entry.text);
      assert.ok(text.some(value => value.includes('Rating 测试玩家')), `${label}: anonymous player name`);
      assert.ok(text.some(value => value.includes('16.875')), `${label}: stored rating`);
      assert.equal(text.find(value => value.startsWith('游玩时间')), `游玩时间  ${expectedPlayTime}`,
        `${label}: latest valid recorded play time shown without archive-time fallback`);
      assert.equal(text.some(value => value.startsWith('存档时间')), false, `${label}: archive-time label removed`);
      assert.equal(data.text.some(entry => entry.y >= 1930), false, `${label}: both bottom-corner captions removed`);
      assert.equal(text.filter(value => /Starlight|星咲|After the Rain|長い曲名/.test(value)).length, 60,
        `${label}: only old 50/new 10 song names drawn, including rows outside the viewport`);
      const platinumText = data.text.filter(entry => entry.x >= 2170 && entry.y >= 292 && entry.y < 1944).map(entry => entry.text);
      assert.equal(platinumText.some(value => /Starlight|星咲|After the Rain|長い曲名|BASIC|ADVANCED|EXPERT|MASTER|LUNATIC|技术|Rating|FC|FB|AB|SSS?|星星/.test(value)), false,
        `${label}: platinum cards contain no song, difficulty text, tech score, grade, achievement or redundant star label`);
      assert.equal(platinumText.filter(value => value === '白金分').length, 50, `${label}: all 50 platinum scores have labels`);
      assert.equal(platinumText.filter(value => /^★\s*(?:[0-5]|—)$/.test(value)).length, 50, `${label}: all 50 platinum star values drawn`);
      assert.equal(platinumText.filter(value => /^定数 \d+(?:\.\d+)?$/.test(value)).length, 50, `${label}: all 50 platinum constants drawn`);
      assert.equal(platinumText.filter(value => /^\+\d+\.\d{5}$/.test(value)).length, 50, `${label}: all 50 individual total-Rating contributions drawn`);
      const platinumDetails = data.text.filter(entry => entry.x >= 2170 && entry.y >= 292 && entry.y < 1944);
      assert.equal(platinumDetails.filter(entry => /^★/.test(entry.text) && /\b24px\b/.test(entry.font)).length, 50,
        `${label}: platinum stars retain large type`);
      assert.equal(platinumDetails.filter(entry => entry.text === '1,980' && /\b26px\b/.test(entry.font)).length, 50,
        `${label}: platinum scores retain large type`);
      fs.writeFileSync(path.join(output, `${label}.png`), png);
      report.images.push({ label, width: data.width, height: data.height, bytes: png.length,
        textCalls: text.length, artworkDraws: data.imageCount });
      return data;
    };
    try {
      await win.loadFile(path.resolve(__dirname, '../dist/index.html'));
      win.webContents.debugger.attach('1.3');
      await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
      await wait(`document.querySelector('[data-nav-page="player-saves"]')`);
      await press('[data-nav-page="player-saves"]');
      await wait(`document.querySelector('[data-player-data-intro-dismiss]')`);await press('[data-player-data-intro-dismiss]');await wait(`!document.querySelector('[data-player-data-intro]')`);
      await wait(`document.querySelectorAll('.player-best-list > li').length === 110`);
      assert.deepEqual(await run(`Array.from(document.querySelectorAll('.player-best-list')).map(list => list.children.length)`), [50, 10, 50]);

      if (process.env.OGK_FOCUS_PERF_LABEL) {
        await measureScrollPerformance(process.env.OGK_FOCUS_PERF_LABEL.replace(/[^a-z0-9-]/gi, '_'));
        return;
      }

      const overview = await layout('landscape-overview');
      assert.equal(overview.focus, 0);
      assert.equal(overview.summaryInert, false);
      assert.equal(overview.asideInert, false);
      assert.equal(overview.directInert, false);
      assert.ok(overview.directCollapse.height > 50);
      await snapshot('landscape-overview');
      await wheel(75);
      const intermediate = await layout('landscape-intermediate');
      assert.ok(intermediate.focus > 0 && intermediate.focus < 1, 'small real wheel advances partial reveal');
      assert.ok(intermediate.list.height > overview.list.height, 'partial reveal gains list height');
      assert.ok(intermediate.list.width > overview.list.width, 'partial reveal gains list width');
      assert.ok(intermediate.directCollapse.height < overview.directCollapse.height, 'partial reveal collapses player controls');
      assert.ok(intermediate.direct.top <= overview.direct.top, 'player controls move up during reveal');
      assert.equal(intermediate.title.top, overview.title.top);
      await snapshot('landscape-intermediate');
      await wheel(250);
      await wait(`Number(getComputedStyle(document.querySelector('.player-save-results')).getPropertyValue('--player-focus')) === 1`);
      const focused = await layout('landscape-focused');
      assert.ok(focused.list.height > overview.list.height + 50);
      assert.ok(focused.list.width > overview.list.width + 100);
      assert.ok(focused.summary.height < 1);
      assert.equal(focused.summaryHidden, 'true');
      assert.equal(focused.summaryInert, true);
      assert.equal(focused.asideInert, true);
      assert.equal(focused.directInert, true);
      assert.ok(focused.directCollapse.height < 1, 'focused list reclaims player-controls height');
      assert.equal(focused.title.top, overview.title.top, 'page title stays fixed while player controls leave');
      await snapshot('landscape-focused');
      await wheel(-400);
      await wait(`document.querySelector('.player-best-scroll').scrollTop === 0`);
      const reversed = await layout('landscape-reversed');
      assert.equal(reversed.focus, 0);
      assert.equal(reversed.directInert, false);
      assert.equal(reversed.directCollapse.height, overview.directCollapse.height);

      // Keyboard scrolling and the explicit expansion/return affordance work
      // without the mouse, including when the user reaches the last section.
      await run(`document.querySelector('.player-best-scroll').focus()`);
      key('PageDown');
      await wait(`Number(getComputedStyle(document.querySelector('.player-save-results')).getPropertyValue('--player-focus')) === 1`);
      await sleep(500);
      key('End');
      await wait(`(() => { const e = document.querySelector('.player-best-scroll'); return e.scrollTop > 1000 && Math.abs(e.scrollHeight - e.clientHeight - e.scrollTop) < 2; })()`);
      await sleep(150);
      assert.equal(await progress(), 1);
      key('Home');
      await wait(`document.querySelector('.player-best-scroll').scrollTop === 0`);
      assert.equal(await progress(), 0);
      await press('[data-player-focus-toggle]');
      await wait(`document.querySelector('[data-player-focus-toggle]').getAttribute('aria-pressed') === 'true'`);
      await wait(`Number(getComputedStyle(document.querySelector('.player-save-results')).getPropertyValue('--player-focus')) === 1`);
      assert.equal(await progress(), 1);
      await returnOverview();

      // Drag the actual Chromium scrollbar thumb rather than setting scrollTop.
      const drag = await run(`(() => { const e = document.querySelector('.player-best-scroll'), r = e.getBoundingClientRect();
        const thumb = Math.max(18, (e.clientHeight - 36) * e.clientHeight / e.scrollHeight);
        return { x: Math.floor(r.right - 5), y: Math.floor(r.top + 18 + thumb / 2), end: Math.floor(r.top + Math.min(140, e.clientHeight - 20)) }; })()`);
      win.webContents.sendInputEvent({ type: 'mouseMove', x: drag.x, y: drag.y });
      win.webContents.sendInputEvent({ type: 'mouseDown', x: drag.x, y: drag.y, button: 'left', clickCount: 1 });
      await sleep(50);
      win.webContents.sendInputEvent({ type: 'mouseMove', x: drag.x, y: drag.end });
      await sleep(50);
      win.webContents.sendInputEvent({ type: 'mouseUp', x: drag.x, y: drag.end, button: 'left', clickCount: 1 });
      await wait(`document.querySelector('.player-best-scroll').scrollTop > 0`);
      await wait(`Number(getComputedStyle(document.querySelector('.player-save-results')).getPropertyValue('--player-focus')) === 1`);
      assert.equal(await progress(), 1);
      await returnOverview();

      await press('[data-player-focus-toggle]');
      await press('[data-record-tab="recent"]');
      await wait(`document.querySelectorAll('.player-recent-grid > li').length === 10`);
      assert.equal(await progress(), 0);
      assert.equal(await run(`document.querySelector('.player-summary-collapse').inert`), false);
      await press('[data-record-tab="best"]');
      await wait(`document.querySelector('.player-best-scroll')`);

      // The PNG is built from the complete ranking, independent of viewport,
      // focus state, and lazy thumbnails already loaded in the on-screen list.
      await openImage();
      const preview = await checkImage('score-image-complete');
      assert.ok(preview.imageCount >= 110, 'all 110 chart covers drawn');
      await checkPreviewSize('light-landscape');
      await snapshot('score-image-preview-light');
      await press('[data-score-image-save]');
      await wait(`window.__playerFocusImageTest.saveCalls.length === 1 && !document.querySelector('[data-score-image-save]').disabled`);
      assert.equal(await run(`!!document.querySelector('.player-save-toast')`), false, 'save cancellation remains quiet');
      assert.equal(await run(`!!document.querySelector('.player-score-image-artwork')`), true, 'cancel keeps generated image');
      await run(`window.__playerFocusImageTest.saveMode = 'error'`);
      await press('[data-score-image-save]');
      await wait(`document.querySelector('.player-score-image-preview [role="alert"]')?.textContent.includes('fixture image save failure')`);
      assert.equal(await run(`document.querySelector('.player-score-image-artwork').src`), preview.dataUrl, 'failure keeps preview for retry');
      await run(`window.__playerFocusImageTest.saveMode = 'success'`);
      await press('[data-score-image-save]');
      await wait(`window.__playerFocusImageTest.saveCalls.length === 3`);
      assert.equal(await run(`window.__playerFocusImageTest.saveCalls[2].dataUrl`), preview.dataUrl);
      assert.match(await run(`window.__playerFocusImageTest.saveCalls[2].fileName`), /\.png$/i);
      await wait(`!document.querySelector('.player-score-image-preview')`);
      await wait(`document.activeElement.hasAttribute('data-score-image-generate')`);
      assert.equal(await run(`!!document.querySelector('.player-save-toast')`), true, 'successful save confirms with page toast');

      await run(`window.__playerFocusImageTest.coverMode = 'fail'`);
      await openImage();
      const fallback = await checkImage('score-image-cover-fallback');
      assert.equal(fallback.imageCount, 0, 'failed covers render placeholders');
      await closeImage();
      for (const [mode, records, expected] of [['mixed', 4, '2026/10/2 08:03:00'], ['none', 0, '未记录'], ['invalid', 1, '未记录']]) {
        await run(`window.__playerFocusImageTest.playTimesMode = ${JSON.stringify(mode)}`);
        await press('[data-nav-page="settings"]'); await wait(`document.querySelector('.theme-choice')`);
        await press('[data-nav-page="player-saves"]'); await wait(`document.querySelector('.player-best-scroll')`);
        await press('[data-record-tab="recent"]');
        await wait(`document.querySelectorAll('.player-recent-grid > li').length === ${records}`);
        if (!records) await wait(`document.querySelector('.player-recent-empty')`);
        await press('[data-record-tab="best"]'); await wait(`document.querySelectorAll('.player-best-list > li').length === 110`);
        await openImage(); await checkImage(`score-image-play-time-${mode}`, expected); await closeImage();
      }
      await run(`window.__playerFocusImageTest.playTimesMode = 'recorded'`);
      await press('[data-nav-page="settings"]'); await wait(`document.querySelector('.theme-choice')`);
      await press('[data-nav-page="player-saves"]'); await wait(`document.querySelector('.player-best-scroll')`);
      await run(`window.__playerFocusImageTest.coverMode = 'ok'; window.__playerFocusImageTest.failGeneration = true`);
      await press('[data-score-image-generate]');
      await wait(`document.querySelector('.player-score-image-preview [role="alert"]')?.textContent.includes('fixture image generation failure')`);
      await run(`window.__playerFocusImageTest.failGeneration = false`);
      await press('[data-score-image-retry]');
      await wait(`document.querySelector('.player-score-image-artwork')?.naturalWidth === 2860`, 20000);
      await closeImage();
      await run(`window.__playerFocusImageTest.slowCovers = true`);
      await press('[data-score-image-generate]');
      await wait(`document.querySelector('.player-score-image-preview')`);
      key('Escape');
      await wait(`!document.querySelector('.player-score-image-preview')`);
      await wait(`document.activeElement.hasAttribute('data-score-image-generate')`);
      await sleep(700);
      assert.equal(await run(`!!document.querySelector('.player-score-image-preview')`), false, 'late generation never reopens dismissed preview');
      await run(`window.__playerFocusImageTest.slowCovers = false`);

      await press('[data-nav-page="settings"]');
      await wait(`document.querySelector('.theme-choice')`);
      await run(`Array.from(document.querySelectorAll('.theme-choice')).find(button => button.textContent === '深色').click()`);
      await press('[data-nav-page="player-saves"]');
      await wait(`document.querySelector('.player-best-scroll')`);
      for (const [width, height, name] of [[1440, 900, 'dark-landscape'], [1360, 720, 'short-landscape'], [720, 900, 'narrow-short'], [540, 1100, 'small-portrait']]) {
        win.setSize(width, height);
        await returnOverview();
        const initial = await layout(`${name}-overview`);
        await press('[data-player-focus-toggle]');
        await wait(`Number(getComputedStyle(document.querySelector('.player-save-results')).getPropertyValue('--player-focus')) === 1`);
        const expanded = await layout(`${name}-focused`);
        assert.ok(expanded.list.height > initial.list.height, `${name}: expanded list is taller`);
        assert.ok(expanded.directCollapse.height < 1, `${name}: player controls fully collapse`);
        assert.equal(expanded.directInert, true, `${name}: collapsed player controls cannot take focus`);
        assert.equal(expanded.title.top, initial.title.top, `${name}: title remains fixed`);
        await snapshot(`${name}-focused`);
        await returnOverview();
      }
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
      assert.equal(await run(`matchMedia('(prefers-reduced-motion: reduce)').matches`), true);
      await press('[data-player-focus-toggle]');
      await wait(`document.querySelector('.player-summary-collapse').inert && document.querySelector('.player-resource-aside').inert && document.querySelector('.player-direct-collapse').inert`);
      assert.equal((await layout('reduced-motion-focused')).focus, 1);
      await returnOverview();
      await openImage();
      await checkPreviewSize('dark-narrow');
      await snapshot('score-image-preview-dark-narrow');
      await closeImage();

      // A naturally short ranking uses the forced animation path. On the first
      // real wheel scroll, activate Return synchronously in the scroll event so
      // the unfinished expansion cannot race the restoration. No geometry API
      // is replaced: one anonymous old record also supplies its platinum card.
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
      await run(`window.__playerFocusImageTest.sparse = true`);
      await wait(`document.querySelectorAll('.player-best-list > li').length === 2`);
      let shortGeometry;
      for (const height of [1200, 1160, 1240, 1120, 1280, 1080, 1320, 1400]) {
        win.setSize(1440, height); await returnOverview(); await sleep(160);
        const value = await run(`(() => { const e = document.querySelector('.player-best-scroll'); return { scrollHeight: e.scrollHeight, clientHeight: e.clientHeight, overflow: e.scrollHeight - e.clientHeight }; })()`);
        if (value.overflow > 60 && value.overflow < 180) { shortGeometry = { height, ...value }; break; }
      }
      assert.ok(shortGeometry, 'sparse natural ranking has a small positive scroll range below the reveal threshold');
      report.shortList = { geometry: shortGeometry };
      await run(`(() => {
        const p = window.__playerFocusImageTest, list = document.querySelector('.player-best-scroll');
        p.shortRace = { started: performance.now(), trigger: null };
        const restore = () => {
          const focus = Number(getComputedStyle(document.querySelector('.player-save-results')).getPropertyValue('--player-focus'));
          if (!list.scrollTop || focus <= 0 || focus >= 1) return;
          p.shortRace.trigger = { elapsedMs: performance.now() - p.shortRace.started, scrollTop: list.scrollTop, focus };
          list.removeEventListener('scroll', restore); document.querySelector('[data-player-focus-toggle]').click();
        };
        p.stopShortRace = () => list.removeEventListener('scroll', restore);
        list.addEventListener('scroll', restore, { passive: true });
      })()`);
      await press('[data-player-focus-toggle]');
      await sleep(25);
      const racePoint = await run(`(() => { const r = document.querySelector('.player-best-scroll').getBoundingClientRect(); return { x: Math.floor(r.left + r.width / 2), y: Math.floor(r.bottom - 60) }; })()`);
      win.webContents.sendInputEvent({ type: 'mouseMove', ...racePoint });
      win.webContents.sendInputEvent({ type: 'mouseWheel', ...racePoint, deltaX: 0, deltaY: -4, canScroll: true });
      try {
        await wait(`window.__playerFocusImageTest.shortRace.trigger !== null`, 1500);
        const trigger = await run(`window.__playerFocusImageTest.shortRace.trigger`);
        assert.ok(trigger.elapsedMs < 220 && trigger.scrollTop > 0 && trigger.focus > 0 && trigger.focus < 1,
          'return activated with native scrollTop while forced expansion is still running');
        await sleep(300);
        assert.equal(await progress(), 0, 'unfinished expansion never reopens the returned overview');
        assert.equal(await run(`document.querySelector('.player-best-scroll').scrollTop`), 0);
        assert.equal(await run(`document.querySelector('.player-direct-collapse').inert`), false);
        report.shortList = { ...report.shortList, reproduced: true, trigger };
      } catch (error) {
        if (await run(`window.__playerFocusImageTest.shortRace.trigger === null`)) {
          report.shortList = { ...report.shortList, reproduced: false,
            limitation: 'Natural short-list geometry was present, but the real wheel did not produce positive scrollTop before expansion finished.' };
          console.log(report.shortList.limitation);
        } else throw error;
      } finally { await run(`window.__playerFocusImageTest.stopShortRace()`); }
      await returnOverview();

      assert.deepEqual(rendererErrors, []);
      report.rendererErrors = rendererErrors;
      fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2));
      console.log('Player focus/image UI passed: real wheel, scrollbar drag, keyboard, reversible expansion, responsive/reduced-motion layouts; complete 110-row PNG, preview/focus, cancellation, save failure/retry, artwork fallback, generation retry, late result dismissal.');
    } catch (error) {
      console.error(error);
      report.error = error.stack;
      report.rendererErrors = rendererErrors;
      report.finalState = await run(`(() => { const list = document.querySelector('.player-best-scroll'), surface = document.querySelector('.player-save-results');
        return { active: document.activeElement?.outerHTML.slice(0, 250), scrollTop: list?.scrollTop,
          scrollHeight: list?.scrollHeight, clientHeight: list?.clientHeight,
          focus: surface ? getComputedStyle(surface).getPropertyValue('--player-focus') : undefined }; })()`);
      fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2));
      await snapshot('failure');
      process.exitCode = 1;
    } finally {
      win.destroy();
      app.exit(process.exitCode ?? 0);
    }
  }).catch(error => { console.error(error); app.exit(1); });
}
