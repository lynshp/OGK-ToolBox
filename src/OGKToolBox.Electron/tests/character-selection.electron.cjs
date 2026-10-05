// Run after npm run build: node tests/character-selection.electron.cjs
// Uses the real built React UI, a hidden Electron window and an in-memory bridge.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

if (!process.versions.electron) {
  const { spawn } = require("node:child_process");
  const temporaryRoot = path.resolve(os.tmpdir());
  const profile = fs.mkdtempSync(path.join(temporaryRoot, "ogk-characters-ui-"));
  const env = { ...process.env, OGK_CHARACTER_TEST_PROFILE: profile, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require("electron"), [__filename], { env, stdio: "inherit", windowsHide: true });
  function cleanup() {
    // Only remove the uniquely created test profile, never the real Electron profile.
    const target = path.resolve(profile);
    if (path.dirname(target) !== temporaryRoot || !path.basename(target).startsWith("ogk-characters-ui-"))
      throw new Error(`Unexpected test profile location: ${target}`);
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
  child.on("error", error => { console.error(error); cleanup(); process.exitCode = 1; });
  child.on("exit", code => { cleanup(); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = require("electron");
  const profile = process.env.OGK_CHARACTER_TEST_PROFILE;
  if (!profile) throw new Error("Run this test through Node so its profile can be isolated and cleaned up.");
  app.setPath("userData", profile);
  app.setPath("sessionData", path.join(profile, "session"));
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("in-process-gpu");

  async function run() {
    const index = path.resolve(process.env.OGK_CHARACTER_TEST_DIST || path.join(__dirname, "../dist"), "index.html");
    assert.ok(fs.existsSync(index), "Build the Electron frontend before running this test.");
    await app.whenReady();
    const win = new BrowserWindow({
      show: false, width: 1280, height: 900,
      webPreferences: {
        preload: path.join(__dirname, "character-selection.preload.cjs"),
        contextIsolation: false, sandbox: false, backgroundThrottling: false, offscreen: true
      }
    });
    const errors = [];
    win.webContents.on("console-message", details => {
      // Chromium reports this existing meta-CSP limitation as a console error.
      const metaCspNotice = "The Content Security Policy directive 'frame-ancestors' is ignored when delivered via a <meta> element.";
      if (details.level === "error" && details.message !== metaCspNotice) errors.push(details.message);
    });
    // Fixtures do not need any external services or hardware.
    win.webContents.session.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (_details, done) => done({ cancel: true }));
    const evaluate = source => win.webContents.executeJavaScript(source, true);
    const control = source => evaluate(`window.__characterSelectionTest.${source}`);
    const settle = () => evaluate("new Promise(resolve => setTimeout(resolve, 60))");
    async function waitFor(source, description) {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if (await evaluate(source)) return;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      throw new Error(`Timed out waiting for ${description}. Renderer errors: ${errors.join("\n")}`);
    }
    const selectedModel = () => evaluate("document.querySelector('.character-list .selected-row small')?.textContent");
    const stageName = () => evaluate("document.querySelector('.character-stage h2')?.textContent");
    const requests = async (kind, modelId) => (await control("state()")).requests.filter(request =>
      request.kind === kind && (kind === "list" ? request.payload.modelId === modelId : request.payload.bundlePath === `fixture-${modelId}`));
    async function select(index) {
      await evaluate(`document.querySelectorAll('.character-list button')[${index}].click()`);
      await waitFor(`document.querySelector('.character-list .selected-row small')?.textContent === 'Model ${1000 + index}'`, `selection ${1000 + index}`);
      await settle();
    }
    try {
      await win.loadFile(index);
      // Keep native focus/blur semantics active without showing or focusing a desktop window.
      win.webContents.debugger.attach("1.3");
      await win.webContents.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
      await waitFor("!!document.querySelector('.app.boot-ready')", "fixture startup");
      await evaluate("document.querySelector('[data-nav-page=characters]').click()");
      await waitFor("document.querySelectorAll('.character-list button').length === 3 && window.__characterSelectionTest.state().sectionCount > 0", "the character page");
      await settle();
      assert.ok((await requests("list", 1000)).length > 0, "The first character list must still be pending.");

      // A parent update while the first and second lists are pending must not reset selection.
      await select(1);
      const secondListCount = (await requests("list", 1001)).length;
      assert.equal(secondListCount, 1);
      await control("rerender(true)");
      await settle();
      assert.equal(await selectedModel(), "Model 1001", "Parent rerender must preserve the user's pending character selection.");
      assert.equal(await stageName(), "角色 B");
      assert.equal((await requests("list", 1001)).length, secondListCount, "Unrelated parent updates must not restart expressions.");

      // A real scan replaces character objects/arrays. Keep selection by model ID.
      await evaluate("[...document.querySelectorAll('main > header button')].find(button => button.textContent.includes('重新扫描')).click()");
      await waitFor("window.__characterSelectionTest.state().scanCount === 1 && [...document.querySelectorAll('main > header button')].some(button => button.textContent.includes('重新扫描') && !button.disabled)", "fixture rescan");
      await settle();
      assert.equal(await selectedModel(), "Model 1001", "Fresh character objects must preserve selection by model ID.");
      assert.equal((await requests("list", 1001)).length, secondListCount, "Replacing equivalent data must not restart expressions.");

      await control("resolveList(1000, 3)");
      await settle();
      assert.equal(await selectedModel(), "Model 1001");
      assert.equal(await evaluate("document.querySelectorAll('.expressions button').length"), 0, "A stale list must not replace the pending current list.");
      assert.equal((await requests("preview", 1000)).length, 0, "A stale list must not start preview work.");

      await control("resolveList(1001, 6)");
      await waitFor("document.querySelectorAll('.expressions button').length === 6 && window.__characterSelectionTest.state().requests.filter(request => request.kind === 'preview' && request.payload.bundlePath === 'fixture-1001').length === 2", "bounded preview workers");
      await select(2);
      await control("resolvePreviews(1001)");
      await settle();
      assert.equal((await requests("preview", 1001)).length, 2, "Switching characters must stop queued work after the two in-flight previews finish.");
      assert.equal(await stageName(), "角色 C");
      assert.equal(await evaluate("document.querySelectorAll('.character-stage img').length"), 0, "Stale previews must not appear on the new character.");
      assert.equal(await evaluate("document.querySelectorAll('.expressions button').length"), 0);

      await control("resolveList(1002, 1)");
      await waitFor("window.__characterSelectionTest.state().requests.some(request => request.kind === 'preview' && request.payload.bundlePath === 'fixture-1002')", "the current preview");
      await control("resolvePreviews(1002)");
      await waitFor("!!document.querySelector('.character-stage img') && document.querySelector('.expression-preview').getAttribute('aria-busy') === 'false'", "the current loaded preview");
      assert.match(await evaluate("document.querySelector('.character-stage img').src"), /1002/);
      await control("rerender(false)");
      await settle();
      assert.equal(await selectedModel(), "Model 1002");
      assert.equal((await requests("list", 1002)).length, 1);
      if (process.env.OGK_CHARACTER_TEST_SCREENSHOT) {
        const target = path.resolve(process.env.OGK_CHARACTER_TEST_SCREENSHOT);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        win.webContents.invalidate();
        await settle();
        fs.writeFileSync(target, (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
      }
      console.log("PASS: pending character selection survives parent updates and fresh scan data; stale lists/previews are ignored; old preview queues stop; current selection is not refetched.");

      // Use Chromium's actual keyboard editing through the existing document handlers.
      await evaluate("document.querySelector('[data-nav-page=home]').click()");
      await waitFor("!!document.querySelector('.launch-settings-trigger')", "Home");
      await evaluate("document.querySelector('.launch-settings-trigger').click()");
      await waitFor("document.querySelectorAll('.launch-settings-popover input').length === 2", "launch settings");
      const inputValue = index => evaluate(`document.querySelectorAll('.launch-settings-popover input')[${index}].value`);
      const storedOptions = () => evaluate("JSON.parse(localStorage.getItem('ogk-toolbox.launch-options.v1'))");
      const opensslSwitch = "document.querySelector('[aria-labelledby=openssl-fix-label]')";
      assert.equal(await evaluate(`${opensslSwitch}.getAttribute('aria-checked')`), "false", "OpenSSL fix defaults off for existing preferences.");
      assert.equal((await storedOptions()).fixOpenSsl, false);
      async function key(keyCode, modifiers = []) {
        win.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
        win.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
        await settle();
      }
      async function clearInput(index) {
        await evaluate(`document.querySelectorAll('.launch-settings-popover input')[${index}].focus()`);
        win.webContents.focus();
        await evaluate("window.__editingEvents = []; window.__recordEditing = event => window.__editingEvents.push({type:event.type,key:event.key,ctrl:event.ctrlKey,prevented:event.defaultPrevented,target:event.target.tagName}); document.addEventListener('keydown', window.__recordEditing); document.addEventListener('selectstart', window.__recordEditing)");
        await key("A", ["control"]);
        await key("Backspace");
        const editingEvents = await evaluate("document.removeEventListener('keydown', window.__recordEditing); document.removeEventListener('selectstart', window.__recordEditing); ({focused:document.activeElement?.tagName,events:window.__editingEvents})");
        assert.equal(await inputValue(index), "", `Ctrl+A / Backspace must allow an empty editing draft. ${JSON.stringify(editingEvents)}`);
      }
      async function type(text) {
        for (const character of text) {
          win.webContents.sendInputEvent({ type: "char", keyCode: character });
          await settle();
        }
      }
      async function blur() {
        await evaluate("document.querySelector('.launch-settings-trigger').focus()");
        await settle();
      }

      await clearInput(0);
      await type("1");
      assert.equal(await inputValue(0), "1", "Typing an incomplete width must not clamp it to 320.");
      assert.equal((await storedOptions()).width, 1080, "Partial edits must not overwrite the saved width.");
      await type("080");
      await key("Tab");
      assert.equal(await inputValue(0), "1080");
      await clearInput(1);
      await type("1920");
      await key("Enter");
      assert.equal((await storedOptions()).height, 1920);

      await clearInput(0);
      await type("99999");
      await blur();
      assert.equal(await inputValue(0), "8192", "Commit must clamp values above the maximum.");
      await clearInput(0);
      await blur();
      assert.equal(await inputValue(0), "8192", "An empty committed draft must restore the last saved dimension.");
      await clearInput(0);
      await type("100");
      await key("Enter");
      assert.equal((await storedOptions()).width, 320, "Commit must still enforce the minimum.");

      await clearInput(0);
      await type("1600");
      await evaluate("document.querySelector('.launch-game-card').click()");
      await waitFor("window.__characterSelectionTest.state().launches.length === 1", "the in-memory launch");
      assert.deepEqual((await control("state()")).launches[0].options, { width: 1600, height: 1920, fullscreen: true, fixOpenSsl: false }, "Launching before blur must use the current draft.");
      await evaluate(`${opensslSwitch}.focus()`);
      await key("Space");
      assert.equal(await evaluate(`${opensslSwitch}.getAttribute('aria-checked')`), "true");
      assert.equal((await storedOptions()).fixOpenSsl, true);
      assert.match(await evaluate("document.querySelector('#openssl-fix-hint').textContent"), /Intel Core.*10/);
      await evaluate("document.querySelector('.launch-game-card').click()");
      await waitFor("window.__characterSelectionTest.state().launches.length === 2", "launch with OpenSSL fix");
      assert.deepEqual((await control("state()")).launches[1].options, { width: 1600, height: 1920, fullscreen: true, fixOpenSsl: true });
      await new Promise(resolve => { win.webContents.once("did-finish-load", resolve); win.webContents.reload(); });
      await waitFor("!!document.querySelector('.launch-settings-trigger')", "Home after reload");
      await waitFor("document.querySelector('.app').classList.contains('boot-ready') && getComputedStyle(document.querySelector('.boot-loading-screen')).visibility === 'hidden'", "startup overlay to finish");
      await evaluate("document.querySelector('.launch-settings-trigger').click()");
      await waitFor(`!!${opensslSwitch}`, "OpenSSL switch after reload");
      assert.equal(await evaluate(`${opensslSwitch}.getAttribute('aria-checked')`), "true", "OpenSSL preference survives reload.");
      if (process.env.OGK_LAUNCH_TEST_SCREENSHOT) {
        const directory = path.resolve(process.env.OGK_LAUNCH_TEST_SCREENSHOT);
        fs.mkdirSync(directory, { recursive: true });
        for (const dark of [false, true]) {
          await evaluate(`document.querySelector('.app').classList.toggle('dark', ${dark})`);
          win.webContents.invalidate();
          await evaluate("new Promise(resolve => setTimeout(resolve, 350))");
          fs.writeFileSync(path.join(directory, `launch-${dark ? 'dark' : 'light'}.png`),
            (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
        }
      }
      await settle();
      await evaluate(`${opensslSwitch}.focus()`);
      await key("Space");
      assert.equal((await storedOptions()).fixOpenSsl, false, "Keyboard can turn OpenSSL fix back off.");
      assert.deepEqual(errors, [], "The real renderer must remain free of errors.");
      console.log("PASS: resolution inputs support clear and incremental keyboard entry, blur/Enter commits, bounds, empty restoration, and launch while editing.");
      console.log("PASS: OpenSSL default, keyboard toggle, recommendation, launch payload and preference persistence.");
    } finally {
      win.destroy();
    }
  }
  const timeout = setTimeout(() => { console.error("Electron UI regression timed out."); app.exit(1); }, 30000);
  run().then(() => { clearTimeout(timeout); app.exit(0); }).catch(error => { clearTimeout(timeout); console.error(error); app.exit(1); });
}
