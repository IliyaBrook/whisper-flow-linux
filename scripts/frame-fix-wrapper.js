// Frame fix wrapper for Wispr Flow on Linux
// Intercepts BrowserWindow creation to force native window frames
// and fix keyboard/focus issues. Loaded before the main app.
const Module = require('module');
const originalRequire = Module.prototype.require;

// Detect Wayland vs X11 for platform-specific overlay behavior
const _isWayland = (process.env.XDG_SESSION_TYPE === 'wayland') || !!process.env.WAYLAND_DISPLAY;

// Detect overlay/popup windows that should stay frameless.
// Overlays have type:"toolbar" or alwaysOnTop+skipTaskbar.
// The hub window is the only one WITHOUT these overlay properties.
function isOverlayWindow(options) {
	if (!options) return false;
	if (options.type === 'toolbar') return true;
	if (options.alwaysOnTop && options.skipTaskbar) return true;
	return false;
}

// CSS to fix sidebar scrolling on Linux
const LINUX_SIDEBAR_CSS = `
  .KsLRKbYTWPTkbHC7lssN > .cHx1jPbInzLdZs5bVsGu > .DYfDg1NbrLuoPJVIlR_w {
    overflow-y: auto !important;
  }
`;

// Resolve the Wispr Flow logo for window icon
function getAppIconPath() {
	try {
		const path = require('path');
		const fs = require('fs');
		const p = path.join(process.resourcesPath || '', 'assets', 'logos', 'wispr-logo.png');
		if (fs.existsSync(p)) return p;
	} catch (e) { /* ignore */ }
	return null;
}

// Build patched classes once, reuse via Proxy.
let PatchedBrowserWindow = null;
let patchedSetApplicationMenu = null;

