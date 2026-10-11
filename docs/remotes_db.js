window.REMOTE_DB = [
  {
    id: "lg-nec-family-bench",
    deviceType: "unknown",
    brand: "LG",
    model: "NEC family (model to identify)",
    patternId: "tv",
    carrierHz: 38000,
    timings: { headerMark: 9100, headerSpace: 4400, bitMark: 650, zeroSpace: 470, oneSpace: 1580 },
    powerButtonId: null,
    signals: {
      key_14: [0x00, 0xFF, 0x14, 0xEB],
      key_08: [0x04, 0xFB, 0x08, 0xF7]
    },
    recognitionLevel: "family",
    notes: "Fingerprint learned from the current LG bench session. Brand/family only; exact model is not identified yet."
  },
  {
    id: "lg-cov33662801-dvd-sample",
    deviceType: "dvd",
    brand: "LG",
    model: "COV33662801 / DVD family",
    patternId: "media",
    carrierHz: 38000,
    timings: { headerMark: 4636, headerSpace: 4368, bitMark: 600, zeroSpace: 524, oneSpace: 1636 },
    powerButtonId: "power",
    signals: {
      power: [0x2D, 0x2D, 0x30, 0xCF],
      key_3b: [0x2D, 0x2D, 0x3B, 0xC4],
      key_3c: [0x2D, 0x2D, 0x3C, 0xC3],
      key_3d: [0x2D, 0x2D, 0x3D, 0xC2],
      key_3e: [0x2D, 0x2D, 0x3E, 0xC1],
      key_3f: [0x2D, 0x2D, 0x3F, 0xC0]
    },
    notes: "Power is known from the bench tests. The semantic meaning of 3B-3F is intentionally left generic."
  },
  {
    id: "listo-0e-capture-sample",
    deviceType: "unknown",
    brand: "Listo",
    model: "Captured 0E family",
    patternId: "compact",
    carrierHz: 38000,
    timings: { headerMark: 4580, headerSpace: 4408, bitMark: 640, zeroSpace: 480, oneSpace: 1590 },
    powerButtonId: null,
    signals: {
      key_0c: [0x0E, 0x0E, 0x0C, 0xF3],
      key_01: [0x0E, 0x0E, 0x01, 0xFE],
      key_02: [0x0E, 0x0E, 0x02, 0xFD],
      key_03: [0x0E, 0x0E, 0x03, 0xFC],
      key_04: [0x0E, 0x0E, 0x04, 0xFB],
      key_05: [0x0E, 0x0E, 0x05, 0xFA],
      key_06: [0x0E, 0x0E, 0x06, 0xF9],
      key_07: [0x0E, 0x0E, 0x07, 0xF8],
      key_08: [0x0E, 0x0E, 0x08, 0xF7],
      key_09: [0x0E, 0x0E, 0x09, 0xF6],
      key_b3: [0x0E, 0x0E, 0xB3, 0x4C],
      key_00: [0x0E, 0x0E, 0x00, 0xFF],
      key_bb: [0x0E, 0x0E, 0xBB, 0x44]
    },
    notes: "Technical fingerprint captured on the bench. Button meanings were not assigned, so they remain generic."
  }
];
