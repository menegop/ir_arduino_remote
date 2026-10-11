(() => {
  'use strict';

  const ARDUINO_FILTERS = [
    { vendorId: 0x2341 }, // Arduino SA
    { vendorId: 0x2A03 }, // Arduino LLC
    { classCode: 0x02 }   // Generic CDC-ACM control interface
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

  async function requestCdcPort() {
    if (!('usb' in navigator)) throw new Error('WebUSB non disponibile in questo browser.');
    const device = await navigator.usb.requestDevice({ filters: ARDUINO_FILTERS });
    return new WebUsbCdcPort(device);
  }

  window.IR_WEBUSB_SERIAL = {
    requestPort: requestCdcPort,
    WebUsbCdcPort,
    filters: ARDUINO_FILTERS
  };
})();