Module.prototype.require = function(id) {
	const result = originalRequire.apply(this, arguments);

	if (id === 'electron' || id === 'electron/main') {
		if (!PatchedBrowserWindow) {
			const OriginalBrowserWindow = result.BrowserWindow;
			const OriginalMenu = result.Menu;

			// --- Multi-display overlay configuration (shared state) ---
			let overlayConfig = {
				version: 2,
				enabledDisplayIds: [],
				perDisplay: {}
			};
			let overlayConfigPath = null;
			const activeOverlays = [];
			const cloneWindows = [];
			let positionWindow = null;

			function getDisplayForBounds(bounds) {
				const { screen: s } = require('electron');
				return s.getDisplayNearestPoint({
					x: bounds.x + (bounds.width || 0) / 2,
					y: bounds.y + (bounds.height || 0) / 2
				});
			}

			function getDisplayOffset(displayId) {
				const pd = overlayConfig.perDisplay[String(displayId)];
				return pd ? { x: pd.offsetX || 0, y: pd.offsetY || 0 } : { x: 0, y: 0 };
			}

			function loadOverlayConfig() {
				if (overlayConfigPath !== null) return;
				try {
					const path = require('path');
					const fs = require('fs');
					const { screen: s } = require('electron');
					overlayConfigPath = path.join(
						result.app.getPath('userData'),
						'linux-overlay-position.json'
					);
					const data = JSON.parse(fs.readFileSync(overlayConfigPath, 'utf8'));
					if (data.version === 2) {
						overlayConfig = data;
					} else {
						// v1 -> v2 migration
						const primaryId = s.getPrimaryDisplay().id;
						overlayConfig = {
							version: 2,
							enabledDisplayIds: [primaryId],
							perDisplay: {}
						};
						if (typeof data.offsetX === 'number' || typeof data.offsetY === 'number') {
							overlayConfig.perDisplay[String(primaryId)] = {
								offsetX: data.offsetX || 0,
								offsetY: data.offsetY || 0
							};
						}
						saveOverlayConfig();
					}
				} catch {
					if (!overlayConfigPath) {
						try {
							overlayConfigPath = require('path').join(
								result.app.getPath('userData'),
								'linux-overlay-position.json'
							);
						} catch { /* ignore */ }
					}
					try {
						const { screen: s } = require('electron');
						overlayConfig.enabledDisplayIds = [s.getPrimaryDisplay().id];
					} catch { /* screen not ready */ }
				}
			}

			function saveOverlayConfig() {
				if (!overlayConfigPath) return;
				try {
					const fs = require('fs');
					const path = require('path');
					fs.mkdirSync(path.dirname(overlayConfigPath), { recursive: true });
					fs.writeFileSync(
						overlayConfigPath,
						JSON.stringify(overlayConfig, null, 2),
						'utf8'
					);
				} catch { /* ignore */ }
			}

			function moveOverlay(displayId, dx, dy) {
				const key = String(displayId);
				if (!overlayConfig.perDisplay[key]) {
					overlayConfig.perDisplay[key] = { offsetX: 0, offsetY: 0 };
				}
				overlayConfig.perDisplay[key].offsetX += dx;
				overlayConfig.perDisplay[key].offsetY += dy;
				saveOverlayConfig();
				applyAllPositions();
			}

			function resetOverlay(displayId) {
				overlayConfig.perDisplay[String(displayId)] = { offsetX: 0, offsetY: 0 };
				saveOverlayConfig();
				applyAllPositions();
			}

			function applyAllPositions() {
				for (const o of activeOverlays) {
					if (!o.win.isDestroyed()) o.applyOffset();
				}
				for (const c of cloneWindows) {
					if (!c.win.isDestroyed()) updateClonePosition(c);
				}
			}

			function toggleDisplay(displayId) {
				const idx = overlayConfig.enabledDisplayIds.indexOf(displayId);
				if (idx >= 0) {
					if (overlayConfig.enabledDisplayIds.length <= 1) return;
					overlayConfig.enabledDisplayIds.splice(idx, 1);
				} else {
					overlayConfig.enabledDisplayIds.push(displayId);
				}
				saveOverlayConfig();
				applyAllPositions();
				syncAllClones();
			}

			function getClonePosition(sourceRef, targetDisplay) {
				const srcBounds = sourceRef.getBaseBounds();
				const srcDisplay = getDisplayForBounds(srcBounds);
				const relX = srcBounds.x - srcDisplay.workArea.x;
				const relY = srcBounds.y - srcDisplay.workArea.y;
				const offset = getDisplayOffset(targetDisplay.id);
				return {
					x: targetDisplay.workArea.x + relX + offset.x,
					y: targetDisplay.workArea.y + relY + offset.y
				};
			}

			function updateClonePosition(c, newSize) {
				if (c.win.isDestroyed()) return;
				const srcRef = activeOverlays.find(o => o.win === c.sourceWin);
				if (!srcRef) return;
				const { screen: s } = require('electron');
				const targetDisplay = s.getAllDisplays().find(d => d.id === c.displayId);
				if (!targetDisplay) return;
				const pos = getClonePosition(srcRef, targetDisplay);
				const size = newSize || c.win.getBounds();
				c.win.setBounds({ x: pos.x, y: pos.y, width: size.width, height: size.height });
			}

			function createCloneForDisplay(sourceRef, targetDisplay) {
				const sourceWin = sourceRef.win;
				if (sourceWin.isDestroyed()) return null;
				const srcBounds = sourceRef.getBaseBounds();
				const pos = getClonePosition(sourceRef, targetDisplay);
				const clone = new OriginalBrowserWindow({
					width: srcBounds.width,
					height: srcBounds.height,
					x: pos.x, y: pos.y,
					transparent: true,
					frame: false,
					alwaysOnTop: true,
					skipTaskbar: true,
					focusable: false,
					show: false,
					webPreferences: sourceRef.webPrefs ? { ...sourceRef.webPrefs } : {}
				});
				clone.setIgnoreMouseEvents(true);
				const url = sourceWin.webContents.getURL();
				if (url && url !== '' && url !== 'about:blank') {
					clone.loadURL(url).then(() => {
						if (!clone.isDestroyed() && sourceWin.isVisible()) clone.show();
					}).catch(() => {});
				}
				const entry = { sourceWin, displayId: targetDisplay.id, win: clone };
				cloneWindows.push(entry);
				clone.on('closed', () => {
					const idx = cloneWindows.indexOf(entry);
					if (idx >= 0) cloneWindows.splice(idx, 1);
				});
				return entry;
			}

			function destroyClonesForDisplay(displayId) {
				for (let i = cloneWindows.length - 1; i >= 0; i--) {
					if (cloneWindows[i].displayId === displayId) {
						if (!cloneWindows[i].win.isDestroyed()) cloneWindows[i].win.destroy();
						cloneWindows.splice(i, 1);
					}
				}
			}

			function syncAllClones() {
				for (const o of activeOverlays) syncClonesForOverlay(o);
			}

			function syncClonesForOverlay(ref) {
				const { screen: s } = require('electron');
				const displays = s.getAllDisplays();
				const sourceWin = ref.win;
				if (sourceWin.isDestroyed()) return;
				const enabledSet = new Set(overlayConfig.enabledDisplayIds.map(String));
				// Remove clones for disabled displays
				for (let i = cloneWindows.length - 1; i >= 0; i--) {
					const c = cloneWindows[i];
					if (c.sourceWin !== sourceWin) continue;
					if (!enabledSet.has(String(c.displayId))) {
						if (!c.win.isDestroyed()) c.win.destroy();
						cloneWindows.splice(i, 1);
					}
				}
				// Create clones for ALL enabled displays (original is always hidden)
				const existing = new Set(
					cloneWindows.filter(c => c.sourceWin === sourceWin).map(c => String(c.displayId))
				);
				for (const did of enabledSet) {
					if (existing.has(did)) continue;
					const target = displays.find(d => String(d.id) === did);
					if (target) createCloneForDisplay(ref, target);
				}
			}

			function getSettingsData() {
				const { screen: s } = require('electron');
				const displays = s.getAllDisplays();
				const primary = s.getPrimaryDisplay();
				return {
					displays: displays.map((d, i) => ({
						id: d.id,
						label: d.label || ('Display ' + (i + 1)),
						width: d.size.width,
						height: d.size.height,
						primary: d.id === primary.id
					})),
					enabledIds: overlayConfig.enabledDisplayIds,
					perDisplay: overlayConfig.perDisplay
				};
			}

			function updateSettingsUI() {
				if (!positionWindow || positionWindow.isDestroyed()) return;
				positionWindow.webContents.executeJavaScript(
					'refresh(' + JSON.stringify(getSettingsData()) + ')'
				).catch(() => {});
			}

			function openOverlayOptionsWindow() {
				if (positionWindow && !positionWindow.isDestroyed()) {
					positionWindow.focus();
					return;
				}
				loadOverlayConfig();
				positionWindow = new OriginalBrowserWindow({
					width: 350, height: 440,
					resizable: false, minimizable: false, maximizable: false,
					alwaysOnTop: true, title: 'Overlay Options',
					autoHideMenuBar: true,
					webPreferences: { sandbox: true }
				});
				positionWindow.setMenuBarVisibility(false);
				positionWindow.loadURL('about:blank');

				positionWindow.webContents.on('did-finish-load', () => {
					const data = getSettingsData();
					positionWindow.webContents.executeJavaScript(`
						document.documentElement.innerHTML = '<head><style>' +
						'*{margin:0;padding:0;box-sizing:border-box}' +
						'body{font-family:system-ui,sans-serif;background:#1e1e1e;color:#ddd;padding:16px;user-select:none}' +
						'.section{margin-bottom:14px}' +
						'.stitle{font-size:12px;color:#888;margin-bottom:8px;text-transform:uppercase;letter-spacing:0.5px}' +
						'.ditem{display:flex;align-items:center;gap:8px;padding:3px 0;font-size:13px}' +
						'.ditem input[type=checkbox]{accent-color:#5b9bd5;width:16px;height:16px}' +
						'.ptag{color:#5b9bd5;font-size:10px;margin-left:4px}' +
						'hr{border:none;border-top:1px solid #333;margin:10px 0}' +
						'.sel{display:flex;align-items:center;gap:8px;margin-bottom:10px;font-size:13px}' +
						'.sel select{background:#333;color:#eee;border:1px solid #444;border-radius:4px;padding:4px 8px;font-size:12px;flex:1}' +
						'.info{font-size:13px;color:#aaa;margin-bottom:10px;text-align:center}.info b{color:#fff}' +
						'.grid{display:grid;grid-template-columns:repeat(3,48px);grid-template-rows:repeat(3,40px);gap:4px;justify-content:center}' +
						'button{border:1px solid #444;background:#333;color:#eee;border-radius:5px;cursor:pointer;' +
						'font-size:18px;display:flex;align-items:center;justify-content:center}' +
						'button:hover{background:#444}button:active{background:#555}' +
						'.e{border:none;background:none;cursor:default}' +
						'.rst{margin-top:10px;padding:6px 24px;font-size:12px;border-radius:4px;display:block;margin-left:auto;margin-right:auto}' +
						'</style></head><body>' +
						'<div class="section"><div class="stitle">Active Displays</div><div id="dl"></div></div>' +
						'<hr>' +
						'<div class="section"><div class="stitle">Overlay Position</div>' +
						'<div class="sel"><label>Display:</label><select id="ds" onchange="os()"></select></div>' +
						'<div class="info">X = <b id="ox">0</b> &nbsp; Y = <b id="oy">0</b></div>' +
						'<div class="grid">' +
						'<div class="e"></div><button onclick="m(0,-20)">\\u25B2</button><div class="e"></div>' +
						'<button onclick="m(-50,0)">\\u25C0</button><button onclick="rs()" style="font-size:11px">\\u27F2</button><button onclick="m(50,0)">\\u25B6</button>' +
						'<div class="e"></div><button onclick="m(0,20)">\\u25BC</button><div class="e"></div>' +
						'</div>' +
						'<button class="rst" onclick="rs()">Reset</button>' +
						'</div></body>';
						var _d={},_s=null;
						function init(d){_d=d;_s=d.enabledIds.length>0?d.enabledIds[0]:(d.displays[0]?d.displays[0].id:null);rn();}
						function refresh(d){_d=d;if(_s&&!d.enabledIds.includes(_s)){_s=d.enabledIds[0]||(d.displays[0]&&d.displays[0].id);}rn();}
						function rn(){
							var el=document.getElementById('dl');
							if(!_d.displays||_d.displays.length===0){el.innerHTML='<div style="color:#666;padding:8px;text-align:center;font-size:12px">No displays</div>';return;}
							el.innerHTML=_d.displays.map(function(d){
								var ch=_d.enabledIds.includes(d.id)?' checked':'';
								var pr=d.primary?'<span class="ptag">(primary)</span>':'';
								return '<div class="ditem"><input type="checkbox"'+ch+' onchange="tg('+d.id+')"><span>'+d.label+' ('+d.width+'x'+d.height+')'+pr+'</span></div>';
							}).join('');
							var sel=document.getElementById('ds');
							var en=_d.displays.filter(function(d){return _d.enabledIds.includes(d.id);});
							sel.innerHTML=en.map(function(d){
								return '<option value="'+d.id+'"'+(d.id===_s?' selected':'')+'>'+d.label+' ('+d.width+'x'+d.height+')</option>';
							}).join('');
							if(!_s||!en.find(function(d){return d.id===_s;})){_s=en[0]?en[0].id:null;}
							var k=String(_s);
							var pd=(_d.perDisplay&&_d.perDisplay[k])||{offsetX:0,offsetY:0};
							document.getElementById('ox').textContent=pd.offsetX||0;
							document.getElementById('oy').textContent=pd.offsetY||0;
						}
						function os(){_s=parseInt(document.getElementById('ds').value);rn();}
						function tg(id){console.log('OVL:toggle:'+id);}
						function m(dx,dy){if(_s)console.log('OVL:move:'+_s+':'+dx+':'+dy);}
						function rs(){if(_s)console.log('OVL:reset:'+_s);}
						init(${JSON.stringify(data)});
					`);
				});

				positionWindow.webContents.on('console-message', (_e, _level, msg) => {
					if (!msg.startsWith('OVL:')) return;
					const p = msg.split(':');
					if (p[1] === 'toggle') {
						toggleDisplay(parseInt(p[2]));
					} else if (p[1] === 'move') {
						moveOverlay(parseInt(p[2]), parseInt(p[3]) || 0, parseInt(p[4]) || 0);
					} else if (p[1] === 'reset') {
						resetOverlay(parseInt(p[2]));
					}
					updateSettingsUI();
				});

				positionWindow.on('closed', () => { positionWindow = null; });
			}

			PatchedBrowserWindow = class BrowserWindowWithFrame extends OriginalBrowserWindow {
				constructor(options) {
					options = options || {};
					let isOverlay = false;

					if (process.platform === 'linux') {
						isOverlay = isOverlayWindow(options);
						if (process.env.WISPR_DEBUG === '1') {
							console.log(`[BrowserWindow] ${isOverlay ? 'OVERLAY' : 'MAIN'} w=${options.width} h=${options.height} type=${options.type} alwaysOnTop=${options.alwaysOnTop} transparent=${options.transparent} focusable=${options.focusable} skipTaskbar=${options.skipTaskbar} show=${options.show}`);
						}

						if (!isOverlay) {
							// Main/settings window: force native managed frame
							options.frame = true;
							options.transparent = false;
							options.autoHideMenuBar = true;
							if (options.focusable === false) {
								options.focusable = true;
							}
							delete options.titleBarStyle;
							delete options.titleBarOverlay;
							if (options.type) {
								delete options.type;
							}
							// Fit window to screen (title bar adds ~30px)
							try {
								const { screen } = require('electron');
								const display = screen.getPrimaryDisplay();
								const workArea = display.workAreaSize;
								if (options.height && options.height > workArea.height - 50) {
									options.height = workArea.height - 50;
								}
								if (options.width && options.width > workArea.width - 20) {
									options.width = workArea.width - 20;
								}
							} catch (e) { /* screen not ready */ }
						} else {
							// Overlay windows on Linux:
							// Remove type:"toolbar" - it binds the window to its parent.
							// Keep focusable:true so overlay buttons can be clicked.
							if (options.type === 'toolbar') {
								delete options.type;
							}
							if (options.focusable === false) {
								options.focusable = true;
							}
							// Prevent auto-show: we control visibility via clones
							options.show = false;
						}
					}

					super(options);

					if (process.platform === 'linux') {
						// Open DevTools for ALL windows in debug mode
						if (process.env.WISPR_DEBUG === '1') {
							this.webContents.on('dom-ready', () => {
								this.webContents.openDevTools({ mode: 'detach' });
							});
						}

						if (isOverlay) {
							const { screen: screenModule } = require('electron');
							const { execFile } = require('child_process');
							const debug = process.env.WISPR_DEBUG === '1';
							const win = this;
							const overlayWebPrefs = options.webPreferences ? { ...options.webPreferences } : {};

							// Save all original methods before any patching
							const origSetIgnore = this.setIgnoreMouseEvents.bind(this);
							const origSetBounds = this.setBounds.bind(this);
							const origSetPos = this.setPosition.bind(this);
							const origGetBounds = this.getBounds.bind(this);
							const origGetPos = this.getPosition.bind(this);

							// --- Mouse event forwarding emulation ---
							// {forward: true} is macOS-only. Poll cursor via xdotool
							// and check pixel alpha to toggle interactivity.
							let ignoring = false;
							let polling = false;

							this.setIgnoreMouseEvents = (ignore, _opts) => {
								origSetIgnore(ignore);
								ignoring = ignore;
								if (ignore) startPolling();
							};

							const getMousePos = () => new Promise((resolve) => {
								execFile('xdotool', ['getmouselocation', '--shell'],
									{ timeout: 500 },
									(err, stdout) => {
										if (!err && stdout) {
											const mx = parseInt((stdout.match(/X=(\d+)/) || [])[1]);
											const my = parseInt((stdout.match(/Y=(\d+)/) || [])[1]);
											if (!isNaN(mx) && !isNaN(my)) {
												return resolve({ x: mx, y: my });
											}
										}
										resolve(screenModule.getCursorScreenPoint());
									}
								);
							});

							async function pollTick() {
								if (win.isDestroyed()) { polling = false; return; }
								try {
									if (win.isVisible()) {
										let cursor;
										if (ignoring) {
											cursor = await getMousePos();
										} else {
											cursor = screenModule.getCursorScreenPoint();
										}

										// Use origGetBounds for actual screen position
										const b = origGetBounds();
										const inside = cursor.x >= b.x && cursor.x < b.x + b.width &&
										               cursor.y >= b.y && cursor.y < b.y + b.height;

										if (ignoring && inside) {
											const relX = Math.max(0, Math.min(cursor.x - b.x, b.width - 1));
											const relY = Math.max(0, Math.min(cursor.y - b.y, b.height - 1));

											// Check if cursor is over non-transparent content.
											let isHit = false;
											try {
												const img = await win.webContents.capturePage({
													x: relX, y: relY, width: 1, height: 1
												});
												const bmp = img.toBitmap();
												if (bmp.length >= 4 && bmp[3] > 10) {
													isHit = true;
													if (debug) console.log(`[Overlay] capturePage hit (${relX},${relY}) a=${bmp[3]}`);
												}
											} catch { /* capturePage failed */ }

											// Fallback: DOM hit-test via elementFromPoint
											if (!isHit && !win.isDestroyed() && ignoring) {
												try {
													isHit = await win.webContents.executeJavaScript(
														`(function(){` +
														`var e=document.elementFromPoint(${relX},${relY});` +
														`return !!(e&&e!==document.documentElement&&e!==document.body);` +
														`})()`
													);
													if (isHit && debug) console.log(`[Overlay] elementFromPoint hit (${relX},${relY})`);
												} catch { /* ignore */ }
											}

											if (!win.isDestroyed() && ignoring && isHit) {
												if (debug) console.log(`[Overlay] making interactive`);
												origSetIgnore(false);
												ignoring = false;
												if (!_isWayland) {
													win.moveTop();
													execFile('xdotool', [
														'mousemove', '--screen', '0',
														String(cursor.x), String(cursor.y)
													], { timeout: 500 }, () => {});
												}
											}
										} else if (!ignoring && !inside) {
											if (debug) console.log('[Overlay] cursor left bounds - click-through');
											origSetIgnore(true);
											ignoring = true;
										}
									}
								} catch (e) {
									if (debug) console.log('[Overlay] poll:', e.message);
								}
								if (!win.isDestroyed() && polling) {
									setTimeout(pollTick, ignoring ? 100 : 50);
								} else {
									polling = false;
								}
							}

							function startPolling() {
								if (polling) return;
								polling = true;
								setTimeout(pollTick, 50);
							}

							win.on('closed', () => { polling = false; });

							// --- Per-display position offset ---
							// Original overlay is ALWAYS invisible.
							// All visible overlays are our managed clones.
							loadOverlayConfig();
							let baseBounds = null;

							// Hide original: off-screen + opacity 0 (belt and suspenders)
							const hideOriginal = () => {
								if (win.isDestroyed()) return;
								const b = baseBounds || origGetBounds();
								origSetBounds({ x: -99999, y: -99999, width: b.width, height: b.height });
								try { win.setOpacity(0); } catch {}
							};

							const applyOffset = hideOriginal;

							const overlayRef = {
								win,
								applyOffset,
								getBaseBounds: () => baseBounds || origGetBounds(),
								origGetBounds,
								origSetBounds,
								webPrefs: overlayWebPrefs
							};
							activeOverlays.push(overlayRef);

							// Intercept setBounds/setPosition: store base, keep hidden, sync clones
							this.setBounds = (bounds, animate) => {
								baseBounds = { ...bounds };
								origSetBounds({ ...bounds, x: -99999, y: -99999 }, animate);
								try { win.setOpacity(0); } catch {}
								for (const c of cloneWindows) {
									if (c.sourceWin === win && !c.win.isDestroyed()) {
										updateClonePosition(c, { width: bounds.width, height: bounds.height });
									}
								}
							};

							this.setPosition = (x, y, animate) => {
								if (!baseBounds) baseBounds = origGetBounds();
								baseBounds.x = x;
								baseBounds.y = y;
								origSetPos(-99999, -99999, animate);
								try { win.setOpacity(0); } catch {}
								for (const c of cloneWindows) {
									if (c.sourceWin === win && !c.win.isDestroyed()) {
										updateClonePosition(c);
									}
								}
							};

							// Return base (pre-offset) position so the app
							// doesn't compound offsets on read->write cycles.
							this.getBounds = () => {
								if (baseBounds) return { ...baseBounds };
								return origGetBounds();
							};

							this.getPosition = () => {
								if (baseBounds) return [baseBounds.x, baseBounds.y];
								return origGetPos();
							};

							// Intercept show()/showInactive(): NEVER let original be visible.
							// Show clones instead.
							const origShow = win.show.bind(win);
							const origHide = win.hide.bind(win);
							let firstShowDone = false;

							win.show = function() {
								if (!firstShowDone) {
									firstShowDone = true;
									if (!baseBounds) {
										// Capture intended position before hiding
										const b = origGetBounds();
										if (b.x > -9000) baseBounds = { ...b };
									}
									hideOriginal();
									origShow();
									// Create clones after brief delay for content to load
									setTimeout(() => syncClonesForOverlay(overlayRef), 500);
								} else {
									hideOriginal();
									origShow();
								}
								for (const c of cloneWindows) {
									if (c.sourceWin === win && !c.win.isDestroyed()) c.win.show();
								}
							};

							win.showInactive = function() { win.show(); };

							win.hide = function() {
								origHide();
								for (const c of cloneWindows) {
									if (c.sourceWin === win && !c.win.isDestroyed()) c.win.hide();
								}
							};

							// Content sync: forward IPC messages to clones
							const origWCSend = win.webContents.send.bind(win.webContents);
							win.webContents.send = function(channel, ...args) {
								origWCSend(channel, ...args);
								for (const c of cloneWindows) {
									if (c.sourceWin === win && !c.win.isDestroyed()) {
										try { c.win.webContents.send(channel, ...args); } catch {}
									}
								}
							};

							// Content sync: forward URL navigation to clones
							const origLoadURL = win.loadURL.bind(win);
							win.loadURL = function(url, opts) {
								const p = origLoadURL(url, opts);
								for (const c of cloneWindows) {
									if (c.sourceWin === win && !c.win.isDestroyed()) {
										c.win.loadURL(url, opts).catch(() => {});
									}
								}
								return p;
							};

							// Move watcher: if app/WM somehow makes original visible, re-hide
							let reapplyGuard = false;
							let reapplyDebounce = null;
							win.on('move', () => {
								if (reapplyGuard) return;
								if (reapplyDebounce) clearTimeout(reapplyDebounce);
								reapplyDebounce = setTimeout(() => {
									if (win.isDestroyed()) return;
									const actual = origGetBounds();
									if (actual.x > -9999 && actual.y > -9999) {
										baseBounds = { ...actual };
										reapplyGuard = true;
										hideOriginal();
										for (const c of cloneWindows) {
											if (c.sourceWin === win && !c.win.isDestroyed()) {
												updateClonePosition(c, { width: actual.width, height: actual.height });
											}
										}
										setTimeout(() => { reapplyGuard = false; }, 300);
									}
								}, 50);
							});

							// Cleanup on close
							win.on('closed', () => {
								polling = false;
								const idx = activeOverlays.indexOf(overlayRef);
								if (idx >= 0) activeOverlays.splice(idx, 1);
								for (let i = cloneWindows.length - 1; i >= 0; i--) {
									if (cloneWindows[i].sourceWin === win) {
										if (!cloneWindows[i].win.isDestroyed()) cloneWindows[i].win.destroy();
										cloneWindows.splice(i, 1);
									}
								}
							});
						}

						if (!isOverlay) {
							this.setMenuBarVisibility(false);

							// Set window icon
							const iconPath = getAppIconPath();
							if (iconPath) {
								try {
									const { nativeImage } = require('electron');
									this.setIcon(nativeImage.createFromPath(iconPath));
								} catch (e) { /* ignore */ }
							}

							// Inject CSS to fix sidebar scrolling
							this.webContents.on('did-finish-load', () => {
								this.webContents.insertCSS(LINUX_SIDEBAR_CSS).catch(() => {});
							});

							this.on('show', () => {
								this.setMenuBarVisibility(false);
							});

							// Patch getContentBounds() for tiling WM compatibility
							let frameW = 0;
							let frameH = 0;
							let calibrated = false;
							const origGetContentBounds = this.getContentBounds.bind(this);

							this.getContentBounds = () => {
								if (calibrated && !this.isDestroyed()) {
									const [w, h] = this.getSize();
									const width = w - frameW;
									const height = h - frameH;
									if (width > 0 && height > 0) {
										return { x: 0, y: 0, width, height };
									}
								}
								return origGetContentBounds();
							};

							const reemitResize = () => {
								if (this.isDestroyed()) return;
								this.emit('resize');
								setTimeout(() => {
									if (!this.isDestroyed()) this.emit('resize');
								}, 16);
							};

							this.on('maximize', reemitResize);
							this.on('unmaximize', reemitResize);
							this.on('enter-full-screen', reemitResize);
							this.on('leave-full-screen', reemitResize);

							this.once('ready-to-show', () => {
								this.setMenuBarVisibility(false);
								const [w, h] = this.getSize();
								this.setSize(w + 1, h + 1);
								setTimeout(() => {
									if (this.isDestroyed()) return;
									this.setSize(w, h);
									setTimeout(() => {
										if (this.isDestroyed()) return;
										const [winW, winH] = this.getSize();
										const cb = origGetContentBounds();
										const fw = winW - cb.width;
										const fh = winH - cb.height;
										if (cb.width > 0 && cb.height > 0 && fw >= 0 && fh >= 0
											&& fw < 200 && fh < 200) {
											frameW = fw;
											frameH = fh;
											calibrated = true;
										}
									}, 100);
								}, 50);
							});

							this.on('focus', () => {
								this.flashFrame(false);
							});
						}
					}
				}
			};

			// Copy static methods and properties from original
			for (const key of Object.getOwnPropertyNames(OriginalBrowserWindow)) {
				if (key !== 'prototype' && key !== 'length' && key !== 'name') {
					try {
						const descriptor = Object.getOwnPropertyDescriptor(OriginalBrowserWindow, key);
						if (descriptor) {
							Object.defineProperty(PatchedBrowserWindow, key, descriptor);
						}
					} catch (e) { /* ignore non-configurable */ }
				}
			}

			// Intercept Menu.setApplicationMenu to hide menu bar
			const originalSetAppMenu = OriginalMenu.setApplicationMenu.bind(OriginalMenu);
			patchedSetApplicationMenu = function(menu) {
				originalSetAppMenu(menu);
				if (process.platform === 'linux') {
					for (const win of PatchedBrowserWindow.getAllWindows()) {
						if (win.isDestroyed()) continue;
						win.setMenuBarVisibility(false);
					}
				}
			};

			// Inject "Overlay Options..." item into the tray context menu
			if (process.platform === 'linux' && result.Tray) {
				const origSetCtxMenu = result.Tray.prototype.setContextMenu;
				result.Tray.prototype.setContextMenu = function(menu) {
					if (menu) {
						const MARKER = 'Overlay Options';
						const hasOurs = menu.items.some(i => i.label === MARKER);
						if (!hasOurs) {
							const { MenuItem } = require('electron');
							menu.append(new MenuItem({ type: 'separator' }));
							menu.append(new MenuItem({
								label: MARKER,
								click: () => openOverlayOptionsWindow()
							}));
						}
					}
					return origSetCtxMenu.call(this, menu);
				};
			}

			// --- Linux autostart (Launch at Login) ---
			if (process.platform === 'linux') {
				const _fs = require('fs');
				const _path = require('path');
				const _os = require('os');

				const autostartPath = _path.join(
					process.env.XDG_CONFIG_HOME || _path.join(_os.homedir(), '.config'),
					'autostart', 'wispr-flow.desktop'
				);

				const getExecPath = () => process.env.APPIMAGE || process.execPath;

				result.app.setLoginItemSettings = (settings) => {
					try {
						if (settings.openAtLogin) {
							const content = [
								'[Desktop Entry]',
								'Type=Application',
								'Name=Wispr Flow',
								'Comment=Voice-typing made perfect',
								`Exec="${getExecPath()}" --opened-at-login`,
								'Terminal=false',
								'X-GNOME-Autostart-enabled=true',
								'StartupNotify=false',
								''
							].join('\n');
							_fs.mkdirSync(_path.dirname(autostartPath), { recursive: true });
							_fs.writeFileSync(autostartPath, content);
						} else {
							_fs.unlinkSync(autostartPath);
						}
					} catch (e) { /* ignore */ }
				};

				result.app.getLoginItemSettings = () => ({
					openAtLogin: _fs.existsSync(autostartPath),
					wasOpenedAtLogin: process.argv.includes('--opened-at-login')
				});

				// Update autostart entry path on each launch (handles moved AppImage)
				result.app.whenReady().then(() => {
					try {
						if (_fs.existsSync(autostartPath)) {
							result.app.setLoginItemSettings({ openAtLogin: true });
						}
					} catch (e) { /* ignore */ }

					// Display hotplug: update settings UI and cleanup clones
					try {
						const { screen: s } = require('electron');
						s.on('display-added', () => {
							updateSettingsUI();
						});
						s.on('display-removed', (_event, oldDisplay) => {
							destroyClonesForDisplay(oldDisplay.id);
							const idx = overlayConfig.enabledDisplayIds.indexOf(oldDisplay.id);
							if (idx >= 0) {
								overlayConfig.enabledDisplayIds.splice(idx, 1);
								saveOverlayConfig();
							}
							updateSettingsUI();
						});
					} catch { /* ignore */ }
				});
			}
		}

		return new Proxy(result, {
			get(target, prop, receiver) {
				if (prop === 'BrowserWindow') return PatchedBrowserWindow;
				if (prop === 'Menu') {
					const originalMenu = target.Menu;
					return new Proxy(originalMenu, {
						get(menuTarget, menuProp) {
							if (menuProp === 'setApplicationMenu') return patchedSetApplicationMenu;
							return Reflect.get(menuTarget, menuProp);
						}
					});
				}
				return Reflect.get(target, prop, receiver);
			}
		});
	}

	return result;
};
