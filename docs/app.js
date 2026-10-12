(() => {
  'use strict';

  const APP_VERSION = '13.0.0';
  const STORAGE_KEY = 'irRemoteLab.remotes.v1';
  const app = document.getElementById('app');
  const modalRoot = document.getElementById('modalRoot');
  const connectButton = document.getElementById('connectButton');
  const serialStatus = document.getElementById('serialStatus');
  const installButton = document.getElementById('installButton');
  const toastRoot = document.getElementById('toastRoot');

  const state = {
    remotes: loadRemotes(),
    currentRemoteId: null,
    selectedPatternId: 'tv',
    customPattern: null,
    serial: {
      port: null,
      reader: null,
      writer: null,
      readBuffer: '',
      connected: false,
      connecting: false,
      connectPromise: null,
      backend: null,
      listeners: new Set()
    },
    cloning: null,
    recognition: null,
    autoSearch: null,
    viewEpoch: 0,
    currentView: 'boot',
    acquisitionController: null,
    installPrompt: null
  };

  class AcquisitionCancelledError extends Error {
    constructor(message = 'Acquisizione annullata.') { super(message); this.name = 'AcquisitionCancelledError'; }
  }

  function isAcquisitionCancelled(error) {
    return error?.name === 'AbortError' || error?.name === 'AcquisitionCancelledError';
  }

  function sendSerialIfConnected(line) {
    if (!state.serial.connected || !state.serial.writer) return Promise.resolve(false);
    const stamp = new Date().toISOString().slice(11, 23);
    console.log(`[${stamp}] SERIAL TX`, line);
    const data = new TextEncoder().encode(`${line}\n`);
    return state.serial.writer.write(data).then(() => true).catch(() => false);
  }

  function cancelActiveAcquisition(options = {}) {
    const controller = state.acquisitionController;
    const hadActiveAcquisition = !!controller && !controller.signal.aborted;
    if (hadActiveAcquisition) controller.abort();
    state.acquisitionController = null;
    // Do not send CANCEL merely because the user changed screen. In v09 this
    // produced delayed CANCELLED replies that could arrive after the next LEARN
    // and abort a completely new acquisition. Only cancel Arduino when there
    // really was a live acquisition (or a caller explicitly forces it).
    if (options.sendCancel !== false && (hadActiveAcquisition || options.force === true)) {
      sendSerialIfConnected('CANCEL');
    }
    return hadActiveAcquisition;
  }

  function enterView(name, options = {}) {
    state.viewEpoch++;
    if (state.autoSearch && name !== 'auto-search') {
      state.autoSearch.active = false;
      state.autoSearch = null;
    }
    state.currentView = name;
    if (options.keepAcquisition !== true) cancelActiveAcquisition({ sendCancel: options.sendCancel !== false });
    if (options.keepModal !== true) modalRoot.innerHTML = '';
    return state.viewEpoch;
  }

  const PATTERNS = {
    compact: {
      schema: 'ir-pattern-v1', id: 'compact', name: 'Compatto universale', width: 280, height: 620,
      body: { x: 20, y: 10, w: 240, h: 600, rx: 52 },
      decorations: [{ type: 'rect', x: 95, y: 34, w: 90, h: 18, rx: 8 }],
      buttons: [
        b('power', 'Power', 112, 72, 56, 42, 'rounded', 'power'),
        b('key_1', '1', 55, 150, 48, 40), b('key_2', '2', 116, 150, 48, 40), b('key_3', '3', 177, 150, 48, 40),
        b('key_4', '4', 55, 205, 48, 40), b('key_5', '5', 116, 205, 48, 40), b('key_6', '6', 177, 205, 48, 40),
        b('up', 'Up', 116, 285, 48, 40), b('left', 'Left', 58, 335, 48, 40), b('ok', 'OK', 116, 335, 48, 40), b('right', 'Right', 174, 335, 48, 40), b('down', 'Down', 116, 385, 48, 40),
        b('key_a', 'A', 60, 475, 65, 42), b('key_b', 'B', 155, 475, 65, 42)
      ]
    },
    tv: {
      schema: 'ir-pattern-v1', id: 'tv', name: 'TV classico', width: 320, height: 780,
      body: { x: 22, y: 10, w: 276, h: 760, rx: 62 },
      decorations: [{ type: 'rect', x: 112, y: 35, w: 96, h: 18, rx: 9 }],
      buttons: [
        b('power', 'Power', 52, 78, 58, 44, 'rounded', 'power'), b('input', 'Input', 210, 78, 58, 44, 'rounded', 'input'),
        b('key_1', '1', 57, 160, 52, 42), b('key_2', '2', 134, 160, 52, 42), b('key_3', '3', 211, 160, 52, 42),
        b('key_4', '4', 57, 214, 52, 42), b('key_5', '5', 134, 214, 52, 42), b('key_6', '6', 211, 214, 52, 42),
        b('key_7', '7', 57, 268, 52, 42), b('key_8', '8', 134, 268, 52, 42), b('key_9', '9', 211, 268, 52, 42),
        b('mute', 'Mute', 57, 322, 52, 42, 'rounded', 'mute'), b('key_0', '0', 134, 322, 52, 42), b('back', 'Back', 211, 322, 52, 42, 'rounded', 'back'),
        b('up', 'Up', 134, 405, 52, 42, 'rounded', 'up'), b('left', 'Left', 72, 457, 52, 42, 'rounded', 'left'), b('ok', 'OK', 134, 457, 52, 42, 'rounded', 'ok'), b('right', 'Right', 196, 457, 52, 42, 'rounded', 'right'), b('down', 'Down', 134, 509, 52, 42, 'rounded', 'down'),
        b('vol_up', 'Vol +', 55, 585, 72, 44, 'rounded', 'volume_up'), b('ch_up', 'Ch +', 193, 585, 72, 44, 'rounded', 'channel_up'),
        b('vol_down', 'Vol -', 55, 640, 72, 44, 'rounded', 'volume_down'), b('ch_down', 'Ch -', 193, 640, 72, 44, 'rounded', 'channel_down'),
        b('home', 'Home', 124, 704, 72, 40, 'rounded', 'home')
      ]
    },
    smart_tv: {
      schema: 'ir-pattern-v1', id: 'smart_tv', name: 'Smart TV moderno', width: 300, height: 700,
      body: { x: 24, y: 10, w: 252, h: 680, rx: 70 },
      decorations: [{ type: 'circle', cx: 150, cy: 48, r: 8 }],
      buttons: [
        b('power', 'Power', 54, 78, 58, 42, 'rounded', 'power'), b('input', 'Input', 188, 78, 58, 42, 'rounded', 'input'),
        b('mic', 'Mic', 112, 138, 76, 38),
        b('up', 'Up', 124, 205, 52, 42, 'rounded', 'up'), b('left', 'Left', 64, 252, 52, 42, 'rounded', 'left'), b('ok', 'OK', 124, 252, 52, 42, 'circle', 'ok'), b('right', 'Right', 184, 252, 52, 42, 'rounded', 'right'), b('down', 'Down', 124, 299, 52, 42, 'rounded', 'down'),
        b('home', 'Home', 55, 365, 72, 40, 'rounded', 'home'), b('back', 'Back', 173, 365, 72, 40, 'rounded', 'back'),
        b('vol_up', 'Vol +', 53, 432, 78, 44, 'rounded', 'volume_up'), b('ch_up', 'Ch +', 169, 432, 78, 44, 'rounded', 'channel_up'),
        b('vol_down', 'Vol -', 53, 485, 78, 44, 'rounded', 'volume_down'), b('ch_down', 'Ch -', 169, 485, 78, 44, 'rounded', 'channel_down'),
        b('mute', 'Mute', 53, 538, 78, 40, 'rounded', 'mute'), b('play_pause', 'Play/Pause', 169, 538, 78, 40, 'rounded', 'play'),
        b('app_1', 'App 1', 48, 610, 62, 38), b('app_2', 'App 2', 119, 610, 62, 38), b('app_3', 'App 3', 190, 610, 62, 38)
      ]
    },
    media: {
      schema: 'ir-pattern-v1', id: 'media', name: 'Media / DVD / Blu-ray', width: 320, height: 760,
      body: { x: 24, y: 10, w: 272, h: 740, rx: 58 },
      decorations: [{ type: 'rect', x: 112, y: 34, w: 96, h: 18, rx: 9 }],
      buttons: [
        b('power', 'Power', 52, 80, 62, 44, 'rounded', 'power'), b('eject', 'Eject', 206, 80, 62, 44, 'rounded', 'eject'),
        b('key_1', '1', 58, 160, 52, 40), b('key_2', '2', 134, 160, 52, 40), b('key_3', '3', 210, 160, 52, 40),
        b('key_4', '4', 58, 212, 52, 40), b('key_5', '5', 134, 212, 52, 40), b('key_6', '6', 210, 212, 52, 40),
        b('key_7', '7', 58, 264, 52, 40), b('key_8', '8', 134, 264, 52, 40), b('key_9', '9', 210, 264, 52, 40),
        b('menu', 'Menu', 58, 326, 62, 40, 'rounded', 'menu'), b('key_0', '0', 129, 326, 62, 40), b('back', 'Back', 200, 326, 62, 40, 'rounded', 'back'),
        b('up', 'Up', 134, 400, 52, 40, 'rounded', 'up'), b('left', 'Left', 72, 450, 52, 40, 'rounded', 'left'), b('ok', 'OK', 134, 450, 52, 40, 'rounded', 'ok'), b('right', 'Right', 196, 450, 52, 40, 'rounded', 'right'), b('down', 'Down', 134, 500, 52, 40, 'rounded', 'down'),
        b('prev', 'Prev', 48, 585, 62, 42, 'rounded', 'prev'), b('play', 'Play', 129, 585, 62, 42, 'rounded', 'play'), b('next', 'Next', 210, 585, 62, 42, 'rounded', 'next'),
        b('stop', 'Stop', 83, 642, 62, 42, 'rounded', 'stop'), b('pause', 'Pause', 175, 642, 62, 42, 'rounded', 'pause')
      ]
    },
    audio_receiver: {
      schema: 'ir-pattern-v1', id: 'audio_receiver', name: 'Amplificatore / Receiver AV', width: 340, height: 820,
      body: { x: 24, y: 10, w: 292, h: 800, rx: 56 },
      decorations: [{ type: 'rect', x: 118, y: 38, w: 104, h: 18, rx: 8 }],
      buttons: [
        b('power', 'Power', 52, 82, 64, 42, 'rounded', 'power'), b('mute', 'Mute', 224, 82, 64, 42, 'rounded', 'mute'),
        b('input_tv', 'TV', 45, 154, 72, 40, 'rounded', 'input'), b('input_bd', 'BD', 134, 154, 72, 40, 'rounded', 'input'), b('input_aux', 'AUX', 223, 154, 72, 40, 'rounded', 'input'),
        b('input_cd', 'CD', 45, 204, 72, 40), b('input_game', 'Game', 134, 204, 72, 40), b('input_tuner', 'Tuner', 223, 204, 72, 40),
        b('vol_up', 'Vol +', 54, 286, 88, 48, 'rounded', 'volume_up'), b('vol_down', 'Vol -', 54, 344, 88, 48, 'rounded', 'volume_down'),
        b('ch_up', 'Preset +', 198, 286, 88, 48, 'rounded', 'channel_up'), b('ch_down', 'Preset -', 198, 344, 88, 48, 'rounded', 'channel_down'),
        b('up', 'Up', 144, 430, 52, 42, 'rounded', 'up'), b('left', 'Left', 84, 480, 52, 42, 'rounded', 'left'), b('ok', 'OK', 144, 480, 52, 42, 'circle', 'ok'), b('right', 'Right', 204, 480, 52, 42, 'rounded', 'right'), b('down', 'Down', 144, 530, 52, 42, 'rounded', 'down'),
        b('menu', 'Menu', 60, 596, 72, 40, 'rounded', 'menu'), b('back', 'Back', 208, 596, 72, 40, 'rounded', 'back'),
        b('play', 'Play', 58, 674, 62, 40, 'rounded', 'play'), b('pause', 'Pause', 139, 674, 62, 40, 'rounded', 'pause'), b('stop', 'Stop', 220, 674, 62, 40, 'rounded', 'stop'),
        b('sound_mode', 'Sound', 113, 738, 114, 40)
      ]
    },
    soundbar: {
      schema: 'ir-pattern-v1', id: 'soundbar', name: 'Soundbar', width: 280, height: 580,
      body: { x: 22, y: 10, w: 236, h: 560, rx: 64 },
      decorations: [{ type: 'circle', cx: 140, cy: 48, r: 7 }],
      buttons: [
        b('power', 'Power', 52, 82, 62, 42, 'rounded', 'power'), b('mute', 'Mute', 166, 82, 62, 42, 'rounded', 'mute'),
        b('input', 'Source', 91, 150, 98, 42, 'rounded', 'input'),
        b('vol_up', 'Vol +', 76, 218, 128, 48, 'rounded', 'volume_up'), b('vol_down', 'Vol -', 76, 276, 128, 48, 'rounded', 'volume_down'),
        b('bass_up', 'Bass +', 48, 352, 82, 42), b('bass_down', 'Bass -', 150, 352, 82, 42),
        b('sound_mode', 'Mode', 48, 408, 82, 42), b('night', 'Night', 150, 408, 82, 42),
        b('bluetooth', 'BT', 48, 468, 82, 42), b('subwoofer', 'Sub', 150, 468, 82, 42)
      ]
    },
    settop: {
      schema: 'ir-pattern-v1', id: 'settop', name: 'Decoder / Set-top box', width: 320, height: 780,
      body: { x: 22, y: 10, w: 276, h: 760, rx: 54 },
      decorations: [{ type: 'rect', x: 115, y: 34, w: 90, h: 16, rx: 8 }],
      buttons: [
        b('power', 'Power', 50, 78, 60, 42, 'rounded', 'power'), b('tv_power', 'TV', 210, 78, 60, 42),
        b('key_1', '1', 57, 150, 52, 40), b('key_2', '2', 134, 150, 52, 40), b('key_3', '3', 211, 150, 52, 40),
        b('key_4', '4', 57, 202, 52, 40), b('key_5', '5', 134, 202, 52, 40), b('key_6', '6', 211, 202, 52, 40),
        b('key_7', '7', 57, 254, 52, 40), b('key_8', '8', 134, 254, 52, 40), b('key_9', '9', 211, 254, 52, 40),
        b('guide', 'Guide', 54, 310, 64, 40), b('key_0', '0', 128, 310, 64, 40), b('info', 'Info', 202, 310, 64, 40),
        b('up', 'Up', 134, 382, 52, 40, 'rounded', 'up'), b('left', 'Left', 72, 432, 52, 40, 'rounded', 'left'), b('ok', 'OK', 134, 432, 52, 40, 'circle', 'ok'), b('right', 'Right', 196, 432, 52, 40, 'rounded', 'right'), b('down', 'Down', 134, 482, 52, 40, 'rounded', 'down'),
        b('menu', 'Menu', 54, 544, 70, 40, 'rounded', 'menu'), b('back', 'Back', 196, 544, 70, 40, 'rounded', 'back'),
        b('vol_up', 'Vol +', 54, 606, 70, 42, 'rounded', 'volume_up'), b('ch_up', 'Ch +', 196, 606, 70, 42, 'rounded', 'channel_up'),
        b('vol_down', 'Vol -', 54, 658, 70, 42, 'rounded', 'volume_down'), b('ch_down', 'Ch -', 196, 658, 70, 42, 'rounded', 'channel_down')
      ]
    },
    projector: {
      schema: 'ir-pattern-v1', id: 'projector', name: 'Proiettore', width: 320, height: 680,
      body: { x: 24, y: 10, w: 272, h: 660, rx: 46 },
      decorations: [{ type: 'rect', x: 110, y: 32, w: 100, h: 16, rx: 8 }],
      buttons: [
        b('power', 'Power', 50, 78, 64, 44, 'rounded', 'power'), b('source', 'Source', 206, 78, 64, 44, 'rounded', 'input'),
        b('hdmi1', 'HDMI 1', 50, 145, 74, 40), b('hdmi2', 'HDMI 2', 123, 145, 74, 40), b('video', 'Video', 196, 145, 74, 40),
        b('menu', 'Menu', 52, 218, 72, 40, 'rounded', 'menu'), b('freeze', 'Freeze', 196, 218, 72, 40),
        b('up', 'Up', 134, 285, 52, 42, 'rounded', 'up'), b('left', 'Left', 72, 335, 52, 42, 'rounded', 'left'), b('ok', 'Enter', 134, 335, 52, 42, 'circle', 'ok'), b('right', 'Right', 196, 335, 52, 42, 'rounded', 'right'), b('down', 'Down', 134, 385, 52, 42, 'rounded', 'down'),
        b('back', 'Back', 52, 448, 72, 40, 'rounded', 'back'), b('blank', 'Blank', 196, 448, 72, 40),
        b('vol_up', 'Vol +', 52, 520, 82, 44, 'rounded', 'volume_up'), b('vol_down', 'Vol -', 186, 520, 82, 44, 'rounded', 'volume_down'),
        b('aspect', 'Aspect', 52, 586, 82, 40), b('eco', 'Eco', 186, 586, 82, 40)
      ]
    },
    ac: {
      schema: 'ir-pattern-v1', id: 'ac', name: 'Climatizzatore', width: 320, height: 760,
      body: { x: 26, y: 10, w: 268, h: 740, rx: 50 },
      decorations: [{ type: 'rect', x: 68, y: 68, w: 184, h: 88, rx: 12 }, { type: 'text', x: 160, y: 118, text: '24 C', size: 26 }],
      buttons: [
        b('power', 'Power', 55, 188, 72, 44, 'rounded', 'power'), b('mode', 'Mode', 193, 188, 72, 44),
        b('temp_up', 'Temp +', 55, 254, 92, 46), b('temp_down', 'Temp -', 173, 254, 92, 46),
        b('fan', 'Fan', 55, 318, 92, 42), b('swing', 'Swing', 173, 318, 92, 42),
        b('cool', 'Cool', 55, 382, 92, 42), b('heat', 'Heat', 173, 382, 92, 42),
        b('dry', 'Dry', 55, 446, 92, 42), b('auto', 'Auto', 173, 446, 92, 42),
        b('timer_on', 'Timer On', 50, 522, 100, 42), b('timer_off', 'Timer Off', 170, 522, 100, 42),
        b('sleep', 'Sleep', 55, 586, 92, 42), b('turbo', 'Turbo', 173, 586, 92, 42),
        b('light', 'Light', 55, 650, 92, 42), b('eco', 'Eco', 173, 650, 92, 42)
      ]
    },
    fan: {
      schema: 'ir-pattern-v1', id: 'fan', name: 'Ventilatore', width: 280, height: 600,
      body: { x: 22, y: 10, w: 236, h: 580, rx: 58 },
      decorations: [{ type: 'circle', cx: 140, cy: 48, r: 8 }],
      buttons: [
        b('power', 'Power', 78, 82, 124, 46, 'rounded', 'power'),
        b('speed_up', 'Speed +', 52, 160, 82, 44), b('speed_down', 'Speed -', 146, 160, 82, 44),
        b('mode', 'Mode', 52, 224, 82, 44), b('swing', 'Swing', 146, 224, 82, 44),
        b('timer', 'Timer', 52, 288, 82, 44), b('sleep', 'Sleep', 146, 288, 82, 44),
        b('natural', 'Natural', 52, 352, 82, 44), b('eco', 'Eco', 146, 352, 82, 44),
        b('light', 'Light', 52, 430, 82, 44), b('ion', 'Ion', 146, 430, 82, 44)
      ]
    },
    camera: {
      schema: 'ir-pattern-v1', id: 'camera', name: 'Fotocamera', width: 260, height: 500,
      body: { x: 20, y: 10, w: 220, h: 480, rx: 56 },
      decorations: [{ type: 'circle', cx: 130, cy: 52, r: 7 }],
      buttons: [
        b('shutter', 'Shutter', 60, 90, 140, 56, 'rounded'),
        b('shutter_2s', '2 sec', 60, 168, 140, 48),
        b('video', 'Video', 60, 238, 140, 48),
        b('zoom_in', 'Zoom +', 48, 318, 76, 44), b('zoom_out', 'Zoom -', 136, 318, 76, 44),
        b('focus', 'Focus', 60, 390, 140, 44)
      ]
    },
    streaming: {
      schema: 'ir-pattern-v1', id: 'streaming', name: 'Streaming / Console media', width: 280, height: 620,
      body: { x: 24, y: 10, w: 232, h: 600, rx: 76 },
      decorations: [{ type: 'circle', cx: 140, cy: 48, r: 6 }],
      buttons: [
        b('power', 'Power', 56, 82, 58, 40, 'rounded', 'power'), b('input', 'Input', 166, 82, 58, 40, 'rounded', 'input'),
        b('up', 'Up', 114, 160, 52, 42, 'rounded', 'up'), b('left', 'Left', 58, 208, 52, 42, 'rounded', 'left'), b('ok', 'OK', 114, 208, 52, 42, 'circle', 'ok'), b('right', 'Right', 170, 208, 52, 42, 'rounded', 'right'), b('down', 'Down', 114, 256, 52, 42, 'rounded', 'down'),
        b('home', 'Home', 50, 324, 78, 40, 'rounded', 'home'), b('back', 'Back', 152, 324, 78, 40, 'rounded', 'back'),
        b('rewind', 'Rew', 40, 394, 58, 40), b('play_pause', 'Play', 111, 394, 58, 40, 'rounded', 'play'), b('forward', 'Fwd', 182, 394, 58, 40),
        b('vol_up', 'Vol +', 50, 464, 78, 42, 'rounded', 'volume_up'), b('vol_down', 'Vol -', 152, 464, 78, 42, 'rounded', 'volume_down'),
        b('app_1', 'App 1', 50, 528, 78, 38), b('app_2', 'App 2', 152, 528, 78, 38)
      ]
    },
    led_light: {
      schema: 'ir-pattern-v1', id: 'led_light', name: 'Luci LED / RGB', width: 300, height: 650,
      body: { x: 22, y: 10, w: 256, h: 630, rx: 48 },
      decorations: [{ type: 'rect', x: 104, y: 34, w: 92, h: 16, rx: 8 }],
      buttons: [
        b('power', 'Power', 50, 78, 70, 42, 'rounded', 'power'), b('off', 'Off', 180, 78, 70, 42),
        b('bright_up', 'Bright +', 50, 142, 86, 40), b('bright_down', 'Bright -', 164, 142, 86, 40),
        b('red', 'Red', 46, 212, 54, 42), b('green', 'Green', 123, 212, 54, 42), b('blue', 'Blue', 200, 212, 54, 42),
        b('orange', 'Orange', 46, 264, 54, 42), b('cyan', 'Cyan', 123, 264, 54, 42), b('purple', 'Purple', 200, 264, 54, 42),
        b('yellow', 'Yellow', 46, 316, 54, 42), b('white', 'White', 123, 316, 54, 42), b('pink', 'Pink', 200, 316, 54, 42),
        b('flash', 'Flash', 46, 390, 88, 42), b('strobe', 'Strobe', 166, 390, 88, 42),
        b('fade', 'Fade', 46, 448, 88, 42), b('smooth', 'Smooth', 166, 448, 88, 42),
        b('speed_up', 'Speed +', 46, 520, 88, 42), b('speed_down', 'Speed -', 166, 520, 88, 42)
      ]
    },
    heater: {
      schema: 'ir-pattern-v1', id: 'heater', name: 'Riscaldatore / Stufa', width: 280, height: 590,
      body: { x: 22, y: 10, w: 236, h: 570, rx: 54 },
      decorations: [{ type: 'rect', x: 82, y: 54, w: 116, h: 58, rx: 10 }, { type: 'text', x: 140, y: 88, text: '22 C', size: 22 }],
      buttons: [
        b('power', 'Power', 78, 144, 124, 46, 'rounded', 'power'),
        b('temp_up', 'Temp +', 50, 220, 82, 44), b('temp_down', 'Temp -', 148, 220, 82, 44),
        b('mode', 'Mode', 50, 284, 82, 44), b('eco', 'Eco', 148, 284, 82, 44),
        b('fan', 'Fan', 50, 348, 82, 44), b('oscillate', 'Swing', 148, 348, 82, 44),
        b('timer', 'Timer', 50, 412, 82, 44), b('sleep', 'Sleep', 148, 412, 82, 44),
        b('boost', 'Boost', 78, 486, 124, 44)
      ]
    },
    purifier: {
      schema: 'ir-pattern-v1', id: 'purifier', name: 'Purificatore aria', width: 280, height: 600,
      body: { x: 22, y: 10, w: 236, h: 580, rx: 58 },
      decorations: [{ type: 'circle', cx: 140, cy: 58, r: 22 }],
      buttons: [
        b('power', 'Power', 78, 112, 124, 46, 'rounded', 'power'),
        b('speed_up', 'Speed +', 50, 192, 82, 44), b('speed_down', 'Speed -', 148, 192, 82, 44),
        b('auto', 'Auto', 50, 256, 82, 44), b('sleep', 'Sleep', 148, 256, 82, 44),
        b('ion', 'Ion', 50, 320, 82, 44), b('uv', 'UV', 148, 320, 82, 44),
        b('timer', 'Timer', 50, 384, 82, 44), b('light', 'Light', 148, 384, 82, 44),
        b('filter', 'Filter', 78, 458, 124, 44)
      ]
    },
    tv_minimal: {
      schema: 'ir-pattern-v1', id: 'tv_minimal', name: 'TV minimale / hotel', width: 270, height: 590,
      body: { x: 22, y: 10, w: 226, h: 570, rx: 62 },
      decorations: [{ type: 'circle', cx: 135, cy: 48, r: 7 }],
      buttons: [
        b('power', 'Power', 42, 78, 64, 42, 'rounded', 'power'), b('input', 'Input', 164, 78, 64, 42, 'rounded', 'input'),
        b('up', 'Up', 109, 166, 52, 42, 'rounded', 'up'), b('left', 'Left', 51, 214, 52, 42, 'rounded', 'left'), b('ok', 'OK', 109, 214, 52, 42, 'circle', 'ok'), b('right', 'Right', 167, 214, 52, 42, 'rounded', 'right'), b('down', 'Down', 109, 262, 52, 42, 'rounded', 'down'),
        b('home', 'Home', 44, 326, 76, 40, 'rounded', 'home'), b('back', 'Back', 150, 326, 76, 40, 'rounded', 'back'),
        b('vol_up', 'Vol +', 44, 398, 76, 44, 'rounded', 'volume_up'), b('ch_up', 'Ch +', 150, 398, 76, 44, 'rounded', 'channel_up'),
        b('vol_down', 'Vol -', 44, 452, 76, 44, 'rounded', 'volume_down'), b('ch_down', 'Ch -', 150, 452, 76, 44, 'rounded', 'channel_down'),
        b('mute', 'Mute', 97, 514, 76, 40, 'rounded', 'mute')
      ]
    },
    ac_lcd: {
      schema: 'ir-pattern-v1', id: 'ac_lcd', name: 'Climatizzatore con display LCD', width: 300, height: 720,
      body: { x: 22, y: 10, w: 256, h: 700, rx: 48 },
      decorations: [{ type: 'rect', x: 58, y: 50, w: 184, h: 98, rx: 10 }, { type: 'text', x: 150, y: 94, text: '24 C', size: 28 }, { type: 'text', x: 150, y: 124, text: 'AUTO', size: 12 }],
      buttons: [
        b('power', 'Power', 52, 176, 82, 44, 'rounded', 'power'), b('mode', 'Mode', 166, 176, 82, 44, 'rounded', 'mode'),
        b('temp_up', 'Temp +', 50, 246, 88, 48, 'rounded', 'temperature_up'), b('temp_down', 'Temp -', 162, 246, 88, 48, 'rounded', 'temperature_down'),
        b('fan', 'Fan', 50, 314, 88, 44, 'rounded', 'fan'), b('swing', 'Swing', 162, 314, 88, 44, 'rounded', 'swing'),
        b('turbo', 'Turbo', 50, 376, 88, 42), b('eco', 'Eco', 162, 376, 88, 42),
        b('sleep', 'Sleep', 50, 436, 88, 42, 'rounded', 'sleep'), b('timer', 'Timer', 162, 436, 88, 42, 'rounded', 'timer'),
        b('light', 'Light', 50, 496, 88, 42, 'rounded', 'light'), b('clean', 'Clean', 162, 496, 88, 42),
        b('clock', 'Clock', 50, 556, 88, 42), b('follow_me', 'Follow me', 162, 556, 88, 42),
        b('on_timer', 'On timer', 50, 616, 88, 42), b('off_timer', 'Off timer', 162, 616, 88, 42)
      ]
    },
    mini_streamer: {
      schema: 'ir-pattern-v1', id: 'mini_streamer', name: 'Streaming compatto / stick', width: 250, height: 560,
      body: { x: 20, y: 10, w: 210, h: 540, rx: 78 },
      decorations: [{ type: 'circle', cx: 125, cy: 48, r: 6 }],
      buttons: [
        b('power', 'Power', 44, 76, 58, 40, 'rounded', 'power'), b('input', 'TV', 148, 76, 58, 40, 'rounded', 'input'),
        b('mic', 'Mic', 86, 134, 78, 38),
        b('up', 'Up', 99, 194, 52, 40, 'rounded', 'up'), b('left', 'Left', 45, 238, 52, 40, 'rounded', 'left'), b('ok', 'OK', 99, 238, 52, 40, 'circle', 'ok'), b('right', 'Right', 153, 238, 52, 40, 'rounded', 'right'), b('down', 'Down', 99, 282, 52, 40, 'rounded', 'down'),
        b('back', 'Back', 45, 338, 70, 38, 'rounded', 'back'), b('home', 'Home', 135, 338, 70, 38, 'rounded', 'home'),
        b('rewind', 'Rew', 39, 398, 52, 38), b('play_pause', 'Play', 99, 398, 52, 38, 'rounded', 'play'), b('forward', 'Fwd', 159, 398, 52, 38),
        b('vol_up', 'Vol +', 45, 458, 70, 40, 'rounded', 'volume_up'), b('vol_down', 'Vol -', 135, 458, 70, 40, 'rounded', 'volume_down'),
        b('mute', 'Mute', 89, 508, 72, 34, 'rounded', 'mute')
      ]
    },
    cd_player: {
      schema: 'ir-pattern-v1', id: 'cd_player', name: 'CD / Hi-Fi', width: 300, height: 680,
      body: { x: 22, y: 10, w: 256, h: 660, rx: 48 },
      decorations: [{ type: 'rect', x: 98, y: 34, w: 104, h: 16, rx: 8 }],
      buttons: [
        b('power', 'Power', 46, 80, 64, 42, 'rounded', 'power'), b('eject', 'Eject', 190, 80, 64, 42, 'rounded', 'eject'),
        b('key_1', '1', 48, 154, 52, 40), b('key_2', '2', 124, 154, 52, 40), b('key_3', '3', 200, 154, 52, 40),
        b('key_4', '4', 48, 206, 52, 40), b('key_5', '5', 124, 206, 52, 40), b('key_6', '6', 200, 206, 52, 40),
        b('key_7', '7', 48, 258, 52, 40), b('key_8', '8', 124, 258, 52, 40), b('key_9', '9', 200, 258, 52, 40),
        b('key_0', '0', 124, 310, 52, 40),
        b('prev', 'Prev', 42, 384, 62, 42, 'rounded', 'prev'), b('play', 'Play', 119, 384, 62, 42, 'rounded', 'play'), b('next', 'Next', 196, 384, 62, 42, 'rounded', 'next'),
        b('rewind', 'Rew', 42, 438, 62, 42), b('pause', 'Pause', 119, 438, 62, 42, 'rounded', 'pause'), b('forward', 'Fwd', 196, 438, 62, 42),
        b('stop', 'Stop', 119, 492, 62, 42, 'rounded', 'stop'),
        b('repeat', 'Repeat', 48, 564, 82, 40), b('shuffle', 'Random', 170, 564, 82, 40)
      ]
    },
    vacuum: {
      schema: 'ir-pattern-v1', id: 'vacuum', name: 'Robot aspirapolvere', width: 280, height: 610,
      body: { x: 22, y: 10, w: 236, h: 590, rx: 62 },
      decorations: [{ type: 'circle', cx: 140, cy: 52, r: 12 }],
      buttons: [
        b('power', 'Power', 78, 100, 124, 46, 'rounded', 'power'),
        b('clean', 'Clean', 78, 174, 124, 48, 'rounded'), b('home', 'Dock', 78, 234, 124, 44, 'rounded', 'home'),
        b('up', 'Up', 114, 314, 52, 40, 'rounded', 'up'), b('left', 'Left', 56, 362, 52, 40, 'rounded', 'left'), b('ok', 'OK', 114, 362, 52, 40, 'circle', 'ok'), b('right', 'Right', 172, 362, 52, 40, 'rounded', 'right'), b('down', 'Down', 114, 410, 52, 40, 'rounded', 'down'),
        b('spot', 'Spot', 48, 478, 82, 42), b('edge', 'Edge', 150, 478, 82, 42),
        b('fan', 'Suction', 48, 536, 82, 42, 'rounded', 'fan'), b('schedule', 'Schedule', 150, 536, 82, 42, 'rounded', 'timer')
      ]
    },
    led_24: {
      schema: 'ir-pattern-v1', id: 'led_24', name: 'LED RGB 24 tasti', width: 320, height: 600,
      body: { x: 22, y: 10, w: 276, h: 580, rx: 34 },
      decorations: [{ type: 'text', x: 160, y: 48, text: 'RGB', size: 16 }],
      buttons: [
        b('bright_up', 'Bright +', 42, 72, 108, 40), b('bright_down', 'Bright -', 170, 72, 108, 40),
        b('off', 'OFF', 42, 124, 108, 40), b('power', 'ON', 170, 124, 108, 40, 'rounded', 'power'),
        b('red', 'Red', 42, 190, 52, 42), b('green', 'Green', 100, 190, 52, 42), b('blue', 'Blue', 158, 190, 52, 42), b('white', 'White', 216, 190, 62, 42),
        b('orange', 'Orange', 42, 244, 52, 42), b('green_2', 'Green 2', 100, 244, 52, 42), b('blue_2', 'Blue 2', 158, 244, 52, 42), b('flash', 'Flash', 216, 244, 62, 42),
        b('orange_2', 'Orange 2', 42, 298, 52, 42), b('cyan', 'Cyan', 100, 298, 52, 42), b('purple', 'Purple', 158, 298, 52, 42), b('strobe', 'Strobe', 216, 298, 62, 42),
        b('yellow', 'Yellow', 42, 352, 52, 42), b('cyan_2', 'Cyan 2', 100, 352, 52, 42), b('pink', 'Pink', 158, 352, 52, 42), b('fade', 'Fade', 216, 352, 62, 42),
        b('yellow_2', 'Yellow 2', 42, 406, 52, 42), b('blue_3', 'Blue 3', 100, 406, 52, 42), b('pink_2', 'Pink 2', 158, 406, 52, 42), b('smooth', 'Smooth', 216, 406, 62, 42)
      ]
    },
    led_44: {
      schema: 'ir-pattern-v1', id: 'led_44', name: 'LED RGB 44 tasti', width: 360, height: 810,
      body: { x: 20, y: 10, w: 320, h: 790, rx: 34 },
      decorations: [{ type: 'text', x: 180, y: 45, text: 'RGB', size: 16 }],
      buttons: [
        b('bright_up', 'Bright +', 42, 66, 88, 36), b('bright_down', 'Bright -', 136, 66, 88, 36), b('pause', 'Pause', 230, 66, 88, 36, 'rounded', 'pause'),
        b('off', 'OFF', 42, 112, 132, 38), b('power', 'ON', 186, 112, 132, 38, 'rounded', 'power'),
        b('red', 'Red', 42, 170, 62, 36), b('green', 'Green', 112, 170, 62, 36), b('blue', 'Blue', 182, 170, 62, 36), b('white', 'White', 252, 170, 66, 36),
        b('orange', 'Orange', 42, 216, 62, 36), b('green_2', 'G2', 112, 216, 62, 36), b('blue_2', 'B2', 182, 216, 62, 36), b('diy_1', 'DIY1', 252, 216, 66, 36),
        b('orange_2', 'Orange2', 42, 262, 62, 36), b('cyan', 'Cyan', 112, 262, 62, 36), b('purple', 'Purple', 182, 262, 62, 36), b('diy_2', 'DIY2', 252, 262, 66, 36),
        b('yellow', 'Yellow', 42, 308, 62, 36), b('cyan_2', 'Cyan2', 112, 308, 62, 36), b('pink', 'Pink', 182, 308, 62, 36), b('diy_3', 'DIY3', 252, 308, 66, 36),
        b('yellow_2', 'Yellow2', 42, 354, 62, 36), b('blue_3', 'B3', 112, 354, 62, 36), b('pink_2', 'Pink2', 182, 354, 62, 36), b('diy_4', 'DIY4', 252, 354, 66, 36),
        b('red_up', 'R +', 42, 424, 62, 36), b('green_up', 'G +', 112, 424, 62, 36), b('blue_up', 'B +', 182, 424, 62, 36), b('quick', 'Quick', 252, 424, 66, 36),
        b('red_down', 'R -', 42, 470, 62, 36), b('green_down', 'G -', 112, 470, 62, 36), b('blue_down', 'B -', 182, 470, 62, 36), b('slow', 'Slow', 252, 470, 66, 36),
        b('diy_5', 'DIY5', 42, 540, 62, 36), b('diy_6', 'DIY6', 112, 540, 62, 36), b('auto', 'Auto', 182, 540, 62, 36), b('flash', 'Flash', 252, 540, 66, 36),
        b('jump_3', 'Jump3', 42, 586, 62, 36), b('jump_7', 'Jump7', 112, 586, 62, 36), b('fade_3', 'Fade3', 182, 586, 62, 36), b('fade_7', 'Fade7', 252, 586, 66, 36)
      ]
    },
    toy: {
      schema: 'ir-pattern-v1', id: 'toy', name: 'Giocattolo / veicolo IR', width: 300, height: 570,
      body: { x: 22, y: 10, w: 256, h: 550, rx: 56 },
      decorations: [{ type: 'circle', cx: 150, cy: 54, r: 8 }],
      buttons: [
        b('power', 'Power', 108, 86, 84, 42, 'rounded', 'power'),
        b('up', 'Forward', 108, 172, 84, 48, 'rounded', 'up'), b('left', 'Left', 52, 230, 84, 48, 'rounded', 'left'), b('right', 'Right', 164, 230, 84, 48, 'rounded', 'right'), b('down', 'Back', 108, 288, 84, 48, 'rounded', 'down'),
        b('speed_up', 'Speed +', 52, 374, 84, 42), b('speed_down', 'Speed -', 164, 374, 84, 42),
        b('action_1', 'Action 1', 52, 434, 84, 42), b('action_2', 'Action 2', 164, 434, 84, 42),
        b('light', 'Light', 108, 494, 84, 40, 'rounded', 'light')
      ]
    }
  };

  function b(id, label, x, y, w, h, shape = 'rounded', semantic = '') {
    return { id, label, x, y, w, h, shape, semantic };
  }

  function clone(obj) { return JSON.parse(JSON.stringify(obj)); }
  function esc(value) { return String(value ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c])); }
  function uid(prefix) { return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`; }


  function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }

  function showToast(message, type = 'info', timeout = 2600) {
    if (!toastRoot) return;
    const toast = document.createElement('div');
    toast.className = `toast ${type === 'ok' ? 'ok' : type === 'warn' ? 'warn' : ''}`;
    toast.textContent = message;
    toastRoot.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('visible'));
    setTimeout(() => {
      toast.classList.remove('visible');
      setTimeout(() => toast.remove(), 220);
    }, timeout);
  }

  function deviceIcon(type) {
    const icons = {
      tv: 'TV', dvd: 'DVD', audio: '♫', stb: '▣', projector: '▰', ac: '❄', fan: '◌',
      camera: '●', console: '◈', vacuum: '⌂', light: '☀', heater: '♨', purifier: '≈', toy: '◆'
    };
    return icons[type] || 'IR';
  }

  function initPwa() {
    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
      navigator.serviceWorker.register('./service-worker.js').catch(error => console.warn('Service worker non disponibile:', error));
    }

    window.addEventListener('beforeinstallprompt', event => {
      event.preventDefault();
      state.installPrompt = event;
      installButton?.classList.remove('hidden');
    });

    installButton?.addEventListener('click', async () => {
      const prompt = state.installPrompt;
      if (!prompt) return;
      prompt.prompt();
      try { await prompt.userChoice; } catch {}
      state.installPrompt = null;
      installButton.classList.add('hidden');
    });

    window.addEventListener('appinstalled', () => {
      state.installPrompt = null;
      installButton?.classList.add('hidden');
      showToast('IR Remote Lab installata.', 'ok');
    });

    const hasNativeSerial = 'serial' in navigator;
    const hasWebUsbFallback = 'usb' in navigator && !!window.IR_WEBUSB_SERIAL;
    if (!hasNativeSerial && !hasWebUsbFallback) {
      connectButton.disabled = true;
      serialStatus.textContent = 'USB seriale non disponibile';
      serialStatus.title = 'Serve Chrome/Edge con Web Serial oppure WebUSB. Su Android usa Chrome e un cavo/adattatore USB OTG dati.';
    } else if (/Android/i.test(navigator.userAgent) && hasWebUsbFallback) {
      serialStatus.title = 'Su Android usa WebUSB: CDC per Uno, CH340/FT232R/CP210x per Nano classico.';
    }
  }

  function loadRemotes() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); }
    catch { return []; }
  }
  function saveRemotes() { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.remotes)); }

  function signalFromDb(entry, bytes) {
    const raw = buildPulseDistanceRaw(entry.timings, bytes);
    return {
      protocol: 'RAW',
      carrierHz: entry.carrierHz || 38000,
      raw,
      decoded: analyzeRawSignal(raw),
      sourceEncoding: 'PD32',
      bytes: bytes.slice()
    };
  }

  function buildPulseDistanceRaw(t, bytes) {
    const out = [Math.round(t.headerMark), Math.round(t.headerSpace)];
    bytes.forEach(byte => {
      let value = byte & 0xFF;
      for (let bit = 0; bit < 8; bit++) {
        out.push(Math.round(t.bitMark));
        out.push(Math.round((value & 1) ? t.oneSpace : t.zeroSpace));
        value >>= 1;
      }
    });
    out.push(Math.round(t.bitMark));
    return out;
  }

  function isTransmitReady(signal) {
    if (!signal) return false;
    const normalized = normalizeSignal(signal);
    return normalized?.protocol === 'RAW' && Array.isArray(normalized.raw) && normalized.raw.length > 0;
  }

  function countLearnedButtons(remote) {
    return Object.values(remote?.mapping || {}).filter(isTransmitReady).length;
  }

  function totalRemoteButtons(remote) {
    return remote?.pattern?.buttons?.length || 0;
  }

  function ensurePatternButton(pattern, buttonId, label, semantic = '') {
    if (pattern.buttons.some(x => x.id === buttonId)) return;
    const columns = 3;
    const w = 76, h = 36, gapX = 12, gapY = 10;
    const startX = Math.max(24, Math.round((pattern.width - (columns * w + (columns - 1) * gapX)) / 2));
    const maxY = pattern.buttons.reduce((m, x) => Math.max(m, x.y + x.h), 0);
    const index = pattern.buttons.filter(x => x.y >= maxY - 1).length;
    let y = maxY + 24;
    const existingAdded = pattern.buttons.filter(x => x._autoAdded).length;
    const col = existingAdded % columns;
    const row = Math.floor(existingAdded / columns);
    y += row * (h + gapY);
    const button = b(buttonId, label, startX + col * (w + gapX), y, w, h, 'rounded', semantic);
    button._autoAdded = true;
    pattern.buttons.push(button);
    const required = y + h + 32;
    if (required > pattern.height) {
      const delta = required - pattern.height;
      pattern.height = required;
      pattern.body.h += delta;
    }
  }

  function buildRemoteFromDb(entry) {
    const pattern = clone(PATTERNS[entry.patternId] || PATTERNS.compact);
    const mapping = {};
    Object.entries(entry.signals || {}).forEach(([buttonId, bytes]) => {
      mapping[buttonId] = signalFromDb(entry, bytes);
      if (!pattern.buttons.some(x => x.id === buttonId)) {
        ensurePatternButton(pattern, buttonId, buttonId.replace(/^key_/, '').toUpperCase());
      }
    });
    return {
      schema: 'ir-remote-v1', id: uid('remote'), name: `${entry.brand} ${entry.model}`,
      deviceType: entry.deviceType, brand: entry.brand, model: entry.model,
      source: 'database', pattern, mapping, createdAt: new Date().toISOString()
    };
  }

  function downloadJson(filename, payload) {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportFullBackup() {
    const stamp = new Date().toISOString().slice(0, 10);
    downloadJson(`ir-remote-lab-backup-${stamp}.json`, {
      schema: 'ir-remote-lab-backup-v1',
      appVersion: APP_VERSION,
      exportedAt: new Date().toISOString(),
      remotes: clone(state.remotes)
    });
    showToast(`Backup di ${state.remotes.length} telecomandi creato.`, 'ok');
  }

  async function importFullBackup(file) {
    if (!file) return;
    let payload;
    try { payload = JSON.parse(await file.text()); }
    catch { throw new Error('Il file non contiene JSON valido.'); }
    if (payload?.schema !== 'ir-remote-lab-backup-v1' || !Array.isArray(payload.remotes)) throw new Error('Questo file non è un backup completo IR Remote Lab.');
    const existing = new Set(state.remotes.map(r => r.id));
    let added = 0;
    payload.remotes.forEach(source => {
      if (!source?.pattern?.buttons || !source?.mapping || !source?.name) return;
      const remote = clone(source);
      if (!remote.id || existing.has(remote.id)) remote.id = uid('remote');
      existing.add(remote.id);
      state.remotes.push(remote); added++;
    });
    saveRemotes();
    showToast(`${added} telecomandi importati dal backup.`, added ? 'ok' : 'warn');
    renderMain();
  }

  function renderMain() {
    enterView('home');
    state.currentRemoteId = null;
    app.innerHTML = `
      <section class="home-hero">
        <div>
          <h1 class="page-title">I tuoi telecomandi</h1>
          <p class="page-subtitle">Apri un telecomando per usarlo, oppure aggiungine uno nuovo. I dati restano salvati su questo dispositivo.</p>
        </div>
        <div class="home-summary"><strong>${state.remotes.length}</strong><span>telecomandi</span></div>
      </section>
      ${isAndroidDevice() ? '<div class="notice usb-mobile-hint"><strong>Android USB:</strong> collega Arduino con un cavo/adattatore OTG che supporti i dati, poi premi <strong>Collega Arduino USB</strong>. La v13 usa WebUSB per Uno e Nano e non dipende dalla lista porte Web Serial del telefono.</div>' : ''}
      <div class="home-tools">
        <label class="search-box" aria-label="Cerca telecomando">
          <span>⌕</span><input id="homeSearch" type="search" placeholder="Cerca per nome, marca o modello..." autocomplete="off">
        </label>
        <button class="btn small" id="backupExport">Backup</button>
        <button class="btn small" id="backupImport">Ripristina</button>
        <input id="backupFile" type="file" accept="application/json,.json" class="hidden">
      </div>
      <div class="grid" id="remoteGrid"></div>`;

    const grid = document.getElementById('remoteGrid');
    const search = document.getElementById('homeSearch');
    document.getElementById('backupExport').onclick = exportFullBackup;
    document.getElementById('backupImport').onclick = () => document.getElementById('backupFile').click();
    document.getElementById('backupFile').onchange = async event => {
      try { await importFullBackup(event.target.files?.[0]); }
      catch (error) { showToast(error.message, 'warn', 4200); }
      event.target.value = '';
    };

    const draw = () => {
      const query = String(search.value || '').trim().toLowerCase();
      grid.innerHTML = '';
      const matches = state.remotes.filter(remote => !query || [remote.name, remote.brand, remote.model, remote.deviceType].some(v => String(v || '').toLowerCase().includes(query)));

      matches.forEach(remote => {
        const ready = countLearnedButtons(remote);
        const total = totalRemoteButtons(remote);
        const card = document.createElement('div');
        card.className = 'card clickable remote-card';
        card.innerHTML = `
          <div class="remote-card-head">
            <div class="remote-card-icon">${esc(deviceIcon(remote.deviceType))}</div>
            <div><h3>${esc(remote.name)}</h3><p>${esc([remote.brand, remote.model].filter(Boolean).join(' '))}</p></div>
          </div>
          <div>
            <div class="readiness"><span style="width:${total ? Math.round(ready / total * 100) : 0}%"></span></div>
            <div class="remote-meta">${esc(remote.deviceType || 'altro')} · ${ready}/${total} tasti pronti</div>
          </div>`;
        card.onclick = () => renderRemote(remote.id);
        grid.appendChild(card);
      });

      if (query && !matches.length) {
        const empty = document.createElement('div');
        empty.className = 'card empty-search';
        empty.innerHTML = `<strong>Nessun telecomando trovato</strong><p>Prova con un altro nome, marca o modello.</p>`;
        grid.appendChild(empty);
      }

      const add = document.createElement('div');
      add.className = 'card clickable add-card';
      add.innerHTML = '<div><div class="add-plus">+</div><h3>Aggiungi telecomando</h3><p>Clona, riconosci, cerca, importa o usa la modalità avanzata.</p></div>';
      add.onclick = renderAddRemote;
      grid.appendChild(add);
    };

    search.addEventListener('input', draw);
    draw();
  }

  function renderAddRemote() {
    enterView('add');
    const options = [
      ['Clona telecomando', 'Scegli un pattern e apprendi i tasti uno per uno.', renderCloneStart],
      ['Riconosci telecomando', 'Premi tre tasti diversi e confrontali con database locale + database online.', renderRecognize],
      ['Ricerca modello', 'Filtra per tipo prodotto, marca e modello nel catalogo esteso.', renderModelSearch],
      ['Ricerca automatica', 'Prova in sequenza i codici Power disponibili finche il dispositivo reagisce.', renderAutoSearch],
      ['Importa JSON', 'Importa un telecomando completo esportato in precedenza.', renderImport],
      ['Modalita avanzata', 'Invia direttamente bytes esadecimali e timing personalizzati.', renderAdvanced]
    ];
    app.innerHTML = `
      <div class="toolbar"><button class="btn" id="backHome">&larr; Home</button></div>
      <h1 class="page-title">Aggiungi telecomando</h1>
      <p class="page-subtitle">Scegli il metodo piu adatto.</p>
      <div class="card db-card">
        <div class="toolbar"><div><strong>Database telecomandi</strong><div id="dbStatus" class="candidate-meta">Controllo catalogo...</div></div><div class="spacer"></div><button class="btn small" id="dbSync">Aggiorna indice</button><button class="btn small" id="dbDownload">Scarica DB offline</button></div>
        <div class="candidate-meta"><strong>irdb e attivo automaticamente.</strong> Al primo accesso al database l'indice viene sincronizzato e il contenuto irdb viene scaricato in background nella cache del browser per l'uso offline.</div>
        <div class="candidate-meta irdb-notice">Contains/accesses irdb by Simon Peter and contributors, used under permission. For licensing details and for information on how to contribute to the database, see https://github.com/probonopd/irdb</div>
        <div id="dbProgress" class="progress-line hidden"><div id="dbProgressBar"></div></div>
      </div>
      <div class="grid" id="addOptions" style="margin-top:16px"></div>`;
    document.getElementById('backHome').onclick = renderMain;
    const grid = document.getElementById('addOptions');
    options.forEach(([title, text, fn]) => {
      const card = document.createElement('div');
      card.className = 'card clickable';
      card.innerHTML = `<h3>${title}</h3><p>${text}</p>`;
      card.onclick = fn;
      grid.appendChild(card);
    });
    setupDatabasePanel();
  }

  function setupDatabasePanel() {
    if (!window.IR_EXTERNAL_DB) return;
    refreshDatabaseStatus();

    const syncButton = document.getElementById('dbSync');
    const downloadButton = document.getElementById('dbDownload');
    const status = document.getElementById('dbStatus');
    const line = document.getElementById('dbProgress');
    const bar = document.getElementById('dbProgressBar');

    syncButton.onclick = async () => {
      try {
        status.textContent = 'Aggiornamento indici Flipper + irdb in corso...';
        const result = await window.IR_EXTERNAL_DB.sync({ force: true, includeIrdB: true });
        const notes = [];
        if (result.errors?.flipper) notes.push('Flipper non indicizzabile via CDN; irdb resta operativo');
        if (result.errors?.irdb) notes.push(result.errors.irdb);
        status.textContent = `Flipper IRDB: ${result.flipper} profili · irdb: ${result.irdb} profili${notes.length ? ' · ' + notes.join(' · ') : ''}.`;
      } catch (error) { status.textContent = `Errore database: ${error.message}`; }
    };

    downloadButton.onclick = async () => {
      line.classList.remove('hidden');
      bar.style.width = '0%';
      try {
        const flipper = await window.IR_EXTERNAL_DB.downloadAllFlipper(progress => {
          const pct = progress.total ? Math.round(progress.done * 100 / progress.total) : 0;
          bar.style.width = `${pct}%`;
          status.textContent = `Flipper offline ${progress.done}/${progress.total} (${pct}%) · errori ${progress.failed}`;
        });
        bar.style.width = '0%';
        const irdb = await window.IR_EXTERNAL_DB.downloadAllIrdB(progress => {
          const pct = progress.total ? Math.round(progress.done * 100 / progress.total) : 0;
          bar.style.width = `${pct}%`;
          status.textContent = `irdb offline ${progress.done}/${progress.total} (${pct}%) · errori ${progress.failed}`;
        });
        const flipperText = flipper.skipped ? 'Flipper: indice CDN non disponibile (saltato)' : `Flipper ${flipper.done}/${flipper.total}`;
        status.textContent = `Cache offline completata: ${flipperText} · irdb ${irdb.done}/${irdb.total} · errori ${flipper.failed + irdb.failed}.`;
      } catch (error) { status.textContent = `Download database fallito: ${error.message}`; }
      setTimeout(() => line.classList.add('hidden'), 2200);
    };

    // v11: irdb is a built-in source. Synchronize it independently from Flipper and, once per
    // browser profile, cache the complete irdb dataset automatically in background.
    (async () => {
      try {
        status.textContent = 'Sincronizzazione database Flipper + irdb...';
        const result = await window.IR_EXTERNAL_DB.sync({ includeIrdB: true });
        refreshDatabaseStatus();
        const dbState = window.IR_EXTERNAL_DB.getStatus();
        if (!dbState.irdbCount) {
          status.textContent = dbState.irdbError || 'irdb non disponibile.';
          return;
        }
        if (!dbState.irdbOfflineComplete) {
          line.classList.remove('hidden');
          const offline = await window.IR_EXTERNAL_DB.ensureIrdBOffline(progress => {
            const pct = progress.total ? Math.round(progress.done * 100 / progress.total) : 0;
            bar.style.width = `${pct}%`;
            status.textContent = `Download automatico irdb ${progress.done}/${progress.total} (${pct}%) · errori ${progress.failed}`;
          });
          if (offline.failed === 0) status.textContent = `irdb incorporato nella cache offline: ${offline.done}/${offline.total} profili.${result.errors?.flipper ? ' Flipper non indicizzabile via CDN in questa sessione.' : ` Flipper: ${result.flipper} profili indicizzati.`}`;
          else status.textContent = `irdb scaricato con ${offline.failed} errori: ${offline.done}/${offline.total}. Premi Scarica DB offline per riprovare.`;
          setTimeout(() => line.classList.add('hidden'), 2200);
        }
      } catch (error) {
        status.textContent = `Database online non disponibile: ${error.message}`;
      }
    })();
  }

  function refreshDatabaseStatus() {
    if (!window.IR_EXTERNAL_DB) return;
    const el = document.getElementById('dbStatus'); if (!el) return;
    const s = window.IR_EXTERNAL_DB.getStatus();
    const flipperText = s.flipperCount ? `${s.flipperCount}` : (s.flipperError ? 'non disponibile' : 'non sincronizzato');
    const irdbText = s.irdbCount ? `${s.irdbCount}${s.irdbOfflineComplete ? ' (offline)' : ''}` : (s.irdbError ? 'non disponibile' : 'non sincronizzato');
    const parts = [`Locale: ${window.REMOTE_DB?.length || 0}`, `Flipper IRDB: ${flipperText}`, `irdb: ${irdbText}`];
    if (s.flipperError && !s.flipperCount && s.irdbCount) parts.push('Flipper saltato senza bloccare irdb');
    el.textContent = parts.join(' · ');
  }

  function renderRemote(remoteId) {
    enterView('remote');
    const remote = state.remotes.find(r => r.id === remoteId);
    if (!remote) return renderMain();
    state.currentRemoteId = remoteId;

    app.innerHTML = `
      <div class="toolbar remote-toolbar">
        <button class="btn" id="homeButton">&larr; Home</button>
        <select id="remoteSwitch" class="btn"></select>
        <div class="spacer"></div>
        <button class="btn" id="editButton">Modifica tasti</button>
        <button class="btn" id="exportButton">Esporta JSON</button>
      </div>
      <div class="remote-layout">
        <div class="card remote-stage" id="remoteStage"></div>
        <div class="card info-panel">
          <h2>${esc(remote.name)}</h2>
          <p>${esc(remote.brand || '')} ${esc(remote.model || '')}</p>
          <div class="notice ${countLearnedButtons(remote) ? 'ok' : 'warn'}"><strong>${countLearnedButtons(remote)}/${totalRemoteButtons(remote)} tasti pronti</strong>${Object.keys(remote.databaseSignals || {}).length ? ` · ${Object.keys(remote.databaseSignals || {}).length} codici DB da riapprendere/convertire` : ''}.</div>
          <div class="notice remote-hint">Tocca un pulsante per trasmettere. Per cambiare posizione o riapprendere i tasti apri <strong>Modifica tasti</strong>.</div>
          <div id="buttonInfo" class="notice hidden"></div>
          <h3>Comunicazione</h3>
          <div id="remoteLog" class="log">Pronto.</div>
        </div>
      </div>`;

    document.getElementById('homeButton').onclick = renderMain;
    document.getElementById('editButton').onclick = () => renderButtonEditor(remote.id);
    document.getElementById('exportButton').onclick = () => exportRemote(remote);

    const sw = document.getElementById('remoteSwitch');
    state.remotes.forEach(r => {
      const opt = document.createElement('option'); opt.value = r.id; opt.textContent = r.name; opt.selected = r.id === remote.id; sw.appendChild(opt);
    });
    sw.onchange = () => renderRemote(sw.value);

    document.getElementById('remoteStage').appendChild(createRemoteSvg(remote.pattern, remote.mapping, async button => {
      const signal = remote.mapping?.[button.id];
      const dbSignal = remote.databaseSignals?.[button.id];
      const info = document.getElementById('buttonInfo');
      info.classList.remove('hidden');
      if (!isTransmitReady(signal)) {
        info.className = 'notice warn';
        info.textContent = dbSignal
          ? `${button.label}: codice presente nel database ma non ancora convertibile. Usa "Modifica tasti" > "Riapprendi".`
          : `${button.label}: nessun codice appreso. Usa "Modifica tasti" > "Riapprendi".`;
        return;
      }
      info.className = 'notice'; info.innerHTML = `${esc(button.label)} &mdash; <span class="code">${esc(signalLabel(signal))}</span>`;
      try {
        await sendSignal(signal);
        appendLog('remoteLog', `TX ${button.label}: ${signalLabel(signal)}`);
      } catch (error) {
        appendLog('remoteLog', `ERRORE: ${error.message}`);
        info.className = 'notice warn';
        info.textContent = `Errore trasmissione ${button.label}: ${error.message}`;
      }
    }));
  }

  function openLearnModal(remote, button) {
    cancelActiveAcquisition({ sendCancel: true });
    modalRoot.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal">
          <h2>Riapprendi ${esc(button.label)}</h2>
          <p>Premi il tasto <strong>${esc(button.label)}</strong> sul telecomando fisico. Se il protocollo non ha un controllo di integrita affidabile, il programma chiedera una seconda pressione.</p>
          <div id="relearnStatus" class="notice">Preparazione acquisizione...</div>
          <div class="toolbar" style="margin-top:16px">
            <button class="btn" id="cancelRelearn">Annulla</button>
            <div class="spacer"></div>
            <button class="btn hidden" id="retryRelearn">Riprova</button>
          </div>
        </div>
      </div>`;
    const status = document.getElementById('relearnStatus');
    const cancelButton = document.getElementById('cancelRelearn');
    const retryButton = document.getElementById('retryRelearn');
    let closed = false;

    const close = () => {
      closed = true;
      cancelActiveAcquisition({ sendCancel: true });
      modalRoot.innerHTML = '';
    };
    cancelButton.onclick = close;

    const run = async () => {
      retryButton.classList.add('hidden');
      try {
        const learned = await learnSignal(`Premi il tasto fisico: ${button.label}`, status);
        if (closed) return;
        remote.mapping ||= {};
        remote.mapping[button.id] = learned;
        if (remote.databaseSignals) delete remote.databaseSignals[button.id];
        saveRemotes();
        showToast(`${button.label} appreso correttamente.`, 'ok');
        status.className = 'notice ok';
        status.textContent = `Tasto ${button.label} appreso correttamente: ${signalLabel(learned)}`;
        await sleep(350);
        if (closed) return;
        modalRoot.innerHTML = '';
        renderButtonEditor(remote.id);
      } catch (error) {
        if (closed || isAcquisitionCancelled(error)) return;
        status.className = 'notice warn';
        status.textContent = error.message;
        retryButton.classList.remove('hidden');
        retryButton.onclick = run;
      }
    };
    run();
  }

  function enableButtonPositionEditing(svg, remote, options = {}) {
    const pattern = remote.pattern;
    const aborter = new AbortController();
    const signal = aborter.signal;
    let selectedId = null;
    let drag = null;

    const svgPoint = event => {
      const matrix = svg.getScreenCTM();
      if (!matrix) return { x: 0, y: 0 };
      const point = svg.createSVGPoint();
      point.x = event.clientX; point.y = event.clientY;
      return point.matrixTransform(matrix.inverse());
    };

    const buttonById = id => pattern.buttons.find(button => button.id === id);
    const groupById = id => svg.querySelector(`g[data-button-id="${CSS.escape(id)}"]`);

    const bounded = (button, x, y, forceStep = null) => {
      const margin = 7;
      const minX = Number(pattern.body.x || 0) + margin;
      const minY = Number(pattern.body.y || 0) + margin;
      const maxX = Math.max(minX, Number(pattern.body.x || 0) + Number(pattern.body.w || pattern.width) - button.w - margin);
      const maxY = Math.max(minY, Number(pattern.body.y || 0) + Number(pattern.body.h || pattern.height) - button.h - margin);
      const step = forceStep || (options.getSnap?.() ? 5 : 1);
      return {
        x: clamp(Math.round(x / step) * step, minX, maxX),
        y: clamp(Math.round(y / step) * step, minY, maxY)
      };
    };

    const drawPosition = (group, button, x, y) => {
      const rect = group?.querySelector('rect');
      const label = group?.querySelector('text');
      if (!rect || !label) return;
      rect.setAttribute('x', x); rect.setAttribute('y', y);
      label.setAttribute('x', x + button.w / 2); label.setAttribute('y', y + button.h / 2);
    };

    const selectById = id => {
      selectedId = id;
      svg.querySelectorAll('g[data-button-id]').forEach(group => group.classList.toggle('position-selected', group.dataset.buttonId === id));
      document.querySelectorAll('.button-editor-row[data-button-id]').forEach(row => row.classList.toggle('selected', row.dataset.buttonId === id));
      const button = buttonById(id);
      if (button) options.onSelection?.(button);
    };

    const applyPosition = (id, x, y, config = {}) => {
      const button = buttonById(id); const group = groupById(id);
      if (!button || !group) return false;
      const old = { x: button.x, y: button.y };
      const next = bounded(button, x, y, config.snap === false ? 1 : null);
      button.x = next.x; button.y = next.y;
      drawPosition(group, button, next.x, next.y);
      if (config.save !== false) saveRemotes();
      if (config.select !== false) selectById(id);
      if (config.notify !== false && (old.x !== next.x || old.y !== next.y)) options.onMoved?.(button, old, next);
      return true;
    };

    svg.classList.add('position-editing');
    svg.querySelectorAll('g[data-button-id]').forEach(group => {
      const id = group.dataset.buttonId;
      group.classList.add('position-draggable');
      group.setAttribute('tabindex', '0');
      group.setAttribute('role', 'button');
      group.setAttribute('aria-label', `Sposta ${buttonById(id)?.label || id}`);

      group.addEventListener('pointerdown', event => {
        if (event.button != null && event.button !== 0) return;
        const button = buttonById(id); if (!button) return;
        event.preventDefault();
        selectById(id);
        group.focus({ preventScroll: true });
        const p = svgPoint(event);
        drag = { id, pointerId: event.pointerId, startPointer: p, startX: button.x, startY: button.y, previewX: button.x, previewY: button.y };
        try { group.setPointerCapture(event.pointerId); } catch {}
        group.classList.add('dragging');
      }, { signal });

      group.addEventListener('pointermove', event => {
        if (!drag || drag.id !== id || drag.pointerId !== event.pointerId) return;
        event.preventDefault();
        const button = buttonById(id); const p = svgPoint(event);
        const next = bounded(button, drag.startX + p.x - drag.startPointer.x, drag.startY + p.y - drag.startPointer.y);
        drag.previewX = next.x; drag.previewY = next.y;
        drawPosition(group, button, next.x, next.y);
        options.onPreview?.(button, next);
      }, { signal });

      const finish = event => {
        if (!drag || drag.id !== id || drag.pointerId !== event.pointerId) return;
        const current = drag; drag = null;
        group.classList.remove('dragging');
        try { group.releasePointerCapture(event.pointerId); } catch {}
        applyPosition(id, current.previewX, current.previewY);
      };
      group.addEventListener('pointerup', finish, { signal });
      group.addEventListener('pointercancel', event => {
        if (!drag || drag.id !== id || drag.pointerId !== event.pointerId) return;
        const button = buttonById(id); drawPosition(group, button, button.x, button.y); drag = null; group.classList.remove('dragging');
      }, { signal });

      group.addEventListener('keydown', event => {
        if (!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)) return;
        event.preventDefault();
        const button = buttonById(id); if (!button) return;
        const amount = event.shiftKey ? 5 : 1;
        let x = button.x, y = button.y;
        if (event.key === 'ArrowLeft') x -= amount;
        if (event.key === 'ArrowRight') x += amount;
        if (event.key === 'ArrowUp') y -= amount;
        if (event.key === 'ArrowDown') y += amount;
        applyPosition(id, x, y, { snap: false });
      }, { signal });

      group.addEventListener('click', event => { event.preventDefault(); selectById(id); }, { signal });
    });

    return {
      destroy() {
        aborter.abort();
        svg.classList.remove('position-editing');
        svg.querySelectorAll('g[data-button-id]').forEach(group => group.classList.remove('position-draggable', 'position-selected', 'dragging'));
      },
      selectById,
      setPosition(id, x, y, config = {}) { return applyPosition(id, x, y, config); },
      get selectedId() { return selectedId; }
    };
  }

  function renderButtonEditor(remoteId) {
    enterView('editor');
    const remote = state.remotes.find(r => r.id === remoteId);
    if (!remote) return renderMain();
    let positionEditor = null;
    const moveHistory = [];

    app.innerHTML = `
      <div class="toolbar editor-topbar"><button class="btn" id="backRemote">&larr; Telecomando</button><div class="spacer"></div><button class="btn danger" id="deleteRemote">Elimina telecomando</button></div>
      <h1 class="page-title">Modifica telecomando</h1>
      <p class="page-subtitle">Riapprendi e rinomina i tasti oppure attiva <strong>Sposta tasti</strong> per sistemare il layout direttamente con mouse o touch.</p>
      <div class="remote-layout editor-layout">
        <div class="card position-card">
          <div class="position-toolbar">
            <button class="btn primary" id="moveMode">Sposta tasti</button>
            <label class="toggle-chip"><input type="checkbox" id="snapGrid" checked> Griglia 5 px</label>
            <button class="btn small" id="undoMove" disabled>Annulla spostamento</button>
          </div>
          <div id="moveStatus" class="position-help">Attiva lo spostamento, poi trascina un tasto. Su PC puoi usare anche le frecce; Shift + freccia = 5 px.</div>
          <div class="remote-stage editor-stage" id="editorStage"></div>
        </div>
        <div class="card editor-list-card">
          <div class="section-heading"><div><h3>Tasti</h3><p>${remote.pattern.buttons.length} pulsanti nel layout</p></div><button class="btn primary" id="addButton">+ Aggiungi tasto</button></div>
          <div id="editorRows"></div>
        </div>
      </div>`;

    document.getElementById('backRemote').onclick = () => renderRemote(remote.id);
    document.getElementById('deleteRemote').onclick = () => {
      if (!confirm(`Eliminare ${remote.name}?`)) return;
      state.remotes = state.remotes.filter(r => r.id !== remote.id); saveRemotes(); showToast('Telecomando eliminato.', 'ok'); renderMain();
    };

    const svg = createRemoteSvg(remote.pattern, remote.mapping);
    document.getElementById('editorStage').appendChild(svg);
    const moveMode = document.getElementById('moveMode');
    const snapGrid = document.getElementById('snapGrid');
    const moveStatus = document.getElementById('moveStatus');
    const undoMove = document.getElementById('undoMove');

    const updateMoveStatus = (button, position = null) => {
      if (!button) {
        moveStatus.textContent = 'Trascina un tasto per spostarlo. Tocca un tasto per selezionarlo.';
        return;
      }
      const p = position || button;
      moveStatus.innerHTML = `<strong>${esc(button.label)}</strong> · x ${Math.round(p.x)} · y ${Math.round(p.y)}`;
    };

    const enableMoveMode = () => {
      if (positionEditor) return;
      moveMode.textContent = 'Fine spostamento';
      moveMode.classList.add('active-mode');
      moveStatus.classList.add('active');
      positionEditor = enableButtonPositionEditing(svg, remote, {
        getSnap: () => snapGrid.checked,
        onSelection: button => updateMoveStatus(button),
        onPreview: (button, pos) => updateMoveStatus(button, pos),
        onMoved: (button, oldPos, newPos) => {
          moveHistory.push({ id: button.id, x: oldPos.x, y: oldPos.y });
          undoMove.disabled = false;
          updateMoveStatus(button, newPos);
          showToast(`Posizione di ${button.label} salvata.`, 'ok', 1500);
        }
      });
    };

    const disableMoveMode = () => {
      positionEditor?.destroy(); positionEditor = null;
      moveMode.textContent = 'Sposta tasti';
      moveMode.classList.remove('active-mode');
      moveStatus.classList.remove('active');
      moveStatus.textContent = 'Attiva lo spostamento, poi trascina un tasto. Su PC puoi usare anche le frecce; Shift + freccia = 5 px.';
    };

    moveMode.onclick = () => positionEditor ? disableMoveMode() : enableMoveMode();
    undoMove.onclick = () => {
      const previous = moveHistory.pop();
      if (!previous) return;
      if (!positionEditor) enableMoveMode();
      positionEditor.setPosition(previous.id, previous.x, previous.y, { notify: false });
      undoMove.disabled = moveHistory.length === 0;
      const button = remote.pattern.buttons.find(x => x.id === previous.id);
      if (button) updateMoveStatus(button);
      showToast('Ultimo spostamento annullato.', 'ok', 1500);
    };

    const rows = document.getElementById('editorRows');
    remote.pattern.buttons.forEach(button => {
      const row = document.createElement('div'); row.className = 'button-editor-row'; row.dataset.buttonId = button.id;
      const mapped = remote.mapping?.[button.id];
      const ready = isTransmitReady(mapped);
      const dbOnly = !ready && !!remote.databaseSignals?.[button.id];
      const stateText = ready ? signalLabel(mapped) : dbOnly ? 'codice DB presente · da riapprendere' : 'non appreso';
      row.innerHTML = `<div class="button-editor-name"><strong>${esc(button.label)}</strong><div class="candidate-meta">${esc(stateText)}</div></div><span class="state-chip ${ready ? 'ready' : dbOnly ? 'db' : ''}">${ready ? 'Pronto' : dbOnly ? 'DB' : 'Vuoto'}</span><button class="btn small rename">Rinomina</button><button class="btn small learn">Riapprendi</button><button class="btn small danger remove">Elimina</button>`;
      row.addEventListener('click', event => {
        if (!positionEditor || event.target.closest('button')) return;
        positionEditor.selectById(button.id);
      });
      row.querySelector('.rename').onclick = () => {
        const label = prompt('Nuovo nome del tasto:', button.label);
        if (!label) return;
        button.label = label.trim();
        saveRemotes();
        showToast('Nome tasto aggiornato.', 'ok');
        renderButtonEditor(remote.id);
      };
      row.querySelector('.learn').onclick = () => openLearnModal(remote, button);
      row.querySelector('.remove').onclick = () => {
        remote.pattern.buttons = remote.pattern.buttons.filter(x => x.id !== button.id);
        delete remote.mapping[button.id];
        if (remote.databaseSignals) delete remote.databaseSignals[button.id];
        saveRemotes(); showToast('Tasto eliminato.', 'ok'); renderButtonEditor(remote.id);
      };
      rows.appendChild(row);
    });

    document.getElementById('addButton').onclick = async () => {
      const label = prompt('Nome del nuovo tasto:'); if (!label) return;
      const id = uid('key');
      const index = remote.pattern.buttons.length;
      const body = remote.pattern.body;
      const w = 90, h = 38, gap = 12;
      const cols = Math.max(1, Math.floor((body.w - 24) / (w + gap)));
      const col = index % cols;
      const row = Math.floor(index / cols);
      const x = clamp(body.x + 12 + col * (w + gap), body.x + 7, body.x + body.w - w - 7);
      const y = clamp(body.y + 90 + row * (h + gap), body.y + 7, body.y + body.h - h - 7);
      const newButton = b(id, label.trim(), x, y, w, h);
      remote.pattern.buttons.push(newButton);
      remote.mapping ||= {};
      remote.mapping[id] = null;
      saveRemotes();
      renderButtonEditor(remote.id);
      setTimeout(() => openLearnModal(remote, newButton), 0);
    };
  }

  function renderCloneStart() {
    enterView('clone-pattern');
    state.selectedPatternId = 'tv'; state.customPattern = null;
    app.innerHTML = `
      <div class="toolbar"><button class="btn" id="backAdd">&larr; Indietro</button></div>
      <div class="stepper"><span class="step active">1. Pattern</span><span class="step">2. Dati</span><span class="step">3. Apprendimento</span></div>
      <h1 class="page-title">Clona telecomando</h1>
      <p class="page-subtitle">Scegli la forma piu vicina al telecomando fisico.</p>
      <div id="patternPicker" class="pattern-picker"></div>
      <div class="toolbar" style="margin-top:18px"><button class="btn" id="customPattern">Pattern custom da foto / IA</button><div class="spacer"></div><button class="btn primary" id="patternNext">Continua</button></div>`;
    document.getElementById('backAdd').onclick = renderAddRemote;
    document.getElementById('customPattern').onclick = showCustomPatternModal;
    document.getElementById('patternNext').onclick = renderCloneMeta;
    renderPatternPicker();
  }

  function renderPatternPicker() {
    const holder = document.getElementById('patternPicker'); if (!holder) return;
    holder.innerHTML = '';
    Object.values(PATTERNS).forEach(pattern => {
      const tile = document.createElement('div'); tile.className = `pattern-tile ${state.selectedPatternId === pattern.id && !state.customPattern ? 'selected' : ''}`;
      const mini = document.createElement('div'); mini.className = 'pattern-mini'; mini.appendChild(createRemoteSvg(pattern, {}, null, true));
      tile.appendChild(mini); tile.insertAdjacentHTML('beforeend', `<strong>${pattern.name}</strong>`);
      tile.onclick = () => { state.selectedPatternId = pattern.id; state.customPattern = null; renderPatternPicker(); };
      holder.appendChild(tile);
    });
    if (state.customPattern) {
      const tile = document.createElement('div'); tile.className = 'pattern-tile selected';
      const mini = document.createElement('div'); mini.className = 'pattern-mini'; mini.appendChild(createRemoteSvg(state.customPattern, {}, null, true));
      tile.appendChild(mini); tile.insertAdjacentHTML('beforeend', `<strong>${esc(state.customPattern.name || 'Custom')}</strong>`); holder.appendChild(tile);
    }
  }

  function renderCloneMeta() {
    enterView('clone-meta');
    const pattern = clone(state.customPattern || PATTERNS[state.selectedPatternId]);
    state.cloning = { pattern, mapping: {}, index: 0 };
    app.innerHTML = `
      <div class="toolbar"><button class="btn" id="cloneBack">&larr; Pattern</button></div>
      <div class="stepper"><span class="step">1. Pattern</span><span class="step active">2. Dati</span><span class="step">3. Apprendimento</span></div>
      <h1 class="page-title">Dati telecomando</h1>
      <div class="card">
        <div class="field"><label>Nome telecomando</label><input id="cloneName" placeholder="Es. TV salotto"></div>
        <div class="form-row"><div class="field"><label>Tipo prodotto</label>${deviceTypeSelect('cloneType')}</div><div class="field"><label>Marca</label><input id="cloneBrand"></div><div class="field"><label>Modello</label><input id="cloneModel"></div></div>
        <button class="btn primary" id="startLearning">Inizia apprendimento</button>
      </div>`;
    document.getElementById('cloneBack').onclick = renderCloneStart;
    document.getElementById('startLearning').onclick = () => {
      const name = document.getElementById('cloneName').value.trim() || 'Telecomando clonato';
      state.cloning.remote = { schema: 'ir-remote-v1', id: uid('remote'), name, deviceType: document.getElementById('cloneType').value, brand: document.getElementById('cloneBrand').value.trim(), model: document.getElementById('cloneModel').value.trim(), source: 'clone', pattern, mapping: {}, createdAt: new Date().toISOString() };
      state.cloning.index = 0; renderCloneLearning();
    };
  }

  function renderCloneLearning() {
    enterView('clone-learning');
    const session = state.cloning;
    const remote = session.remote;
    const buttons = remote.pattern.buttons;
    const current = buttons[session.index];
    if (!current) {
      state.remotes.push(remote); saveRemotes(); state.cloning = null; renderRemote(remote.id); return;
    }

    app.innerHTML = `
      <div class="toolbar"><button class="btn" id="cancelClone">Annulla</button></div>
      <div class="stepper"><span class="step">1. Pattern</span><span class="step">2. Dati</span><span class="step active">3. Apprendimento</span></div>
      <h1 class="page-title">Apprendimento ${session.index + 1}/${buttons.length}</h1>
      <p class="page-subtitle">Premi sul telecomando fisico il tasto evidenziato: <strong>${esc(current.label)}</strong></p>
      <div class="remote-layout"><div class="card remote-stage" id="learnStage"></div><div class="card"><div id="learnStatus" class="notice">In attesa...</div><button class="btn" id="skipButton">Salta questo tasto</button></div></div>`;
    document.getElementById('cancelClone').onclick = () => { cancelActiveAcquisition({ sendCancel: true }); state.cloning = null; renderAddRemote(); };
    document.getElementById('skipButton').onclick = () => { cancelActiveAcquisition({ sendCancel: true }); session.index++; renderCloneLearning(); };
    document.getElementById('learnStage').appendChild(createRemoteSvg(remote.pattern, remote.mapping, null, false, current.id));

    const learningIndex = session.index;
    learnSignal(`Premi ${current.label}`, document.getElementById('learnStatus')).then(signal => {
      // Ignore an old asynchronous acquisition if the user already skipped,
      // cancelled or moved to another button.
      if (state.cloning !== session || session.index !== learningIndex) return;
      remote.mapping[current.id] = signal;
      session.index++;
      setTimeout(renderCloneLearning, 350);
    }).catch(error => {
      if (state.cloning !== session || session.index !== learningIndex) return;
      const box = document.getElementById('learnStatus');
      if (!box) return;
      box.className = 'notice warn';
      box.innerHTML = `${esc(error.message)}<div style="margin-top:10px"><button class="btn" id="retryCloneLearn">Riprova acquisizione</button></div>`;
      const retry = document.getElementById('retryCloneLearn');
      if (retry) retry.onclick = () => renderCloneLearning();
    });
  }

  function renderRecognize() {
    enterView('recognize');
    state.recognition = { captures: [], step: 0 };
    app.innerHTML = `
      <div class="toolbar"><button class="btn" id="backAdd">&larr; Indietro</button></div>
      <h1 class="page-title">Riconosci telecomando</h1>
      <p class="page-subtitle">Scegli il tipo di prodotto e acquisisci tre tasti diversi.</p>
      <div class="card">
        <div class="field"><label>Tipo prodotto</label>${deviceTypeSelect('recognizeType')}</div>
        <button class="btn primary" id="recognizeStart">Inizia</button>
        <div id="recognizeArea"></div>
      </div>`;
    document.getElementById('backAdd').onclick = renderAddRemote;
    document.getElementById('recognizeStart').onclick = event => { event.currentTarget.disabled = true; recognizeNext(); };
  }

  async function recognizeNext() {
    const session = state.recognition;
    if (!session || state.currentView !== 'recognize') return;
    const type = document.getElementById('recognizeType')?.value || 'unknown';
    const prompts = recognitionPrompts(type);
    const area = document.getElementById('recognizeArea');
    if (session.step >= 3) return showRecognitionResults(type, session.captures, area);
    area.innerHTML = `<div class="notice">${prompts[session.step]} (${session.step + 1}/3)</div>`;
    try {
      const signal = await learnSignal(prompts[session.step], area.querySelector('.notice'));
      if (state.recognition !== session || state.currentView !== 'recognize') return;
      session.captures.push(signal); session.step++; recognizeNext();
    } catch (error) {
      if (isAcquisitionCancelled(error)) return;
      area.innerHTML = `<div class="notice warn">${esc(error.message)}</div><button class="btn" id="retryRecognition">Riprova</button>`;
      const retryButton = document.getElementById('retryRecognition');
      if (retryButton) retryButton.onclick = recognizeNext;
    }
  }

  function narrowRecognitionMetas(metas, captures) {
    const pairs = new Set();
    for (const capture of captures) {
      const bytes = signalDecodedBytes(capture);
      if (!bytes || bytes.length < 2) continue;
      const d = bytes[0] & 0xFF;
      const s = bytes[1] & 0xFF;
      pairs.add(`${d},${s}`);
      if (((d ^ s) & 0xFF) === 0xFF) pairs.add(`${d},-1`);
    }
    if (!pairs.size) return metas.slice(0, 160);
    const preferred = [], other = [];
    for (const meta of metas) {
      if (meta.source === 'probonopd-irdb' && pairs.has(String(meta.deviceSubdevice || ''))) preferred.push(meta);
      else other.push(meta);
    }
    // IRDB encodes device/subdevice in the filename, so exact pairs can be
    // checked first. Keep a small fallback set for protocols whose addressing
    // cannot be inferred from the generic RAW decoder.
    return [...preferred, ...other.slice(0, preferred.length ? 60 : 140)].slice(0, 220);
  }

  async function showRecognitionResults(type, captures, area) {
    if (state.currentView !== 'recognize') return;
    const localCandidates = window.REMOTE_DB.map(entry => ({ kind: 'local', entry, score: scoreCandidate(entry, type, captures) })).filter(x => x.score > 0);
    const all = localCandidates.slice();
    area.innerHTML = '<h3>Risultati</h3><div class="notice" id="recognitionDbProgress">Confronto con il database esteso...</div>';

    if (window.IR_EXTERNAL_DB) {
      try {
        let metas = await window.IR_EXTERNAL_DB.search({ deviceType: type, limit: 800, includeIrdB: true });
        metas = narrowRecognitionMetas(metas, captures);
        const progress = document.getElementById('recognitionDbProgress');
        let checked = 0;
        const batchSize = 10;
        for (let base = 0; base < metas.length; base += batchSize) {
          const batch = metas.slice(base, base + batchSize);
          const loaded = await Promise.allSettled(batch.map(meta => window.IR_EXTERNAL_DB.loadAppRemote(meta)));
          if (state.currentView !== 'recognize') return;
          loaded.forEach((result, index) => {
            checked++;
            const meta = batch[index];
            if (result.status === 'fulfilled') {
              const def = result.value;
              const score = scoreExternalCandidate(def, type, captures);
              if (score > 0) all.push({ kind: 'external', entry: meta, definition: def, score });
            } else console.debug('DB candidate skipped', meta.id, result.reason?.message || result.reason);
          });
          if (progress) progress.textContent = `Scansione database: ${checked}/${metas.length} profili...`;
          // If all three captures match the same profile, no need to continue the whole network scan.
          if (all.some(x => x.kind === 'external' && x.score >= 32)) break;
        }
      } catch (error) {
        console.warn('External recognition database unavailable', error);
        const progress = document.getElementById('recognitionDbProgress');
        if (progress) progress.textContent = `Database esteso non disponibile: ${error.message}`;
      }
    }

    all.sort((a, b) => b.score - a.score);
    area.innerHTML = '<h3>Risultati</h3>';
    if (!all.length) {
      area.innerHTML += '<div class="notice warn">Nessuna corrispondenza. Il telecomando puo comunque essere clonato in RAW senza conoscere il protocollo.</div>';
      return;
    }
    all.slice(0, 10).forEach(candidate => {
      const entry = candidate.kind === 'local' ? candidate.entry : candidate.definition;
      const row = document.createElement('div'); row.className = 'candidate';
      const source = candidate.kind === 'local' ? 'database locale' : entry.sourceName || 'database esterno';
      const levelText = candidate.entry?.recognitionLevel === 'family' ? ' · famiglia, modello da confermare' : '';
      row.innerHTML = `<div><div class="candidate-title">${esc(entry.brand)} ${esc(entry.model)}</div><div class="candidate-meta">Punteggio ${candidate.score} · ${esc(source)}${levelText}</div></div><button class="btn primary">Usa</button>`;
      row.querySelector('button').onclick = async () => {
        if (candidate.kind === 'local') saveDbRemote(candidate.entry, { captures, type });
        else saveExternalDefinition(candidate.definition, { captures, type });
      };
      area.appendChild(row);
    });
  }

  function scoreCandidate(entry, type, captures) {
    let score = 0;
    let evidence = 0;
    const dbSignals = Object.values(entry.signals || {}).map(bytes => signalFromDb(entry, bytes));

    captures.forEach(signal => {
      let exact = false;
      let family = false;
      for (const dbSignal of dbSignals) {
        if (sameSignal(signal, dbSignal)) exact = true;
        const a = signalDecodedBytes(signal);
        const b = signalDecodedBytes(dbSignal);
        if (a && b && a.length >= 2 && b.length >= 2 && a[0] === b[0] && a[1] === b[1]) family = true;
      }
      if (exact) { score += 10; evidence++; }
      else if (family) { score += 5; evidence++; }
    });

    if (evidence > 0 && entry.deviceType === type) score += 2;
    return evidence > 0 ? score : 0;
  }

  function scoreExternalCandidate(definition, type, captures) {
    const signals = [];
    for (const button of definition.buttons || []) {
      const raw = externalSignalAsRaw(button.signal);
      if (raw) signals.push(raw);
    }
    if (!signals.length) return 0;
    let score = 0, evidence = 0;
    for (const capture of captures) {
      let exact = false, family = false;
      for (const dbSignal of signals) {
        if (sameSignal(capture, dbSignal)) { exact = true; break; }
        const a = signalDecodedBytes(capture), b = signalDecodedBytes(dbSignal);
        if (a && b && a.length >= 2 && b.length >= 2 && a[0] === b[0] && a[1] === b[1]) family = true;
      }
      if (exact) { score += 10; evidence++; }
      else if (family) { score += 4; evidence++; }
    }
    if (evidence && definition.deviceType === type) score += 2;
    return evidence ? score : 0;
  }

  function externalSignalAsRaw(signal) {
    if (!signal) return null;
    let raw = signal;
    if (signal.protocol !== 'RAW') raw = window.IR_EXTERNAL_DB?.toRaw(signal);
    if (!raw?.raw?.length) return null;
    return { ...raw, decoded: analyzeRawSignal(raw.raw), carrierHz: raw.carrierHz || 38000 };
  }

  function renderModelSearch() {
    enterView('model-search');
    app.innerHTML = `
      <div class="toolbar"><button class="btn" id="backAdd">&larr; Indietro</button></div>
      <h1 class="page-title">Ricerca modello</h1>
      <p class="page-subtitle">Ricerca nel database locale + irdb. FlipperDevices viene incluso quando il suo indice e disponibile.</p>
      <div class="card">
        <div class="form-row"><div class="field"><label>Tipo prodotto</label>${deviceTypeSelect('modelType')}</div><div class="field"><label>Marca</label><input id="modelBrand" placeholder="Es. LG"></div><div class="field"><label>Modello</label><input id="modelName" placeholder="Es. AKB, 55UN, BN59..."></div></div>
        <button class="btn primary" id="modelSearchButton">Cerca</button>
        <div id="modelResults"></div>
      </div>`;
    document.getElementById('backAdd').onclick = renderAddRemote;
    document.getElementById('modelSearchButton').onclick = runModelSearch;
  }

  async function runModelSearch() {
    const type = document.getElementById('modelType').value;
    const brandText = document.getElementById('modelBrand').value.trim();
    const brand = brandText.toLowerCase();
    const modelText = document.getElementById('modelName').value.trim();
    const model = modelText.toLowerCase();
    const holder = document.getElementById('modelResults');
    holder.innerHTML = '<h3>Opzioni</h3><div class="notice">Ricerca database...</div>';

    const local = window.REMOTE_DB.filter(entry =>
      (type === 'unknown' || entry.deviceType === type) &&
      (!brand || entry.brand.toLowerCase().includes(brand)) &&
      (!model || entry.model.toLowerCase().includes(model))
    );
    holder.innerHTML = '<h3>Opzioni</h3>';
    local.forEach(entry => appendDbCandidate(holder, entry));

    if (window.IR_EXTERNAL_DB) {
      try {
        const ext = await window.IR_EXTERNAL_DB.search({ deviceType: type, brand: brandText, model: modelText, limit: 250, includeIrdB: true });
        ext.forEach(meta => appendExternalCandidate(holder, meta));
        if (!local.length && !ext.length) holder.innerHTML += '<div class="notice warn">Nessun modello trovato con questi filtri.</div>';
        else holder.insertAdjacentHTML('afterbegin', `<div class="notice ok">${local.length + ext.length} risultati visualizzati${ext.length >= 250 ? ' (limite 250: restringi marca/modello)' : ''}.</div>`);
      } catch (error) {
        holder.innerHTML += `<div class="notice warn">Database online non disponibile: ${esc(error.message)}</div>`;
      }
    }
  }

  function appendDbCandidate(holder, entry) {
    const row = document.createElement('div'); row.className = 'candidate';
    row.innerHTML = `<div><div class="candidate-title">${esc(entry.brand)} ${esc(entry.model)}</div><div class="candidate-meta">${esc(entry.deviceType)} · locale ${entry.powerButtonId ? '· Power test disponibile' : '· nessun Power identificato'}</div><div class="candidate-meta candidate-status"></div></div><div><button class="btn small test" ${entry.powerButtonId ? '' : 'disabled'}>Test</button> <button class="btn small primary use">Usa</button></div>`;
    const status = row.querySelector('.candidate-status');
    row.querySelector('.test').onclick = async event => {
      const bytes = entry.signals[entry.powerButtonId]; if (!bytes) return;
      const button = event.currentTarget; button.disabled = true;
      try { await sendSignal(signalFromDb(entry, bytes)); status.textContent = 'Power inviato.'; }
      catch (error) { status.textContent = `Errore test: ${error.message}`; }
      finally { button.disabled = false; }
    };
    row.querySelector('.use').onclick = () => saveDbRemote(entry);
    holder.appendChild(row);
  }

  function appendExternalCandidate(holder, meta) {
    const row = document.createElement('div'); row.className = 'candidate';
    row.innerHTML = `<div><div class="candidate-title">${esc(meta.brand)} ${esc(meta.model)}</div><div class="candidate-meta">${esc(meta.category || meta.deviceType)} · ${esc(meta.sourceName || meta.source)}</div><div class="candidate-meta candidate-status"></div></div><div><button class="btn small test">Test Power</button> <button class="btn small primary use">Usa</button></div>`;
    const status = row.querySelector('.candidate-status');
    row.querySelector('.test').onclick = async event => {
      const button = event.currentTarget; button.disabled = true; button.textContent = 'Carico...';
      try {
        const def = await window.IR_EXTERNAL_DB.loadAppRemote(meta);
        const power = (def.buttons || []).find(x => x.buttonId === 'power');
        if (!power) throw new Error('Nessun tasto Power identificato in questo profilo.');
        const raw = externalSignalAsRaw(power.signal);
        if (!raw) throw new Error(`Il codice Power usa ${power.signal.parsed?.protocol || power.signal.protocol}, non ancora sintetizzabile in RAW. Il profilo resta importabile e i tasti possono essere appresi.`);
        await sendSignal(raw);
        button.textContent = 'Inviato'; status.textContent = 'Power inviato.';
      } catch (error) { status.textContent = error.message; button.textContent = 'Test Power'; }
      button.disabled = false;
    };
    row.querySelector('.use').onclick = async event => {
      const button = event.currentTarget; button.disabled = true; button.textContent = 'Carico...';
      try { saveExternalDefinition(await window.IR_EXTERNAL_DB.loadAppRemote(meta)); }
      catch (error) { status.textContent = error.message; button.disabled = false; button.textContent = 'Usa'; }
    };
    holder.appendChild(row);
  }

  function saveDbRemote(entry, options = {}) {
    const remote = buildRemoteFromDb(entry);
    if (options.captures?.length) applyRecognitionCaptures(remote, options.type || remote.deviceType, options.captures);
    state.remotes.push(remote); saveRemotes(); renderRemote(remote.id);
  }

  function saveExternalDefinition(definition, options = {}) {
    const remote = buildRemoteFromExternal(definition);
    if (options.captures?.length) applyRecognitionCaptures(remote, options.type || remote.deviceType, options.captures);
    state.remotes.push(remote); saveRemotes(); renderRemote(remote.id);
  }

  function buildRemoteFromExternal(definition) {
    const pattern = clone(PATTERNS[definition.patternId] || PATTERNS.compact);
    const mapping = {};
    const databaseSignals = {};
    const unknownButtons = [];
    for (const item of definition.buttons || []) {
      const ready = externalSignalAsRaw(item.signal);
      if (ready) mapping[item.buttonId] = ready;
      else databaseSignals[item.buttonId] = item.signal;
      if (!pattern.buttons.some(x => x.id === item.buttonId)) unknownButtons.push(item);
    }
    if (unknownButtons.length) {
      unknownButtons.forEach(item => ensurePatternButton(pattern, item.buttonId, shortenButtonLabel(item.name)));
    }
    const remote = {
      schema: 'ir-remote-v1', id: uid('remote'), name: `${definition.brand} ${definition.model}`,
      deviceType: definition.deviceType, brand: definition.brand, model: definition.model,
      source: definition.source, sourceName: definition.sourceName, sourceId: definition.sourceId, license: definition.license,
      pattern, mapping, createdAt: new Date().toISOString()
    };
    if (Object.keys(databaseSignals).length) remote.databaseSignals = databaseSignals;
    return remote;
  }

  function recognitionSteps(type) {
    const map = {
      tv: [
        { id: 'power', label: 'Power', prompt: 'Premi POWER', semantic: 'power' },
        { id: 'vol_up', label: 'Vol +', prompt: 'Premi VOL +', semantic: 'volume_up' },
        { id: 'vol_down', label: 'Vol -', prompt: 'Premi VOL -', semantic: 'volume_down' }
      ],
      dvd: [
        { id: 'power', label: 'Power', prompt: 'Premi POWER', semantic: 'power' },
        { id: 'play', label: 'Play', prompt: 'Premi PLAY', semantic: 'play' },
        { id: 'stop', label: 'Stop', prompt: 'Premi STOP', semantic: 'stop' }
      ],
      audio: [
        { id: 'power', label: 'Power', prompt: 'Premi POWER', semantic: 'power' },
        { id: 'vol_up', label: 'Vol +', prompt: 'Premi VOL +', semantic: 'volume_up' },
        { id: 'mute', label: 'Mute', prompt: 'Premi MUTE', semantic: 'mute' }
      ],
      stb: [
        { id: 'power', label: 'Power', prompt: 'Premi POWER', semantic: 'power' },
        { id: 'ch_up', label: 'Ch +', prompt: 'Premi CH +', semantic: 'channel_up' },
        { id: 'ch_down', label: 'Ch -', prompt: 'Premi CH -', semantic: 'channel_down' }
      ],
      projector: [
        { id: 'power', label: 'Power', prompt: 'Premi POWER', semantic: 'power' },
        { id: 'input', label: 'Input', prompt: 'Premi INPUT', semantic: 'input' },
        { id: 'menu', label: 'Menu', prompt: 'Premi MENU', semantic: 'menu' }
      ],
      ac: [
        { id: 'power', label: 'Power', prompt: 'Premi POWER', semantic: 'power' },
        { id: 'temp_up', label: 'Temp +', prompt: 'Premi TEMP +', semantic: 'temp_up' },
        { id: 'mode', label: 'Mode', prompt: 'Premi MODE', semantic: 'mode' }
      ],
      fan: [
        { id: 'power', label: 'Power', prompt: 'Premi POWER', semantic: 'power' },
        { id: 'speed_up', label: 'Speed +', prompt: 'Premi SPEED +', semantic: 'speed_up' },
        { id: 'swing', label: 'Swing', prompt: 'Premi SWING', semantic: 'swing' }
      ],
      light: [
        { id: 'power', label: 'Power', prompt: 'Premi POWER', semantic: 'power' },
        { id: 'color_test', label: 'Colore', prompt: 'Premi un tasto colore', semantic: 'color' },
        { id: 'effect_test', label: 'Effetto', prompt: 'Premi un tasto effetto', semantic: 'effect' }
      ]
    };
    return map[type] || [
      { id: 'learned_1', label: 'Tasto 1', prompt: 'Premi un primo tasto', semantic: '' },
      { id: 'learned_2', label: 'Tasto 2', prompt: 'Premi un secondo tasto diverso', semantic: '' },
      { id: 'learned_3', label: 'Tasto 3', prompt: 'Premi un terzo tasto diverso', semantic: '' }
    ];
  }

  function applyRecognitionCaptures(remote, type, captures) {
    const steps = recognitionSteps(type);
    remote.mapping ||= {};
    steps.forEach((step, index) => {
      const signal = captures[index];
      if (!signal) return;
      ensurePatternButton(remote.pattern, step.id, step.label, step.semantic);
      remote.mapping[step.id] = signal;
      if (remote.databaseSignals) delete remote.databaseSignals[step.id];
    });
    remote.recognition = { type, capturedButtons: Math.min(captures.length, steps.length), at: new Date().toISOString() };
    return remote;
  }

  function shortenButtonLabel(name) {
    const text = String(name || '').replace(/_/g, ' ').trim();
    return text.length <= 12 ? text : `${text.slice(0, 11)}…`;
  }

  function renderAutoSearch() {
    enterView('auto-search');
    app.innerHTML = `
      <div class="toolbar"><button class="btn" id="backAdd">&larr; Indietro</button></div>
      <h1 class="page-title">Ricerca automatica</h1>
      <p class="page-subtitle">Il programma prova i codici Power. Specificare marca e tipo riduce drasticamente il tempo.</p>
      <div class="card">
        <div class="form-row"><div class="field"><label>Tipo prodotto</label>${deviceTypeSelect('autoType')}</div><div class="field"><label>Marca (consigliata)</label><input id="autoBrand" placeholder="Es. LG"></div></div>
        <button class="btn primary" id="autoStart">Avvia ricerca</button>
        <button class="btn hidden" id="autoReacted">Ha reagito</button>
        <button class="btn hidden" id="autoStop">Stop</button>
        <div id="autoStatus" class="notice">Pronto.</div>
      </div>`;
    document.getElementById('backAdd').onclick = () => { stopAutoSearch(); renderAddRemote(); };
    document.getElementById('autoStart').onclick = startAutoSearch;
    document.getElementById('autoStop').onclick = stopAutoSearch;
    document.getElementById('autoReacted').onclick = () => {
      const current = state.autoSearch?.current;
      stopAutoSearch();
      if (!current) return;
      if (current.kind === 'local') saveDbRemote(current.entry);
      else if (current.definition) saveExternalDefinition(current.definition);
    };
  }

  async function startAutoSearch() {
    stopAutoSearch();
    const type = document.getElementById('autoType').value;
    const brand = document.getElementById('autoBrand').value.trim();
    const status = document.getElementById('autoStatus');
    const startButton = document.getElementById('autoStart');
    startButton.disabled = true;
    const candidates = window.REMOTE_DB
      .filter(entry => entry.powerButtonId && (type === 'unknown' || entry.deviceType === type) && (!brand || String(entry.brand || '').toLowerCase().includes(brand.toLowerCase())))
      .map(entry => ({ kind: 'local', entry }));
    status.textContent = 'Preparazione candidati database...';
    if (window.IR_EXTERNAL_DB) {
      try {
        const metas = await window.IR_EXTERNAL_DB.search({ deviceType: type, brand, limit: brand ? 300 : 120, includeIrdB: true });
        for (const meta of metas) candidates.push({ kind: 'external', meta });
      } catch (error) { console.warn('Auto search DB', error); }
    }
    if (!candidates.length) {
      status.textContent = 'Nessun candidato disponibile per questo filtro.';
      startButton.disabled = false;
      return;
    }

    const session = { active: true, index: 0, candidates, current: null };
    state.autoSearch = session;
    document.getElementById('autoReacted').classList.remove('hidden');
    document.getElementById('autoStop').classList.remove('hidden');

    while (state.autoSearch === session && session.active && session.index < candidates.length) {
      const candidate = candidates[session.index++];
      let signal = null, label = '';
      try {
        if (candidate.kind === 'local') {
          const entry = candidate.entry;
          signal = signalFromDb(entry, entry.signals[entry.powerButtonId]);
          label = `${entry.brand} ${entry.model}`;
          session.current = { kind: 'local', entry };
        } else {
          const def = await window.IR_EXTERNAL_DB.loadAppRemote(candidate.meta);
          if (state.autoSearch !== session || !session.active) break;
          const power = (def.buttons || []).find(x => x.buttonId === 'power');
          if (!power) continue;
          signal = externalSignalAsRaw(power.signal);
          if (!signal) continue;
          label = `${def.brand} ${def.model}`;
          session.current = { kind: 'external', definition: def };
        }
        if (state.autoSearch !== session || !session.active) break;
        status.innerHTML = `Test ${session.index}/${candidates.length}: <strong>${esc(label)}</strong>`;
        await sendSignal(signal);
        if (state.autoSearch !== session || !session.active) break;
        await sleep(1400);
      } catch (error) {
        console.debug('Auto search candidate skipped', error);
      }
    }
    if (state.autoSearch === session && session.active) {
      status.textContent = 'Fine candidati: nessuna reazione confermata.';
      stopAutoSearch();
    }
    if (document.getElementById('autoStart')) document.getElementById('autoStart').disabled = false;
  }

  function stopAutoSearch() {
    if (state.autoSearch) state.autoSearch.active = false;
    state.autoSearch = null;
    document.getElementById('autoReacted')?.classList.add('hidden');
    document.getElementById('autoStop')?.classList.add('hidden');
    if (document.getElementById('autoStart')) document.getElementById('autoStart').disabled = false;
  }

  function renderImport() {
    enterView('import');
    app.innerHTML = `
      <div class="toolbar"><button class="btn" id="backAdd">&larr; Indietro</button></div>
      <h1 class="page-title">Importa JSON</h1>
      <div class="card"><div class="field"><label>File JSON</label><input type="file" id="importFile" accept="application/json,.json"></div><div class="field"><label>Oppure incolla JSON</label><textarea id="importText"></textarea></div><button class="btn primary" id="importButton">Importa</button><div id="importStatus" class="notice hidden" style="margin-top:12px"></div></div>`;
    document.getElementById('backAdd').onclick = renderAddRemote;
    document.getElementById('importFile').onchange = async e => { const file = e.target.files[0]; if (file) document.getElementById('importText').value = await file.text(); };
    document.getElementById('importButton').onclick = () => {
      try {
        const remote = JSON.parse(document.getElementById('importText').value);
        validateRemote(remote); remote.id = uid('remote'); remote.createdAt = new Date().toISOString(); state.remotes.push(remote); saveRemotes(); renderRemote(remote.id);
      } catch (error) {
        const status = document.getElementById('importStatus');
        if (status) { status.className = 'notice warn'; status.textContent = `JSON non valido: ${error.message}`; }
      }
    };
  }

  function renderAdvanced() {
    enterView('advanced');
    app.innerHTML = `
      <div class="toolbar"><button class="btn" id="backAdd">&larr; Indietro</button></div>
      <h1 class="page-title">Modalita avanzata</h1>
      <p class="page-subtitle">Invio avanzato. Il builder esadecimale genera un frame pulse-distance, poi viene trasmesso come RAW universale.</p>
      <div class="card">
        <div class="form-row">
          <div class="field"><label>Carrier Hz</label><input id="advCarrier" value="38000"></div>
          <div class="field"><label>Header mark us</label><input id="advHm" value="4600"></div>
          <div class="field"><label>Header space us</label><input id="advHs" value="4400"></div>
          <div class="field"><label>Bit mark us</label><input id="advBm" value="620"></div>
          <div class="field"><label>Zero space us</label><input id="advZero" value="500"></div>
          <div class="field"><label>One space us</label><input id="advOne" value="1600"></div>
        </div>
        <div class="form-row">
          <div class="field"><label>Byte 0</label><input id="advB0" value="0E"></div>
          <div class="field"><label>Byte 1</label><input id="advB1" value="0E"></div>
          <div class="field"><label>Comando</label><input id="advB2" value="0C"></div>
          <div class="field"><label>Complemento</label><input id="advB3" value="F3"></div>
        </div>
        <button class="btn primary" id="advSend">Invia</button>
        <div id="advStatus" class="notice">Pronto.</div>
      </div>`;
    document.getElementById('backAdd').onclick = renderAddRemote;
    document.getElementById('advSend').onclick = async () => {
      try {
        const signal = readAdvancedSignal(); await sendSignal(signal);
        document.getElementById('advStatus').className = 'notice ok'; document.getElementById('advStatus').textContent = `Inviato: ${signalLabel(signal)}`;
      } catch (error) { document.getElementById('advStatus').className = 'notice warn'; document.getElementById('advStatus').textContent = error.message; }
    };
  }

  function readAdvancedSignal() {
    const byteIds = ['advB0', 'advB1', 'advB2', 'advB3'];
    const bytes = byteIds.map(id => {
      const value = parseInt(document.getElementById(id).value.trim(), 16);
      if (!Number.isInteger(value) || value < 0 || value > 255) throw new Error(`Byte non valido: ${id}`);
      return value;
    });
    const carrierHz = Number(document.getElementById('advCarrier').value);
    const timings = {
      headerMark: Number(document.getElementById('advHm').value),
      headerSpace: Number(document.getElementById('advHs').value),
      bitMark: Number(document.getElementById('advBm').value),
      zeroSpace: Number(document.getElementById('advZero').value),
      oneSpace: Number(document.getElementById('advOne').value)
    };
    if (!Number.isFinite(carrierHz) || carrierHz < 30000 || carrierHz > 60000) throw new Error('Carrier deve essere tra 30000 e 60000 Hz.');
    for (const [name, value] of Object.entries(timings)) {
      if (!Number.isFinite(value) || value < 1 || value > 65535) throw new Error(`${name} deve essere tra 1 e 65535 us.`);
    }
    return { protocol: 'PD32', carrierHz, timings, bytes };
  }

  function createRemoteSvg(pattern, mapping = {}, onButton = null, preview = false, learningId = null) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg'); svg.setAttribute('viewBox', `0 0 ${pattern.width} ${pattern.height}`); svg.classList.add('remote-svg');
    const body = document.createElementNS(ns, 'rect'); body.setAttribute('x', pattern.body.x); body.setAttribute('y', pattern.body.y); body.setAttribute('width', pattern.body.w); body.setAttribute('height', pattern.body.h); body.setAttribute('rx', pattern.body.rx || 30); body.classList.add('remote-body'); svg.appendChild(body);
    (pattern.decorations || []).forEach(d => {
      let el = null;
      if (d.type === 'rect') {
        el = document.createElementNS(ns, 'rect');
        ['x','y','w','h','rx'].forEach(k => { if (d[k] != null) el.setAttribute(k === 'w' ? 'width' : k === 'h' ? 'height' : k, d[k]); });
      } else if (d.type === 'circle') {
        el = document.createElementNS(ns, 'circle');
        ['cx','cy','r'].forEach(k => { if (d[k] != null) el.setAttribute(k, d[k]); });
      } else if (d.type === 'line') {
        el = document.createElementNS(ns, 'line');
        ['x1','y1','x2','y2'].forEach(k => { if (d[k] != null) el.setAttribute(k, d[k]); });
      } else if (d.type === 'text') {
        el = document.createElementNS(ns, 'text');
        el.setAttribute('x', d.x || 0); el.setAttribute('y', d.y || 0);
        if (d.size) el.setAttribute('font-size', d.size);
        el.textContent = d.text || '';
        el.classList.add('remote-decoration-text');
      }
      if (!el) return;
      if (d.type !== 'text') el.classList.add('remote-decoration');
      svg.appendChild(el);
    });
    pattern.buttons.forEach(button => {
      const group = document.createElementNS(ns, 'g');
      group.classList.add('remote-button-group');
      group.dataset.buttonId = button.id;
      group.setAttribute('aria-label', button.label);
      const rect = document.createElementNS(ns, 'rect'); rect.setAttribute('x', button.x); rect.setAttribute('y', button.y); rect.setAttribute('width', button.w); rect.setAttribute('height', button.h); rect.setAttribute('rx', button.shape === 'circle' ? Math.min(button.w, button.h) / 2 : 11); rect.classList.add('remote-button'); if (button.semantic === 'power' || button.id === 'power') rect.classList.add('power'); if (button.id === learningId) rect.classList.add('learning');
      if (!preview) rect.classList.add(isTransmitReady(mapping?.[button.id]) ? 'learned' : 'unlearned');
      const label = document.createElementNS(ns, 'text'); label.setAttribute('x', button.x + button.w / 2); label.setAttribute('y', button.y + button.h / 2); label.classList.add('remote-label'); label.textContent = button.label;
      group.appendChild(rect); group.appendChild(label);
      if (onButton && !preview) group.addEventListener('click', () => onButton(button));
      svg.appendChild(group);
    });
    return svg;
  }

  function showCustomPatternModal() {
    const promptText = buildAiPatternPrompt();
    modalRoot.innerHTML = `<div class="modal-backdrop"><div class="modal"><h2>Pattern custom da foto</h2><p>Invia questo prompt a una IA insieme alla foto del telecomando. Poi incolla qui il JSON restituito.</p><div class="field"><label>Prompt da copiare</label><textarea id="aiPrompt" readonly></textarea></div><button class="btn" id="copyPrompt">Copia prompt</button><div class="field" style="margin-top:16px"><label>JSON pattern</label><textarea id="customPatternJson" placeholder="{ ... }"></textarea></div><div id="customPatternStatus" class="notice hidden"></div><div class="toolbar"><button class="btn" id="closePatternModal">Annulla</button><div class="spacer"></div><button class="btn primary" id="usePatternJson">Usa pattern</button></div></div></div>`;
    document.getElementById('aiPrompt').value = promptText;
    document.getElementById('copyPrompt').onclick = async () => {
      const status = document.getElementById('customPatternStatus');
      try { await navigator.clipboard.writeText(promptText); if (status) { status.className = 'notice ok'; status.textContent = 'Prompt copiato.'; } }
      catch (error) { if (status) { status.className = 'notice warn'; status.textContent = `Copia non riuscita: ${error.message}. Seleziona il testo manualmente.`; } }
    };
    document.getElementById('closePatternModal').onclick = () => modalRoot.innerHTML = '';
    document.getElementById('usePatternJson').onclick = () => {
      try { const pattern = JSON.parse(document.getElementById('customPatternJson').value); validatePattern(pattern); pattern.id = uid('pattern'); state.customPattern = pattern; modalRoot.innerHTML = ''; renderPatternPicker(); }
      catch (error) { const status = document.getElementById('customPatternStatus'); if (status) { status.className = 'notice warn'; status.textContent = `Pattern non valido: ${error.message}`; } }
    };
  }

  function buildAiPatternPrompt() {
    return `ROLE
You are a precision UI-layout extractor. You receive one or more photos of ONE physical infrared remote control and must reconstruct its FRONT FACE as a clean, stylized, clickable remote-control layout.

ABSOLUTE OUTPUT RULE
Return ONLY one valid JSON object matching the schema below. No Markdown. No code fences. No explanation. No comments. No extra keys containing prose. The JSON must parse with JSON.parse() without modification.

PRIMARY OBJECTIVE
The rendered result must let a human who has the physical remote immediately recognize where every physical button is. Geometry and button order are more important than visual decoration. Do not omit small buttons.

PHOTO INTERPRETATION
- Identify the true top and bottom of the remote before placing anything.
- Mentally rectify perspective: produce a straight front view, not a trapezoid caused by camera angle.
- If multiple photos are supplied, merge information from all photos but describe ONE remote only.
- Ignore hands, table, shadows, reflections, stickers that are not controls, and background objects.
- Distinguish pressable controls from printed text, LEDs, IR windows, display glass, logos and decorative separators.
- If a label is unreadable, preserve the button position and use a neutral descriptive label rather than inventing a function.

COORDINATE SYSTEM
- Use integer coordinates only.
- Canvas width: 260..420. Canvas height: 480..1100.
- Origin (0,0) is the top-left of the canvas. x increases right; y increases down.
- body must fit inside the canvas and approximate the real outer silhouette.
- Keep >= 10 px inside the body around buttons unless the photo clearly shows edge-mounted keys.
- Preserve row/column alignment, unequal gaps, asymmetry, button sizes, group spacing and relative vertical positions.
- Never overlap buttons. Never place a button outside the body.

EXACT JSON SCHEMA
{
  "schema": "ir-pattern-v1",
  "name": "Brand + model if readable, otherwise a short descriptive name",
  "width": 320,
  "height": 760,
  "body": {"x":24,"y":10,"w":272,"h":740,"rx":58},
  "decorations": [
    {"type":"rect","x":105,"y":34,"w":110,"h":18,"rx":9},
    {"type":"circle","cx":160,"cy":62,"r":5},
    {"type":"line","x1":60,"y1":140,"x2":260,"y2":140},
    {"type":"text","x":160,"y":120,"text":"DISPLAY","size":13}
  ],
  "buttons": [
    {"id":"power","label":"Power","x":52,"y":80,"w":60,"h":42,"shape":"rounded","semantic":"power"}
  ]
}

BUTTON EXTRACTION - MANDATORY
1. Count every independently pressable physical control visible in the photo. buttons[] must contain the same number, unless a control is clearly not pressable.
2. A two-ended rocker is TWO buttons. A four-way D-pad is FOUR direction buttons plus the center OK button when present.
3. A circular navigation ring must NOT be represented as one button if its Up/Down/Left/Right sectors are independently pressable.
4. Include tiny keys, colored keys, app shortcut keys, numeric keys, source/input keys, teletext keys, playback keys, AC function keys and hidden-looking membrane keys if visibly pressable.
5. Do not create a button for logos, LCD segments, printed legends, IR windows, microphones holes, LEDs or decorative circles unless they are actually pressable.

BUTTON ID RULES
- id must be unique, lowercase ASCII and match ^[a-z0-9_]+$.
- Prefer these canonical IDs whenever the physical function is clear:
  power, off, input, source, mute, vol_up, vol_down, ch_up, ch_down,
  up, down, left, right, ok, home, back, menu, info, guide,
  play, pause, play_pause, stop, prev, next, rewind, forward, record, eject,
  key_0, key_1, key_2, key_3, key_4, key_5, key_6, key_7, key_8, key_9,
  red, green, yellow, blue,
  temp_up, temp_down, fan, swing, mode, timer, sleep, eco, turbo, light,
  app_netflix, app_youtube, app_prime, app_disney, mic.
- If the function is unknown, use a location/appearance ID such as small_top_left, option_1, custom_star. Never invent a protocol or function.
- Two distinct buttons may not share an id even if they show similar symbols.

LABEL RULES
- label should be short enough to render inside the button, ideally <= 12 characters.
- Reproduce visible words when readable.
- Convert obvious icons to human-readable labels: power icon -> Power, triangle -> Play, square -> Stop, house -> Home, microphone -> Mic, +/- -> + or - with context.
- If unreadable, use ?, Key, Opt 1, or a concise positional description; do not hallucinate text.

SHAPE + SEMANTIC
- shape must be exactly "rounded", "rect" or "circle".
- semantic must be exactly one of these strings, or "" when uncertain:
  power, input, mute, volume_up, volume_down, channel_up, channel_down,
  up, down, left, right, ok, home, back, menu, info, guide,
  play, pause, stop, prev, next, record, eject, digit,
  temperature_up, temperature_down, fan, swing, mode, timer, sleep, light, color, app.
- semantic describes behavior; id identifies the physical key. Do not force a semantic when uncertain.

STYLIZED REMOTE IMAGE
The JSON itself is the image description used to generate an SVG. Do not embed an image.
- body = outer remote silhouette.
- decorations[] = non-clickable features only: display window, IR window, LED, logo/brand text, printed section label or separator.
- Allowed decoration types and fields ONLY:
  rect: {"type":"rect","x":N,"y":N,"w":N,"h":N,"rx":N}
  circle: {"type":"circle","cx":N,"cy":N,"r":N}
  line: {"type":"line","x1":N,"y1":N,"x2":N,"y2":N}
  text: {"type":"text","x":N,"y":N,"text":"...","size":N}
- Keep decorations sparse. Button geometry has priority.
- Do not output SVG, HTML, CSS, JavaScript, URLs, file paths, base64 or image data.

GEOMETRY METHOD TO FOLLOW INTERNALLY
A. Estimate the remote bounding rectangle and choose canvas/body dimensions.
B. Divide the body vertically into visual zones (top controls, numeric block, navigation, volume/channel, playback, special keys).
C. For each zone, estimate button centers as percentages of body width/height, then convert to integer x/y/w/h.
D. Align buttons that are visibly aligned; preserve deliberate offsets.
E. Check minimum gaps and eliminate overlap without changing the physical order.

FINAL VALIDATION BEFORE RETURNING JSON
- schema is exactly "ir-pattern-v1".
- width/height/body are numeric and internally consistent.
- buttons[] count matches the independently pressable controls you can see.
- every id is unique and valid.
- every button has id,label,x,y,w,h,shape,semantic.
- every button is fully inside the canvas/body and no buttons overlap.
- numeric keys are in the same order as the photo.
- navigation directions are in the correct physical positions.
- Power/Input/Volume/Channel positions match the photo rather than a generic remote.
- decorations never cover the button geometry materially.
- there are NO IR codes, protocol guesses or carrier-frequency guesses.

Return the JSON object only.`;
  }

  function validatePattern(pattern) {
    if (!pattern || pattern.schema !== 'ir-pattern-v1') throw new Error('schema deve essere ir-pattern-v1');
    if (!Number.isFinite(pattern.width) || !Number.isFinite(pattern.height)) throw new Error('width/height mancanti');
    if (!pattern.body || !Array.isArray(pattern.buttons) || !pattern.buttons.length) throw new Error('body/buttons mancanti');
    const decorationTypes = new Set(['rect','circle','line','text']);
    (pattern.decorations || []).forEach((d, index) => {
      if (!decorationTypes.has(d.type)) throw new Error(`decorations[${index}].type non valido`);
      if (d.type === 'rect' && !['x','y','w','h'].every(k => Number.isFinite(d[k]))) throw new Error(`decorazione rect ${index} incompleta`);
      if (d.type === 'circle' && !['cx','cy','r'].every(k => Number.isFinite(d[k]))) throw new Error(`decorazione circle ${index} incompleta`);
      if (d.type === 'line' && !['x1','y1','x2','y2'].every(k => Number.isFinite(d[k]))) throw new Error(`decorazione line ${index} incompleta`);
      if (d.type === 'text' && (!Number.isFinite(d.x) || !Number.isFinite(d.y) || typeof d.text !== 'string')) throw new Error(`decorazione text ${index} incompleta`);
    });
    const ids = new Set();
    pattern.buttons.forEach(button => {
      if (!/^[a-z0-9_]+$/.test(button.id || '')) throw new Error(`id tasto non valido: ${button.id}`);
      if (ids.has(button.id)) throw new Error(`id duplicato: ${button.id}`); ids.add(button.id);
      ['x','y','w','h'].forEach(k => { if (!Number.isFinite(button[k])) throw new Error(`${button.id}.${k} non valido`); });
      if (button.x < 0 || button.y < 0 || button.x + button.w > pattern.width || button.y + button.h > pattern.height) throw new Error(`tasto fuori area: ${button.id}`);
    });
  }

  function validateRemote(remote) {
    if (!remote || remote.schema !== 'ir-remote-v1') throw new Error('schema deve essere ir-remote-v1');
    validatePattern(remote.pattern);
    if (!remote.mapping || typeof remote.mapping !== 'object') throw new Error('mapping mancante');
  }

  function recognitionPrompts(type) {
    return recognitionSteps(type).map(step => step.prompt);
  }

  function deviceTypeSelect(id) {
    const options = [
      ['unknown','Altro / non so'],['tv','TV'],['dvd','DVD / Blu-ray / VCR'],['audio','Audio / Receiver / Soundbar'],
      ['stb','Decoder / Set-top box / Streaming'],['projector','Proiettore'],['ac','Climatizzatore'],['fan','Ventilatore'],
      ['purifier','Purificatore / Umidificatore'],['heater','Riscaldatore'],['camera','Fotocamera'],['console','Console'],
      ['vacuum','Aspirapolvere / Robot'],['light','Luci / LED'],['monitor','Monitor / Display']
    ];
    return `<select id="${id}">${options.map(([v,l]) => `<option value="${v}">${l}</option>`).join('')}</select>`;
  }

  function exportRemote(remote) {
    const blob = new Blob([JSON.stringify(remote, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${remote.name.replace(/[^a-z0-9_-]+/gi, '_')}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function isAndroidDevice() {
    return /Android/i.test(navigator.userAgent || '');
  }

  async function openSelectedPort(port, backend) {
    await port.open({ baudRate: 115200 });
    state.serial.port = port;
    state.serial.writer = port.writable.getWriter();
    state.serial.connected = true;
    state.serial.backend = backend;
    updateSerialUi();
    readSerialLoop();

    // Uno may reset when DTR is asserted/opened. WebUSB also needs a short
    // settling time after configuring the CDC interface.
    await sleep(650);
    await sendSerialIfConnected('PING');
    await sleep(80);
    await sendSerialIfConnected('DEBUG 1');
    await sleep(80);
    await sendSerialIfConnected('STATUS');
  }

  async function connectNativeSerial() {
    if (!('serial' in navigator)) throw new Error('Web Serial nativo non disponibile.');
    // Keep the picker unfiltered on desktop so Uno clones remain selectable.
    const port = await navigator.serial.requestPort();
    await openSelectedPort(port, 'Web Serial');
  }

  async function connectWebUsbSerial() {
    if (!('usb' in navigator) || !window.IR_WEBUSB_SERIAL) {
      throw new Error('Fallback WebUSB non disponibile.');
    }
    const port = await window.IR_WEBUSB_SERIAL.requestPort();
    await openSelectedPort(port, port.backendLabel || 'WebUSB CDC');
  }

  async function connectSerial() {
    const hasNativeSerial = 'serial' in navigator;
    const hasWebUsbFallback = 'usb' in navigator && !!window.IR_WEBUSB_SERIAL;
    if (!hasNativeSerial && !hasWebUsbFallback) {
      throw new Error('Questo browser non espone ne Web Serial ne WebUSB. Usa Chrome/Edge compatibile.');
    }
    if (state.serial.connected) return;
    if (state.serial.connectPromise) return state.serial.connectPromise;

    const promise = (async () => {
      state.serial.connecting = true;
      updateSerialUi();
      try {
        // Android wired Web Serial is not available on every phone even when
        // navigator.serial exists. Prefer direct WebUSB CDC for Arduino Uno.
        if (isAndroidDevice() && hasWebUsbFallback) {
          try {
            await connectWebUsbSerial();
            return;
          } catch (usbError) {
            console.warn('WebUSB CDC connection failed', usbError);
            if (!hasNativeSerial || usbError?.name === 'NotFoundError') throw usbError;
            showToast('USB Android non riuscito. Provo Web Serial nativo...', 'warn', 3200);
          }
        }

        if (hasNativeSerial) {
          try {
            await connectNativeSerial();
            return;
          } catch (serialError) {
            console.warn('Native Web Serial connection failed', serialError);
            if (!hasWebUsbFallback || serialError?.name === 'NotFoundError') throw serialError;
          }
        }

        await connectWebUsbSerial();
      } catch (error) {
        try { state.serial.writer?.releaseLock(); } catch {}
        try { await state.serial.port?.close(); } catch {}
        state.serial.port = null;
        state.serial.writer = null;
        state.serial.connected = false;
        state.serial.backend = null;
        throw error;
      } finally {
        state.serial.connecting = false;
        state.serial.connectPromise = null;
        updateSerialUi();
      }
    })();
    state.serial.connectPromise = promise;
    return promise;
  }

  async function disconnectSerial() {
    cancelActiveAcquisition({ sendCancel: true });
    const old = state.serial;
    old.connected = false;
    try { await old.reader?.cancel(); } catch {}
    try { old.reader?.releaseLock(); } catch {}
    try { old.writer?.releaseLock(); } catch {}
    try { await old.port?.close(); } catch {}
    state.serial = { port: null, reader: null, writer: null, readBuffer: '', connected: false, connecting: false, connectPromise: null, backend: null, listeners: new Set() };
    updateSerialUi();
  }

  function updateSerialUi() {
    const backendLabel = state.serial.backend ? ` · ${state.serial.backend}` : '';
    serialStatus.textContent = state.serial.connecting ? 'Connessione Arduino...' : state.serial.connected ? `Arduino collegato${backendLabel}` : 'Arduino non collegato';
    serialStatus.classList.toggle('connected', state.serial.connected);
    connectButton.disabled = state.serial.connecting;
    connectButton.textContent = state.serial.connecting ? 'Connessione...' : state.serial.connected ? 'Scollega' : (isAndroidDevice() ? 'Collega Arduino USB' : 'Collega Arduino');
  }

  async function ensureSerial() {
    if (!state.serial.connected) await connectSerial();
  }

  async function sendSerial(line) {
    await ensureSerial();
    const stamp = new Date().toISOString().slice(11, 23);
    console.log(`[${stamp}] SERIAL TX`, line);
    const data = new TextEncoder().encode(`${line}\n`);
    await state.serial.writer.write(data);
  }

  async function readSerialLoop() {
    const port = state.serial.port;
    while (port?.readable && state.serial.connected) {
      const reader = port.readable.getReader(); state.serial.reader = reader;
      try {
        while (true) {
          const { value, done } = await reader.read(); if (done) break;
          state.serial.readBuffer += new TextDecoder().decode(value, { stream: true });
          let index;
          while ((index = state.serial.readBuffer.indexOf('\n')) >= 0) {
            const line = state.serial.readBuffer.slice(0, index).trim(); state.serial.readBuffer = state.serial.readBuffer.slice(index + 1);
            if (line) dispatchSerialLine(line);
          }
        }
      } catch (error) {
        console.error(error);
      } finally {
        try { reader.releaseLock(); } catch {}
        if (state.serial.reader === reader) state.serial.reader = null;
      }
      break;
    }
  }

  function dispatchSerialLine(line) {
    const stamp = new Date().toISOString().slice(11, 23);
    if (line.startsWith('DBG ')) console.log(`[${stamp}] ARDUINO DEBUG`, line);
    else console.log(`[${stamp}] SERIAL RX`, line);
    state.serial.listeners.forEach(fn => fn(line));
  }

  function waitSerial(predicate, timeoutMs = 15000, abortSignal = null) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        state.serial.listeners.delete(handler);
        if (abortSignal) abortSignal.removeEventListener('abort', onAbort);
      };
      const finishResolve = value => {
        if (settled) return;
        settled = true;
        cleanup();
        Promise.resolve(value).then(resolve, reject);
      };
      const finishReject = error => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const handler = line => {
        if (settled) return;
        try {
          const value = predicate(line);
          if (value !== undefined) finishResolve(value);
        } catch (error) {
          finishReject(error);
        }
      };
      const onAbort = () => finishReject(new AcquisitionCancelledError());
      if (abortSignal?.aborted) return onAbort();
      if (abortSignal) abortSignal.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => {
        sendSerialIfConnected('STATUS');
        setTimeout(() => sendSerialIfConnected('CANCEL'), 80);
        finishReject(new Error('Timeout: nessun frame IR valido ricevuto. Controlla le righe ARDUINO DEBUG nella console.'));
      }, timeoutMs);
      state.serial.listeners.add(handler);
    });
  }

  async function learnSignal(message, statusElement = null) {
    await ensureSerial();

    // One acquisition workflow owns exactly one AbortController. Navigating to
    // another page, pressing Cancel/Skip, or starting a new acquisition aborts
    // the old listeners immediately, so delayed CANCELLED/RX lines cannot leak
    // into another screen.
    cancelActiveAcquisition({ sendCancel: true });
    const controller = new AbortController();
    state.acquisitionController = controller;
    const signal = controller.signal;

    try {
      let reference = await captureOneSignal(message, statusElement, signal);

      // A frame with a reliable integrity check is accepted immediately.
      if (reference.decoded?.integrity === true && reference.glitches === 0) return reference;

      let confirmationNumber = 2;
      const maxConfirmations = 6;
      while (!signal.aborted && confirmationNumber <= maxConfirmations) {
        if (statusElement) {
          statusElement.className = 'notice warn';
          statusElement.textContent = `${message}. Premi di nuovo lo stesso tasto per confermare (acquisizione ${confirmationNumber}/${maxConfirmations}).`;
        }

        const candidate = await captureOneSignal(message, statusElement, signal);
        const match = sameSignal(reference, candidate);
        logSignalComparison(reference, candidate, match, confirmationNumber);

        if (match) return mergeLearnedSignals(reference, candidate);

        if (statusElement) {
          statusElement.className = 'notice warn';
          statusElement.textContent = 'Le due acquisizioni non coincidono. Premi ancora lo stesso tasto: il programma continua automaticamente.';
        }
        reference = candidate;
        confirmationNumber++;
        await sleep(250);
      }

      if (signal.aborted) throw new AcquisitionCancelledError();
      throw new Error('Le acquisizioni continuano a non coincidere. Riprova il tasto da una distanza stabile oppure salvalo in modalita RAW avanzata.');
    } finally {
      if (state.acquisitionController === controller) state.acquisitionController = null;
    }
  }

  function logSignalComparison(a, b, match, confirmationNumber) {
    const na = normalizeSignal(a);
    const nb = normalizeSignal(b);
    const ba = signalDecodedBytes(na);
    const bb = signalDecodedBytes(nb);
    const n = Math.min(na?.raw?.length || 0, nb?.raw?.length || 0);
    let bad = 0;
    let maxDelta = 0;
    for (let i = 0; i < n; i++) {
      const x = na.raw[i], y = nb.raw[i];
      const delta = Math.abs(x - y);
      maxDelta = Math.max(maxDelta, delta);
      const tolerance = Math.max(140, Math.max(x, y) * 0.28);
      if (delta > tolerance) bad++;
    }
    console.log('[LEARN COMPARE]', {
      confirmation: confirmationNumber,
      match,
      familyA: na?.decoded?.family || 'RAW',
      familyB: nb?.decoded?.family || 'RAW',
      bytesA: ba ? ba.map(toHex).join(' ') : null,
      bytesB: bb ? bb.map(toHex).join(' ') : null,
      timingsA: na?.raw?.length || 0,
      timingsB: nb?.raw?.length || 0,
      compared: n,
      outOfTolerance: bad,
      maxDeltaUs: maxDelta,
      glitchesA: na?.glitches || 0,
      glitchesB: nb?.glitches || 0
    });
  }

  async function captureOneSignal(message, statusElement, abortSignal = null) {
    if (statusElement) {
      statusElement.className = 'notice';
      statusElement.textContent = `${message}. Arduino in ascolto RAW...`;
    }

    const frame = { id: null, count: 0, glitches: 0, overflow: false, raw: [] };
    let armedSeen = false;
    const pending = waitSerial(line => {
      if (line === 'ARMED RAW' || line === 'ARMED') { armedSeen = true; return undefined; }
      // A delayed CANCELLED from a previous screen is ignored until the current
      // LEARN command has actually been acknowledged by Arduino.
      // Cancellation is controlled locally by AbortController. A CANCELLED line
      // can be a delayed acknowledgement from an earlier screen/timeout, so it
      // must never be allowed to abort the current LEARN transaction.
      if (line === 'CANCELLED') return undefined;
      if (!armedSeen) return undefined;
      if (line.startsWith('RXBEGIN ')) {
        const p = line.split(/\s+/);
        frame.id = Number(p[1]);
        frame.count = Number(p[2]);
        frame.glitches = Number(p[3]);
        frame.overflow = Number(p[4]) === 1;
        frame.raw = new Array(frame.count);
        return undefined;
      }
      if (line.startsWith('RXDATA ')) {
        const p = line.split(/\s+/);
        const id = Number(p[1]);
        if (frame.id == null || id !== frame.id) return undefined;
        const offset = Number(p[2]);
        p.slice(3).forEach((value, index) => { frame.raw[offset + index] = Number(value); });
        return undefined;
      }
      if (line.startsWith('RXEND ')) {
        const id = Number(line.split(/\s+/)[1]);
        if (frame.id == null || id !== frame.id) return undefined;
        if (frame.overflow) return Promise.reject(new Error(`Frame troppo lungo per Arduino Uno (${frame.count} timing memorizzati).`));
        if (frame.raw.length !== frame.count || frame.raw.some(v => !Number.isFinite(v))) return Promise.reject(new Error('Frame RAW incompleto ricevuto via seriale.'));
        const decoded = analyzeRawSignal(frame.raw);
        const signal = { protocol: 'RAW', carrierHz: decoded?.carrierHz || 38000, raw: frame.raw.slice(), glitches: frame.glitches, decoded };
        if (statusElement) {
          statusElement.className = 'notice ok';
          statusElement.textContent = `Catturato: ${signalLabel(signal)}`;
        }
        return signal;
      }
      return undefined;
    }, 30000, abortSignal);

    await sendSerial('LEARN');
    return pending;
  }

  function normalizeSignal(signal) {
    if (!signal) return null;
    if (signal.protocol === 'RAW' && Array.isArray(signal.raw)) {
      if (!signal.decoded) signal.decoded = analyzeRawSignal(signal.raw);
      if (!signal.carrierHz) signal.carrierHz = 38000;
      return signal;
    }
    if (signal.protocol === 'PD32' && signal.timings && Array.isArray(signal.bytes)) {
      const raw = buildPulseDistanceRaw(signal.timings, signal.bytes);
      return { protocol: 'RAW', carrierHz: signal.carrierHz || 38000, raw, decoded: analyzeRawSignal(raw), bytes: signal.bytes.slice(), sourceEncoding: 'PD32' };
    }
    if ((signal.protocol === 'FLIPPER_PARSED' || signal.protocol === 'IRDB_PDF') && window.IR_EXTERNAL_DB) {
      const converted = window.IR_EXTERNAL_DB.toRaw(signal);
      if (converted?.raw?.length) return { ...converted, decoded: analyzeRawSignal(converted.raw), sourceParsed: clone(signal) };
    }
    return signal;
  }

  function signalDecodedBytes(signal) {
    signal = normalizeSignal(signal);
    if (!signal) return null;
    if (Array.isArray(signal.decoded?.bytes)) return signal.decoded.bytes;
    if (Array.isArray(signal.bytes)) return signal.bytes;
    return null;
  }

  function mergeLearnedSignals(a, b) {
    const na = normalizeSignal(a);
    const nb = normalizeSignal(b);
    if (!na?.raw?.length) return nb;
    if (!nb?.raw?.length) return na;

    // Never average captures that differ structurally or in decoded payload.
    // Some protocols intentionally toggle one bit at every press (RC5/RC6 and
    // relatives). Averaging a 0-space with a 1-space would create a waveform
    // that belongs to neither command. In that case keep one clean capture.
    if (na.raw.length !== nb.raw.length) return clone((nb.glitches || 0) <= (na.glitches || 0) ? nb : na);
    const ba = signalDecodedBytes(na);
    const bb = signalDecodedBytes(nb);
    if (ba && bb && (ba.length !== bb.length || ba.some((v, i) => v !== bb[i]))) {
      return clone((nb.glitches || 0) <= (na.glitches || 0) ? nb : na);
    }

    let hasLargeDifference = false;
    for (let i = 0; i < na.raw.length; i++) {
      const tolerance = Math.max(140, Math.max(na.raw[i], nb.raw[i]) * 0.28);
      if (Math.abs(na.raw[i] - nb.raw[i]) > tolerance) { hasLargeDifference = true; break; }
    }
    if (hasLargeDifference) return clone((nb.glitches || 0) <= (na.glitches || 0) ? nb : na);

    const raw = na.raw.map((value, i) => Math.round((value + nb.raw[i]) / 2));
    return { protocol: 'RAW', carrierHz: na.carrierHz || nb.carrierHz || 38000, raw, glitches: Math.min(na.glitches || 0, nb.glitches || 0), decoded: analyzeRawSignal(raw) };
  }

  function sameSignal(a, b) {
    a = normalizeSignal(a); b = normalizeSignal(b);
    if (!a || !b || !Array.isArray(a.raw) || !Array.isArray(b.raw)) return false;

    const ba = signalDecodedBytes(a);
    const bb = signalDecodedBytes(b);
    if (ba && bb && a.decoded?.family === b.decoded?.family && ba.length === bb.length && ba.every((v, i) => v === bb[i])) return true;

    if (Math.abs(a.raw.length - b.raw.length) > 2) return false;
    const n = Math.min(a.raw.length, b.raw.length);
    if (n < 3) return false;
    let bad = 0;
    for (let i = 0; i < n; i++) {
      const x = a.raw[i], y = b.raw[i];
      const tolerance = Math.max(140, Math.max(x, y) * 0.28);
      if (Math.abs(x - y) > tolerance) bad++;
    }
    return bad <= Math.max(2, Math.floor(n * 0.08));
  }

  function signalLabel(signal) {
    if (!signal) return 'nessun segnale';
    if (signal.protocol === 'FLIPPER_PARSED') {
      const p = signal.parsed || {};
      const address = (p.address || []).map(toHex).join(' ');
      const command = (p.command || []).map(toHex).join(' ');
      return `${p.protocol || 'parsed'} · A:${address || '-'} · C:${command || '-'}`;
    }
    if (signal.protocol === 'IRDB_PDF') {
      const p = signal.parsed || {};
      return `${p.protocol || 'irdb'} · D:${p.device} S:${p.subdevice} F:${p.function}`;
    }
    signal = normalizeSignal(signal);
    if (!signal) return 'nessun segnale';
    const d = signal.decoded || {};
    const bytes = signalDecodedBytes(signal);
    if (bytes?.length) return `${d.family || 'RAW'} · ${bytes.map(toHex).join(' ')} · ${signal.raw.length} timing`;
    return `${d.family || signal.protocol || 'RAW'} · ${signal.raw?.length || 0} timing · ${Math.round(signal.carrierHz || 38000)} Hz`;
  }

  function median(values) {
    if (!values.length) return 0;
    const a = values.slice().sort((x, y) => x - y);
    const m = a.length >> 1;
    return a.length & 1 ? a[m] : (a[m - 1] + a[m]) / 2;
  }

  function clusterTwo(values) {
    if (values.length < 4) return null;
    let c0 = Math.min(...values), c1 = Math.max(...values);
    if (c1 < c0 * 1.35) return null;
    for (let k = 0; k < 8; k++) {
      const g0 = [], g1 = [];
      values.forEach(v => (Math.abs(v - c0) <= Math.abs(v - c1) ? g0 : g1).push(v));
      if (!g0.length || !g1.length) return null;
      c0 = g0.reduce((a, b) => a + b, 0) / g0.length;
      c1 = g1.reduce((a, b) => a + b, 0) / g1.length;
    }
    if (c0 > c1) [c0, c1] = [c1, c0];
    return { zero: c0, one: c1, threshold: (c0 + c1) / 2 };
  }

  function analyzeRawSignal(raw) {
    if (!Array.isArray(raw) || raw.length < 3) return { family: 'RAW', integrity: false };

    // Generic pulse-distance decoder. It does not care whether the protocol is
    // NEC, Samsung, LG, JVC, Panasonic/Kaseikyo, or another family using the
    // same mark + binary-space principle.
    if ((raw.length - 3) % 2 === 0) {
      const bits = (raw.length - 3) / 2;
      if (bits >= 8 && bits <= 256) {
        const marks = [], spaces = [];
        for (let i = 0; i < bits; i++) {
          marks.push(raw[2 + i * 2]);
          spaces.push(raw[3 + i * 2]);
        }
        const markMed = median(marks);
        const markBad = marks.filter(v => Math.abs(v - markMed) > Math.max(180, markMed * 0.45)).length;
        const clusters = clusterTwo(spaces);
        if (clusters && markBad <= Math.max(2, bits * 0.08)) {
          const bitValues = spaces.map(v => v > clusters.threshold ? 1 : 0);
          const bytes = [];
          if (bits % 8 === 0) {
            for (let i = 0; i < bits; i += 8) {
              let value = 0;
              for (let b = 0; b < 8; b++) value |= bitValues[i + b] << b;
              bytes.push(value);
            }
          }
          let integrity = false;
          if (bytes.length >= 4) {
            const cmdInv = ((bytes[bytes.length - 2] ^ bytes[bytes.length - 1]) & 0xFF) === 0xFF;
            const addrInv = ((bytes[0] ^ bytes[1]) & 0xFF) === 0xFF;
            integrity = cmdInv || addrInv;
          }
          return {
            family: `PULSE_DISTANCE_${bits}`,
            bits,
            bytes,
            integrity,
            headerMark: raw[0], headerSpace: raw[1], bitMark: Math.round(markMed),
            zeroSpace: Math.round(clusters.zero), oneSpace: Math.round(clusters.one)
          };
        }
      }
    }

    // Sony SIRC-like pulse-width frames: long leader mark, fixed short spaces,
    // and data encoded mainly in mark width. This recognizes the family without
    // making the Arduino depend on Sony-specific code.
    if (raw.length >= 20 && raw[0] > 1800 && raw[0] < 3000) {
      const spaces = raw.filter((_, i) => i > 0 && (i & 1)).slice(0, -1);
      const marks = raw.filter((_, i) => i >= 2 && !(i & 1));
      const sMed = median(spaces);
      if (sMed > 350 && sMed < 900 && marks.some(v => v > 900)) {
        return { family: 'SONY_SIRC_LIKE', bits: Math.floor((raw.length - 2) / 2), bytes: [], integrity: false };
      }
    }

    // Manchester/biphase families (RC5/RC6 and relatives) are intentionally
    // kept RAW for replay; family recognition can later be refined in the web
    // decoder without touching the Uno firmware.
    const body = raw.slice(0, Math.min(raw.length, 80));
    const short = median(body.filter(v => v < median(body) * 1.45));
    if (short >= 300 && short <= 1200) {
      const near1 = body.filter(v => Math.abs(v - short) < short * 0.35).length;
      const near2 = body.filter(v => Math.abs(v - short * 2) < short * 0.45).length;
      if (near1 + near2 > body.length * 0.7) return { family: 'BIPHASE_RAW', bits: null, bytes: [], integrity: false };
    }

    return { family: 'RAW', integrity: false };
  }

  async function sendSignal(signal) {
    const original = signal;
    signal = normalizeSignal(signal);
    if (!signal || signal.protocol !== 'RAW' || !Array.isArray(signal.raw) || !signal.raw.length) {
      const proto = original?.parsed?.protocol || original?.protocol || 'sconosciuto';
      throw new Error(`Protocollo ${proto} presente nel database ma non ancora convertibile in RAW da questa versione. Puoi apprendere questo singolo tasto dal telecomando fisico.`);
    }
    if (signal.raw.length > 520) throw new Error(`Segnale troppo lungo per Arduino Uno: ${signal.raw.length} timing (max 520).`);

    const carrier = Math.round(signal.carrierHz || 38000);
    let ack = waitSerial(s => s.startsWith('TXRAW READY ') ? true : s.startsWith('ERR ') ? Promise.reject(new Error(s)) : undefined, 3000);
    await sendSerial(`TXRAW_BEGIN ${carrier} ${signal.raw.length}`);
    await ack;

    const chunk = 12;
    for (let offset = 0; offset < signal.raw.length; offset += chunk) {
      const values = signal.raw.slice(offset, offset + chunk).map(v => Math.max(1, Math.min(65535, Math.round(v))));
      const expectedLoaded = offset + values.length;
      ack = waitSerial(s => s === `TXRAW LOADED ${expectedLoaded}` ? true : s.startsWith('ERR ') ? Promise.reject(new Error(s)) : undefined, 3000);
      await sendSerial(`TXRAW_DATA ${offset} ${values.join(' ')}`);
      await ack;
    }

    ack = waitSerial(s => s === 'TXOK' ? true : s.startsWith('ERR ') ? Promise.reject(new Error(s)) : undefined, 6000);
    await sendSerial('TXRAW_GO');
    await ack;
  }

  function appendLog(id, line) {
    const el = document.getElementById(id); if (!el) return;
    el.textContent += `\n${new Date().toLocaleTimeString()}  ${line}`; el.scrollTop = el.scrollHeight;
  }

  function toHex(value) { return Number(value).toString(16).toUpperCase().padStart(2, '0'); }
  function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

  connectButton.onclick = async () => {
    try { if (state.serial.connected) await disconnectSerial(); else await connectSerial(); }
    catch (error) {
      console.error('Serial connection error', error);
      const androidHint = isAndroidDevice() ? ' Verifica OTG, cavo dati e autorizzazione USB. Se il telefono non espone la seriale nativa, la v13 usa WebUSB per CDC, CH340, FT232R e CP210x.' : '';
      serialStatus.textContent = `Errore seriale: ${error.message}`;
      serialStatus.title = `${error.message}.${androidHint}`;
      serialStatus.classList.remove('connected');
      showToast(`Connessione Arduino fallita. ${error.message}${androidHint}`, 'warn', 7000);
    }
  };

  window.addEventListener('beforeunload', () => { if (state.serial.connected) disconnectSerial(); });
  initPwa();
  updateSerialUi();
  renderMain();
})();
