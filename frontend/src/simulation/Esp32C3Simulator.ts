/**
 * Esp32C3Simulator — Browser-side ESP32-C3 emulator.
 *
 * Wraps RiscVCore (RV32IMC) with:
 * - ESP32-C3 memory map: Flash IROM/DROM @ 0x42000000/0x3C000000,
 *   DRAM @ 0x3FC80000, IRAM @ 0x4037C000
 * - UART0 MMIO @ 0x60000000 (serial I/O)
 * - GPIO MMIO @ 0x60004000 (pin output via OUT/W1TS/W1TC registers)
 * - 160 MHz clock, requestAnimationFrame execution loop
 * - Same public interface as AVRSimulator / RiscVSimulator
 */

import { RiscVCore } from './RiscVCore';
import type { PinManager } from './PinManager';
import { hexToUint8Array } from '../utils/hexParser';
import { parseMergedFlashImage } from '../utils/esp32ImageParser';

// ── ESP32-C3 Memory Map ──────────────────────────────────────────────────────
const IROM_BASE = 0x42000000;   // Flash instruction region (mapped via MMU)
const DROM_BASE = 0x3C000000;   // Flash data region (read-only alias of same flash)
const DRAM_BASE = 0x3FC80000;   // Data RAM
const IRAM_BASE = 0x4037C000;   // Instruction RAM

const IROM_SIZE = 4 * 1024 * 1024;   // 4 MB flash buffer
const DRAM_SIZE = 384 * 1024;         // 384 KB DRAM
const IRAM_SIZE = 384 * 1024;         // 384 KB IRAM

// ── UART0 @ 0x60000000 ──────────────────────────────────────────────────────
const UART0_BASE   = 0x60000000;
const UART0_SIZE   = 0x400;
const UART0_FIFO   = 0x00;   // write TX byte / read RX byte
const UART0_STATUS = 0x1C;   // TXFIFO_CNT in bits [19:16] (0 = empty = ready)

// ── GPIO @ 0x60004000 ───────────────────────────────────────────────────────
const GPIO_BASE   = 0x60004000;
const GPIO_SIZE   = 0x200;
const GPIO_OUT    = 0x04;   // GPIO_OUT_REG   — output value (read/write)
const GPIO_W1TS   = 0x08;   // GPIO_OUT_W1TS  — set bits (write-only)
const GPIO_W1TC   = 0x0C;   // GPIO_OUT_W1TC  — clear bits (write-only)
const GPIO_IN     = 0x3C;   // GPIO_IN_REG    — input value (read-only)
const GPIO_ENABLE = 0x20;   // GPIO_ENABLE_REG

// ── Clock ───────────────────────────────────────────────────────────────────
const CPU_HZ = 160_000_000;
const CYCLES_PER_FRAME = Math.round(CPU_HZ / 60);

export class Esp32C3Simulator {
  private core: RiscVCore;
  private flash: Uint8Array;
  private dram: Uint8Array;
  private iram: Uint8Array;
  private running = false;
  private animFrameId = 0;
  private rxFifo: number[] = [];
  private gpioOut = 0;
  private gpioIn  = 0;

  public pinManager: PinManager;
  public onSerialData: ((ch: string) => void) | null = null;
  public onBaudRateChange: ((baud: number) => void) | null = null;
  public onPinChangeWithTime: ((pin: number, state: boolean, timeMs: number) => void) | null = null;

  constructor(pinManager: PinManager) {
    this.pinManager = pinManager;

    // Flash is the primary (fast-path) memory region
    this.flash = new Uint8Array(IROM_SIZE);
    this.dram  = new Uint8Array(DRAM_SIZE);
    this.iram  = new Uint8Array(IRAM_SIZE);

    this.core = new RiscVCore(this.flash, IROM_BASE);

    // DROM — read-only alias of the same flash buffer at a different virtual address
    const flash = this.flash;
    this.core.addMmio(DROM_BASE, IROM_SIZE,
      (addr) => flash[addr - DROM_BASE] ?? 0,
      () => {},
    );

    // DRAM (384 KB)
    const dram = this.dram;
    this.core.addMmio(DRAM_BASE, DRAM_SIZE,
      (addr) => dram[addr - DRAM_BASE],
      (addr, val) => { dram[addr - DRAM_BASE] = val; },
    );

    // IRAM (384 KB)
    const iram = this.iram;
    this.core.addMmio(IRAM_BASE, IRAM_SIZE,
      (addr) => iram[addr - IRAM_BASE],
      (addr, val) => { iram[addr - IRAM_BASE] = val; },
    );

    this._registerUart0();
    this._registerGpio();

    this.core.reset(IROM_BASE);
    // Initialize SP to top of DRAM — MUST be after reset() which zeroes all regs
    this.core.regs[2] = (DRAM_BASE + DRAM_SIZE - 16) | 0;
  }

