(() => {
  'use strict';

  const USB_SERIAL_FILTERS = [
    { vendorId: 0x2341 }, // Arduino SA
    { vendorId: 0x2A03 }, // Arduino LLC
    { classCode: 0x02 },  // Generic CDC-ACM control interface
    { vendorId: 0x1A86, productId: 0x7523 }, // WCH CH340 / CH341
    { vendorId: 0x1A86, productId: 0x5523 }, // WCH CH341 variant
    { vendorId: 0x0403, productId: 0x6001 }, // FTDI FT232R (official classic Nano)
    { vendorId: 0x10C4, productId: 0xEA60 }  // Silicon Labs CP210x
  ];

  function makeLineCoding(baudRate, dataBits = 8, stopBits = 1, parity = 'none') {
    const buf = new ArrayBuffer(7);
    const dv = new DataView(buf);
    dv.setUint32(0, baudRate >>> 0, true);
    dv.setUint8(4, stopBits === 2 ? 2 : 0);
    dv.setUint8(5, parity === 'odd' ? 1 : parity === 'even' ? 2 : 0);
    dv.setUint8(6, dataBits === 7 ? 7 : 8);
    return new Uint8Array(buf);
  }

  class WebUsbCdcPort {
    constructor(device) {
      this.device = device;
      this.readable = null;
      this.writable = null;
      this.controlInterfaceNumber = null;
      this.dataInterfaceNumber = null;
      this.inEndpoint = null;
      this.outEndpoint = null;
      this.inPacketSize = 64;
      this._closed = true;
      this._readerController = null;
      this._readPumpPromise = null;
    }

    getInfo() {
      return {
        usbVendorId: this.device.vendorId,
        usbProductId: this.device.productId
      };
    }

    _findInterfaces() {
      const cfg = this.device.configuration;
      if (!cfg) throw new Error('Configurazione USB non disponibile.');

      let control = null;
      let data = null;

      for (const iface of cfg.interfaces) {
        for (const alt of iface.alternates) {
          if (!control && alt.interfaceClass === 0x02 && alt.interfaceSubclass === 0x02) {
            control = { iface, alt };
          }
          if (!data && alt.interfaceClass === 0x0A) {
            data = { iface, alt };
          }
        }
      }

      if (!control || !data) {
        const vid = this.device.vendorId.toString(16).padStart(4, '0');
        const pid = this.device.productId.toString(16).padStart(4, '0');
        throw new Error(`Il dispositivo USB ${vid}:${pid} non espone un'interfaccia CDC-ACM compatibile.`);
      }

      const inEp = data.alt.endpoints.find(e => e.type === 'bulk' && e.direction === 'in');
      const outEp = data.alt.endpoints.find(e => e.type === 'bulk' && e.direction === 'out');
      if (!inEp || !outEp) throw new Error('Endpoint USB CDC bulk IN/OUT non trovati.');

      this.controlInterfaceNumber = control.iface.interfaceNumber;
      this.dataInterfaceNumber = data.iface.interfaceNumber;
      this.controlAlternateSetting = control.alt.alternateSetting;
      this.dataAlternateSetting = data.alt.alternateSetting;
      this.inEndpoint = inEp.endpointNumber;
      this.outEndpoint = outEp.endpointNumber;
      this.inPacketSize = Math.max(64, inEp.packetSize || 64);
    }

    async open(options = {}) {
      if (!this._closed) return;
      const baudRate = Number(options.baudRate || 115200);

      await this.device.open();
      if (!this.device.configuration) {
        const configValue = this.device.configurations?.[0]?.configurationValue || 1;
        await this.device.selectConfiguration(configValue);
      }

      this._findInterfaces();
      await this.device.claimInterface(this.controlInterfaceNumber);
      if (this.controlAlternateSetting) {
        await this.device.selectAlternateInterface(this.controlInterfaceNumber, this.controlAlternateSetting);
      }
      if (this.dataInterfaceNumber !== this.controlInterfaceNumber) {
        await this.device.claimInterface(this.dataInterfaceNumber);
      }
      if (this.dataAlternateSetting) {
        await this.device.selectAlternateInterface(this.dataInterfaceNumber, this.dataAlternateSetting);
      }

      const lineCoding = makeLineCoding(baudRate, options.dataBits || 8, options.stopBits || 1, options.parity || 'none');
      const lineResult = await this.device.controlTransferOut({
        requestType: 'class',
        recipient: 'interface',
        request: 0x20, // SET_LINE_CODING
        value: 0,
        index: this.controlInterfaceNumber
      }, lineCoding);
      if (lineResult.status !== 'ok') throw new Error(`SET_LINE_CODING USB fallito: ${lineResult.status}`);

      // Assert DTR + RTS. This is important for many Arduino CDC implementations.
      const ctrlResult = await this.device.controlTransferOut({
        requestType: 'class',
        recipient: 'interface',
        request: 0x22, // SET_CONTROL_LINE_STATE
        value: 0x03,
        index: this.controlInterfaceNumber
      });
      if (ctrlResult.status !== 'ok') throw new Error(`SET_CONTROL_LINE_STATE USB fallito: ${ctrlResult.status}`);

      this._closed = false;
      this.readable = new ReadableStream({
        start: controller => {
          this._readerController = controller;
          this._readPumpPromise = this._readPump();
        },
        cancel: () => {
          this._closed = true;
        }
      });

      this.writable = new WritableStream({
        write: async chunk => {
          if (this._closed) throw new Error('Porta USB chiusa.');
          const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
          let offset = 0;
          while (offset < bytes.byteLength) {
            const part = bytes.subarray(offset, Math.min(bytes.byteLength, offset + 64));
            const result = await this.device.transferOut(this.outEndpoint, part);
            if (result.status !== 'ok') throw new Error(`Scrittura USB fallita: ${result.status}`);
            offset += result.bytesWritten ?? part.byteLength;
          }
        },
        abort: () => {
          this._closed = true;
        }
      });
    }

    async _readPump() {
      try {
        while (!this._closed && this.device.opened) {
          const result = await this.device.transferIn(this.inEndpoint, this.inPacketSize);
          if (this._closed) break;
          if (result.status === 'stall') {
            try { await this.device.clearHalt('in', this.inEndpoint); } catch {}
            continue;
          }
          if (result.status !== 'ok') throw new Error(`Lettura USB fallita: ${result.status}`);
          if (result.data && result.data.byteLength) {
            const bytes = new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength);
            this._readerController?.enqueue(new Uint8Array(bytes));
          }
        }
      } catch (error) {
        if (!this._closed) {
          try { this._readerController?.error(error); } catch {}
        }
      } finally {
        if (!this._closed) {
          try { this._readerController?.close(); } catch {}
        }
      }
    }

    async close() {
      if (this._closed && !this.device.opened) return;
      this._closed = true;

      if (this.device.opened && this.controlInterfaceNumber !== null) {
        try {
          await this.device.controlTransferOut({
            requestType: 'class', recipient: 'interface', request: 0x22,
            value: 0, index: this.controlInterfaceNumber
          });
        } catch {}
      }

      if (this.device.opened) {
        try {
          if (this.dataInterfaceNumber !== null) await this.device.releaseInterface(this.dataInterfaceNumber);
        } catch {}
        try {
          if (this.controlInterfaceNumber !== null && this.controlInterfaceNumber !== this.dataInterfaceNumber) {
            await this.device.releaseInterface(this.controlInterfaceNumber);
          }
        } catch {}
        try { await this.device.close(); } catch {}
      }
      this.readable = null;
      this.writable = null;
    }
  }


  // WebUSB USB-UART bridges used by classic Nano boards. These chips expose
  // vendor-specific interfaces, not CDC-ACM interfaces. A VID/PID filter alone
  // is insufficient: each needs its own UART setup requests.
  const USB_BRIDGES = {
    '1a86:7523': 'CH340',
    '1a86:5523': 'CH340',
    '0403:6001': 'FT232R',
    '10c4:ea60': 'CP210x'
  };

  class WebUsbBridgePort {
    constructor(device, chip) {
      this.device = device;
      this.chip = chip;
      this.backendLabel = `WebUSB ${chip}`;
      this.readable = null;
      this.writable = null;
      this.interfaceNumber = null;
      this.alternateSetting = 0;
      this.inEndpoint = null;
      this.outEndpoint = null;
      this.inPacketSize = 64;
      this._closed = true;
    }

    getInfo() {
      return { usbVendorId: this.device.vendorId, usbProductId: this.device.productId };
    }

    async _vendorOut(request, value, index = 0, data) {
      const result = await this.device.controlTransferOut({
        requestType: 'vendor', recipient: 'device', request, value, index
      }, data);
      if (result.status !== 'ok') {
        throw new Error(`${this.chip}: comando USB 0x${request.toString(16)} fallito (${result.status})`);
      }
    }

    _findInterface() {
      for (const iface of this.device.configuration?.interfaces || []) {
        for (const alt of iface.alternates) {
          if (alt.interfaceClass !== 0xFF) continue;
          const inEp = alt.endpoints.find(e => e.type === 'bulk' && e.direction === 'in');
          const outEp = alt.endpoints.find(e => e.type === 'bulk' && e.direction === 'out');
          if (!inEp || !outEp) continue;
          this.interfaceNumber = iface.interfaceNumber;
          this.alternateSetting = alt.alternateSetting;
          this.inEndpoint = inEp.endpointNumber;
          this.outEndpoint = outEp.endpointNumber;
          this.inPacketSize = Math.max(64, inEp.packetSize || 64);
          return;
        }
      }
      throw new Error(`${this.chip}: interfaccia USB seriale bulk non trovata.`);
    }

    async _initialize(baudRate) {
      if (this.chip === 'CH340') {
        // WCH CH340/CH341 setup, using the baud divisor formula also used by
        // esptool-js. Applies to the classic CH340 USB-UART bridge, not CH343.
        await this._vendorOut(0xA1, 0, 0);
        let factor = Math.floor(1532620800 / baudRate);
        let divisor = 3;
        while (factor > 0xFFF0 && divisor > 0) {
          factor >>= 3;
          divisor--;
        }
        if (factor > 0xFFF0) throw new Error('Baud rate CH340 non supportato.');
        factor = 0x10000 - factor;
        await this._vendorOut(0x9A, 0x1312, (factor & 0xFF00) | divisor);
        await this._vendorOut(0x9A, 0x0F2C, factor & 0xFF);
        // Assert both DTR and RTS for normal serial operation. Lines are active low.
        await this._vendorOut(0xA4, (~0x60) & 0xFFFF);
        return;
      }
      if (this.chip === 'FT232R') {
        if (baudRate !== 115200) throw new Error('FT232R: questa versione richiede 115200 baud.');
        // FTDI SIO: reset, 115200 baud (3 MHz / 26), 8N1, no flow, DTR+RTS.
        await this._vendorOut(0x00, 0, 0);
        await this._vendorOut(0x03, 0x001A, 0);
        await this._vendorOut(0x04, 0x0008, 0);
        await this._vendorOut(0x02, 0, 0);
        await this._vendorOut(0x01, 0x0303, 0);
        return;
      }
      if (this.chip === 'CP210x') {
        await this._vendorOut(0x00, 0x0001, this.interfaceNumber); // UART enable
        const baudBytes = new Uint8Array(4);
        new DataView(baudBytes.buffer).setUint32(0, baudRate, true);
        await this._vendorOut(0x1E, 0, this.interfaceNumber, baudBytes);
        await this._vendorOut(0x03, 0x0800, this.interfaceNumber); // 8N1
        await this._vendorOut(0x07, 0x0303, this.interfaceNumber); // DTR/RTS
        return;
      }
      throw new Error(`Convertitore USB non gestito: ${this.chip}.`);
    }

    async open(options = {}) {
      if (!this._closed) return;
      const baudRate = Number(options.baudRate || 115200);
      try {
        await this.device.open();
        if (!this.device.configuration) {
          const configurationValue = this.device.configurations?.[0]?.configurationValue || 1;
          await this.device.selectConfiguration(configurationValue);
        }
        this._findInterface();
        await this.device.claimInterface(this.interfaceNumber);
        if (this.alternateSetting) {
          await this.device.selectAlternateInterface(this.interfaceNumber, this.alternateSetting);
        }
        await this._initialize(baudRate);
        this._closed = false;
        this.readable = new ReadableStream({
          pull: async controller => {
            while (!this._closed && this.device.opened) {
              const result = await this.device.transferIn(this.inEndpoint, this.inPacketSize);
              if (this._closed) return;
              if (result.status === 'stall') {
                await this.device.clearHalt('in', this.inEndpoint);
                continue;
              }
              if (result.status !== 'ok') throw new Error(`${this.chip}: lettura USB fallita (${result.status})`);
              if (!result.data?.byteLength) continue;
              let bytes = new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength);
              if (this.chip === 'FT232R') {
                // FTDI prepends two modem-status bytes to EACH USB packet.
                const clean = [];
                for (let pos = 0; pos < bytes.length; pos += this.inPacketSize) {
                  const packet = bytes.subarray(pos, Math.min(pos + this.inPacketSize, bytes.length));
                  if (packet.length > 2) clean.push(packet.subarray(2));
                }
                if (!clean.length) continue;
                const merged = new Uint8Array(clean.reduce((n, part) => n + part.length, 0));
                let offset = 0;
                for (const part of clean) { merged.set(part, offset); offset += part.length; }
                bytes = merged;
              }
              controller.enqueue(new Uint8Array(bytes));
              return;
            }
          },
          cancel: () => { this._closed = true; }
        });
        this.writable = new WritableStream({
          write: async chunk => {
            if (this._closed) throw new Error('Porta WebUSB chiusa.');
            const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
            for (let i = 0; i < bytes.byteLength; i += 64) {
              const part = bytes.subarray(i, i + 64);
              const result = await this.device.transferOut(this.outEndpoint, part);
              if (result.status !== 'ok') throw new Error(`${this.chip}: scrittura USB fallita (${result.status})`);
            }
          }
        });
      } catch (error) {
        await this.close();
        throw error;
      }
    }

    async close() {
      this._closed = true;
      this.readable = null;
      this.writable = null;
      if (this.device.opened) {
        try {
          if (this.chip === 'CH340') await this._vendorOut(0xA4, 0xFFFF);
          if (this.chip === 'CP210x') await this._vendorOut(0x00, 0, this.interfaceNumber || 0);
          if (this.chip === 'FT232R') await this._vendorOut(0x01, 0x0300);
        } catch {}
        try { if (this.interfaceNumber !== null) await this.device.releaseInterface(this.interfaceNumber); } catch {}
        try { await this.device.close(); } catch {}
      }
    }
  }

  async function requestUsbSerialPort() {
    if (!('usb' in navigator)) throw new Error('WebUSB non disponibile in questo browser.');
    const device = await navigator.usb.requestDevice({ filters: USB_SERIAL_FILTERS });
    const key = `${device.vendorId.toString(16).padStart(4, '0')}:${device.productId.toString(16).padStart(4, '0')}`;
    const bridge = USB_BRIDGES[key];
    return bridge ? new WebUsbBridgePort(device, bridge) : new WebUsbCdcPort(device);
  }

  window.IR_WEBUSB_SERIAL = {
    requestPort: requestUsbSerialPort,
    WebUsbCdcPort,
    WebUsbBridgePort,
    filters: USB_SERIAL_FILTERS
  };
})();
