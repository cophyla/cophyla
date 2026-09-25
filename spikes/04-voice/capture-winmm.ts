// Microphone capture in-process under Bun on Windows: bun:ffi -> winmm.dll waveIn*.
// WAVE_MAPPER opens the user's default recording device and converts to 16 kHz mono int16,
// so no device name, no resampler and no native addon are needed. Buffers are polled
// (CALLBACK_NULL), which keeps every FFI call on the JS thread.
import { dlopen, FFIType, read, toArrayBuffer, type Pointer } from 'bun:ffi';

const { u32, ptr, u64 } = FFIType;

const winmm = dlopen('winmm.dll', {
  waveInGetNumDevs: { args: [], returns: u32 },
  waveInGetDevCapsW: { args: [u64, ptr, u32], returns: u32 },
  waveInOpen: { args: [ptr, u32, ptr, u64, u64, u32], returns: u32 },
  waveInPrepareHeader: { args: [u64, ptr, u32], returns: u32 },
  waveInUnprepareHeader: { args: [u64, ptr, u32], returns: u32 },
  waveInAddBuffer: { args: [u64, ptr, u32], returns: u32 },
  waveInStart: { args: [u64], returns: u32 },
  waveInReset: { args: [u64], returns: u32 },
  waveInClose: { args: [u64], returns: u32 },
}).symbols;

// Native allocations: the driver writes into these while JS runs, so they must never move.
const crt = dlopen('ucrtbase.dll', {
  calloc: { args: [u64, u64], returns: ptr },
  free: { args: [ptr], returns: FFIType.void },
}).symbols;

const WAVE_MAPPER = 0xffffffff;
const WHDR_DONE = 0x1;
const WAVEHDR_SIZE = 48; // x64: lpData 8, dwBufferLength 4, dwBytesRecorded 4, dwUser 8, dwFlags 4, dwLoops 4, lpNext 8, reserved 8

function check(what: string, rc: number) {
  if (rc !== 0) throw new Error(`${what} failed, MMRESULT ${rc}`);
}

export function listDevices(): string[] {
  const n = winmm.waveInGetNumDevs();
  const caps = crt.calloc(1n, 80n) as Pointer; // WAVEINCAPSW
  const names: string[] = [];
  for (let i = 0; i < n; i++) {
    check('waveInGetDevCapsW', winmm.waveInGetDevCapsW(BigInt(i), caps, 80));
    const raw = new Uint16Array(toArrayBuffer(caps, 8, 64).slice(0)); // szPname[32]
    names.push(String.fromCharCode(...raw.subarray(0, raw.indexOf(0) < 0 ? 32 : raw.indexOf(0))));
  }
  crt.free(caps);
  return names;
}

export type Capture = { stop(): void; overruns: number };

// onChunk receives a copy of each filled buffer (samplesPerBuffer int16 samples).
export function startCapture(
  onChunk: (samples: Int16Array) => void,
  { sampleRate = 16000, samplesPerBuffer = 1280, buffers = 12, deviceId = WAVE_MAPPER, pollMs = 10 } = {},
): Capture {
  const fmt = crt.calloc(1n, 18n) as Pointer; // WAVEFORMATEX
  const f = new DataView(toArrayBuffer(fmt, 0, 18));
  f.setUint16(0, 1, true); // WAVE_FORMAT_PCM
  f.setUint16(2, 1, true); // mono
  f.setUint32(4, sampleRate, true);
  f.setUint32(8, sampleRate * 2, true);
  f.setUint16(12, 2, true); // block align
  f.setUint16(14, 16, true); // bits

  const handleBox = crt.calloc(1n, 8n) as Pointer;
  check('waveInOpen', winmm.waveInOpen(handleBox, deviceId, fmt, 0n, 0n, 0 /* CALLBACK_NULL */));
  const hwi = read.u64(handleBox, 0);

  const bytes = samplesPerBuffer * 2;
  const headers: Pointer[] = [];
  for (let i = 0; i < buffers; i++) {
    const data = crt.calloc(1n, BigInt(bytes)) as Pointer;
    const hdr = crt.calloc(1n, BigInt(WAVEHDR_SIZE)) as Pointer;
    const h = new DataView(toArrayBuffer(hdr, 0, WAVEHDR_SIZE));
    h.setBigUint64(0, BigInt(data as unknown as number), true);
    h.setUint32(8, bytes, true);
    check('waveInPrepareHeader', winmm.waveInPrepareHeader(hwi, hdr, WAVEHDR_SIZE));
    check('waveInAddBuffer', winmm.waveInAddBuffer(hwi, hdr, WAVEHDR_SIZE));
    headers.push(hdr);
  }
  check('waveInStart', winmm.waveInStart(hwi));

  const state: Capture = { stop, overruns: 0 };
  let next = 0; // buffers complete in the order they were queued
  const timer = setInterval(() => {
    let drained = 0;
    while (read.u32(headers[next], 24) & WHDR_DONE) {
      const hdr = headers[next];
      const recorded = read.u32(hdr, 12);
      const data = read.ptr(hdr, 0) as unknown as Pointer;
      onChunk(new Int16Array(toArrayBuffer(data, 0, recorded).slice(0)));
      check('waveInAddBuffer', winmm.waveInAddBuffer(hwi, hdr, WAVEHDR_SIZE));
      next = (next + 1) % buffers;
      if (++drained === buffers) { state.overruns++; break; } // every buffer was full: audio was dropped
    }
  }, pollMs);

  function stop() {
    clearInterval(timer);
    winmm.waveInReset(hwi);
    for (const hdr of headers) {
      winmm.waveInUnprepareHeader(hwi, hdr, WAVEHDR_SIZE);
      crt.free(read.ptr(hdr, 0) as unknown as Pointer);
      crt.free(hdr);
    }
    winmm.waveInClose(hwi);
    crt.free(handleBox);
    crt.free(fmt);
  }
  return state;
}