  // ── MMIO registration ──────────────────────────────────────────────────────

  private _registerUart0(): void {
    this.core.addMmio(UART0_BASE, UART0_SIZE,
      (addr) => {
        const off = addr - UART0_BASE;
        if (off === UART0_FIFO)   return this.rxFifo.length > 0 ? (this.rxFifo.shift()! & 0xFF) : 0;
        if (off === UART0_STATUS) return 0;  // TXFIFO always empty = ready to accept data
        return 0;
      },
      (addr, val) => {
        if (addr - UART0_BASE === UART0_FIFO) {
          this.onSerialData?.(String.fromCharCode(val & 0xFF));
        }
      },
    );
  }

  private _registerGpio(): void {
    this.core.addMmio(GPIO_BASE, GPIO_SIZE,
      (addr) => {
        const off = (addr - GPIO_BASE) & ~3;  // word-align for register lookup
        const byteIdx = (addr - GPIO_BASE) & 3;
        if (off === GPIO_OUT)    return (this.gpioOut >> (byteIdx * 8)) & 0xFF;
        if (off === GPIO_IN)     return (this.gpioIn  >> (byteIdx * 8)) & 0xFF;
        if (off === GPIO_ENABLE) return 0xFF;
        return 0;
      },
      (addr, val) => {
        const off      = (addr - GPIO_BASE) & ~3;
        const byteIdx  = (addr - GPIO_BASE) & 3;
        const shift    = byteIdx * 8;
        const byteMask = 0xFF << shift;
        const prev     = this.gpioOut;

        if (off === GPIO_W1TS) {
          // Set bits — each byte write sets corresponding bits
          this.gpioOut |= (val & 0xFF) << shift;
        } else if (off === GPIO_W1TC) {
          // Clear bits
          this.gpioOut &= ~((val & 0xFF) << shift);
        } else if (off === GPIO_OUT) {
          // Direct write — reconstruct 32-bit value byte by byte
          this.gpioOut = (this.gpioOut & ~byteMask) | ((val & 0xFF) << shift);
        }

        const changed = prev ^ this.gpioOut;
        if (changed) {
          const timeMs = (this.core.cycles / CPU_HZ) * 1000;
          for (let bit = 0; bit < 22; bit++) {   // ESP32-C3 has GPIO0–GPIO21
            if (changed & (1 << bit)) {
              const state = !!(this.gpioOut & (1 << bit));
              this.onPinChangeWithTime?.(bit, state, timeMs);
              this.pinManager.setPinState(bit, state);
            }
          }
        }
      },
    );
  }

  // ── HEX loading ────────────────────────────────────────────────────────────

  /**
   * Load an Intel HEX file. The hex addresses must be relative to IROM_BASE
   * (0x42000000), or zero-based (the parser will treat them as flash offsets).
   */
  loadHex(hexContent: string): void {
    this.flash.fill(0);
    const bytes = hexToUint8Array(hexContent);

    // hexToUint8Array returns bytes indexed from address 0.
    // If the hex records used IROM_BASE-relative addressing, the byte array
    // will start at offset IROM_BASE within a huge buffer — we can't use that.
    // Support both:
    //   a) Small array (< IROM_SIZE) → direct flash offset mapping
    //   b) Large array → slice from IROM_BASE offset if present
    if (bytes.length <= IROM_SIZE) {
      const maxCopy = Math.min(bytes.length, IROM_SIZE);
      this.flash.set(bytes.subarray(0, maxCopy), 0);
    } else {
      // Try to extract data at IROM_BASE offset
      const iromOffset = IROM_BASE;
      if (bytes.length > iromOffset) {
        const maxCopy = Math.min(bytes.length - iromOffset, IROM_SIZE);
        this.flash.set(bytes.subarray(iromOffset, iromOffset + maxCopy), 0);
      }
    }

    this.dram.fill(0);
    this.iram.fill(0);
    this.core.reset(IROM_BASE);
    this.core.regs[2] = (DRAM_BASE + DRAM_SIZE - 16) | 0;
  }

  /**
   * Load a raw binary image into flash at offset 0 (maps to IROM_BASE 0x42000000).
   * Use this with binaries produced by:
   *   riscv32-esp-elf-objcopy -O binary firmware.elf firmware.bin
   */
  loadBin(bin: Uint8Array): void {
    this.flash.fill(0);
    const maxCopy = Math.min(bin.length, IROM_SIZE);
    this.flash.set(bin.subarray(0, maxCopy), 0);
    this.dram.fill(0);
    this.iram.fill(0);
    this.rxFifo  = [];
    this.gpioOut = 0;
    this.gpioIn  = 0;
    this.core.reset(IROM_BASE);
    this.core.regs[2] = (DRAM_BASE + DRAM_SIZE - 16) | 0;
  }

  /**
   * Load a merged ESP32 flash image from the backend (base64-encoded).
   *
   * The backend produces a 4 MB merged image:
   *   0x01000 — bootloader
   *   0x08000 — partition table
   *   0x10000 — application (ESP32 image format with segment headers)
   *
   * Each image segment is loaded at its virtual load address:
   *   IROM (0x42xxxxxx) → flash buffer  (executed code)
   *   DROM (0x3Cxxxxxx) → flash buffer  (read-only data alias)
   *   DRAM (0x3FCxxxxx) → dram buffer   (initialised .data)
   *   IRAM (0x4037xxxx) → iram buffer   (ISR / time-critical code)
   *
   * The CPU resets to the entry point declared in the image header.
   */
  loadFlashImage(base64: string): void {
    // Base64 decode
    const binStr = atob(base64);
    const data = new Uint8Array(binStr.length);
    for (let i = 0; i < binStr.length; i++) data[i] = binStr.charCodeAt(i);

    // Parse ESP32 image format
    const parsed = parseMergedFlashImage(data);

    // Clear all memory regions
    this.flash.fill(0);
    this.dram.fill(0);
    this.iram.fill(0);
    this.rxFifo  = [];
    this.gpioOut = 0;
    this.gpioIn  = 0;

    // Load each segment at its virtual address
    for (const { loadAddr, data: seg } of parsed.segments) {
      const uAddr = loadAddr >>> 0;

      if (uAddr >= IROM_BASE && uAddr + seg.length <= IROM_BASE + IROM_SIZE) {
        this.flash.set(seg, uAddr - IROM_BASE);
      } else if (uAddr >= DROM_BASE && uAddr + seg.length <= DROM_BASE + IROM_SIZE) {
        // DROM is a virtual alias of flash — store at same flash buffer
        this.flash.set(seg, uAddr - DROM_BASE);
      } else if (uAddr >= DRAM_BASE && uAddr + seg.length <= DRAM_BASE + DRAM_SIZE) {
        this.dram.set(seg, uAddr - DRAM_BASE);
      } else if (uAddr >= IRAM_BASE && uAddr + seg.length <= IRAM_BASE + IRAM_SIZE) {
        this.iram.set(seg, uAddr - IRAM_BASE);
      } else {
        console.warn(
          `[Esp32C3Simulator] Segment 0x${uAddr.toString(16)}` +
          ` (${seg.length} B) outside known regions — skipped`
        );
      }
    }

    // Boot CPU at image entry point
    this.core.reset(parsed.entryPoint);
    this.core.regs[2] = (DRAM_BASE + DRAM_SIZE - 16) | 0;

    console.log(
      `[Esp32C3Simulator] Loaded ${parsed.segments.length} segments,` +
      ` entry=0x${parsed.entryPoint.toString(16)}`
    );
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  start(): void {
    if (this.running) return;
    this.running = true;
    this._loop();
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.animFrameId);
  }

  reset(): void {
    this.stop();
    this.rxFifo  = [];
    this.gpioOut = 0;
    this.gpioIn  = 0;
    this.dram.fill(0);
    this.iram.fill(0);
    this.core.reset(IROM_BASE);
    this.core.regs[2] = (DRAM_BASE + DRAM_SIZE - 16) | 0;
  }

  serialWrite(text: string): void {
    for (let i = 0; i < text.length; i++) {
      this.rxFifo.push(text.charCodeAt(i));
    }
  }

  setPinState(pin: number, state: boolean): void {
    if (state) this.gpioIn |=  (1 << pin);
    else        this.gpioIn &= ~(1 << pin);
  }

  isRunning(): boolean {
    return this.running;
  }

  // ── Execution loop ─────────────────────────────────────────────────────────

  private _loop(): void {
    if (!this.running) return;
    for (let i = 0; i < CYCLES_PER_FRAME; i++) {
      this.core.step();
    }
    this.animFrameId = requestAnimationFrame(() => this._loop());
  }
}
