/**
 * Pure Client-Side In-Browser Matroska (.mkv) to Apple MP4 (video/mp4) Remuxer Engine
 * Runs 100% inside iPhone / iPad Safari & mobile browsers with ZERO backend server dependency.
 * Works on static hosts (GitHub Pages mimu-tech.github.io) and Cloud Run alike.
 */

export interface MkvTrackInfo {
  number: number;
  type: number; // 1 = video, 2 = audio
  codecId: string;
  codecPrivate: Uint8Array | null;
  width: number;
  height: number;
  sampleRate: number;
  outSampleRate: number;
  channels: number;
  defaultDuration: number;
}

export interface VideoSample {
  ptsMs: number;
  data: Uint8Array;
  keyframe: boolean;
}

export interface AudioSample {
  ptsMs: number;
  data: Uint8Array;
}

export interface MkvSubtitleSample {
  ptsMs: number;
  endPtsMs: number;
  text: string;
  trackNum: number;
}

export interface RemuxedSegmentItem {
  index: number;
  blobUrl: string;
  startSec: number;
  durationSec: number;
}

function readVint(b: Uint8Array, pos: number): { val: number; len: number } | null {
  if (pos >= b.byteLength) return null;
  const b0 = b[pos];
  if (b0 === 0) return null;
  let len = 1;
  let mask = 0x80;
  while (len <= 8 && (b0 & mask) === 0) {
    len++;
    mask >>= 1;
  }
  if (len > 8 || pos + len > b.byteLength) return null;
  let val = b0 & (mask - 1);
  let allOnes = val === mask - 1;
  for (let i = 1; i < len; i++) {
    val = val * 256 + b[pos + i];
    if (b[pos + i] !== 0xff) allOnes = false;
  }
  return { val: allOnes ? -1 : val, len };
}

function readEbmlId(b: Uint8Array, pos: number): { id: number; len: number } | null {
  if (pos >= b.byteLength) return null;
  const b0 = b[pos];
  if (b0 === 0) return null;
  let len = 1;
  let mask = 0x80;
  while (len <= 4 && (b0 & mask) === 0) {
    len++;
    mask >>= 1;
  }
  if (len > 4 || pos + len > b.byteLength) return null;
  let id = 0;
  for (let i = 0; i < len; i++) {
    id = id * 256 + b[pos + i];
  }
  return { id, len };
}

function readUint(b: Uint8Array, pos: number, len: number): number {
  let v = 0;
  for (let i = 0; i < len; i++) {
    v = v * 256 + b[pos + i];
  }
  return v;
}

function readFloat(b: Uint8Array, pos: number, len: number): number {
  if (pos + len > b.byteLength) return 0;
  const dv = new DataView(b.buffer, b.byteOffset + pos, len);
  if (len === 4) return dv.getFloat32(0, false);
  if (len === 8) return dv.getFloat64(0, false);
  return 0;
}

function decodeAscii(b: Uint8Array, start: number, end: number): string {
  let s = '';
  for (let i = start; i < end; i++) {
    if (b[i] === 0) break;
    s += String.fromCharCode(b[i]);
  }
  return s;
}

function findClusterOffset(b: Uint8Array, fromPos: number): number {
  const limit = b.byteLength - 4;
  for (let i = Math.max(0, fromPos); i <= limit; i++) {
    if (
      b[i] === 0x1f &&
      b[i + 1] === 0x43 &&
      b[i + 2] === 0xb6 &&
      b[i + 3] === 0x75
    ) {
      return i;
    }
  }
  return -1;
}

export function parseMkvHeaderAndSamples(
  b: Uint8Array,
  existingTracks?: MkvTrackInfo[],
  existingTimecodeScale?: number
): {
  tracks: MkvTrackInfo[];
  timecodeScale: number;
  durationSec: number;
  videoSamples: VideoSample[];
  audioSamples: AudioSample[];
  subtitleSamples: MkvSubtitleSample[];
  consumedBytes: number;
} {
  let pos = 0;
  let timecodeScale = existingTimecodeScale || 1_000_000;
  let rawDuration = 0;
  const tracks: MkvTrackInfo[] = existingTracks ? [...existingTracks] : [];
  const videoSamples: VideoSample[] = [];
  const audioSamples: AudioSample[] = [];
  const subtitleSamples: MkvSubtitleSample[] = [];
  let currentClusterTime = 0;
  let lastCompleteClusterEnd = 0;

  const parseTracksElement = (start: number, end: number) => {
    if (tracks.length > 0) return;
    let p = start;
    while (p < end) {
      const idObj = readEbmlId(b, p);
      if (!idObj) break;
      const szObj = readVint(b, p + idObj.len);
      if (!szObj) break;
      const dStart = p + idObj.len + szObj.len;
      const dEnd = szObj.val < 0 ? end : Math.min(end, dStart + szObj.val);
      if (idObj.id === 0xae) {
        const track: MkvTrackInfo = {
          number: 0,
          type: 0,
          codecId: '',
          codecPrivate: null,
          width: 1280,
          height: 720,
          sampleRate: 44100,
          outSampleRate: 0,
          channels: 2,
          defaultDuration: 0,
        };
        let tp = dStart;
        while (tp < dEnd) {
          const tid = readEbmlId(b, tp);
          if (!tid) break;
          const tsz = readVint(b, tp + tid.len);
          if (!tsz) break;
          const tds = tp + tid.len + tsz.len;
          const tde = tsz.val < 0 ? dEnd : Math.min(dEnd, tds + tsz.val);
          if (tid.id === 0xd7) track.number = readUint(b, tds, tsz.val);
          else if (tid.id === 0x83) track.type = readUint(b, tds, tsz.val);
          else if (tid.id === 0x86) track.codecId = decodeAscii(b, tds, tde);
          else if (tid.id === 0x63a2) track.codecPrivate = b.slice(tds, tde);
          else if (tid.id === 0x23e383) track.defaultDuration = readUint(b, tds, tsz.val);
          else if (tid.id === 0xe0) {
            let vp = tds;
            while (vp < tde) {
              const vid = readEbmlId(b, vp);
              if (!vid) break;
              const vsz = readVint(b, vp + vid.len);
              if (!vsz) break;
              const vds = vp + vid.len + vsz.len;
              if (vid.id === 0xb0) track.width = readUint(b, vds, vsz.val);
              else if (vid.id === 0xba) track.height = readUint(b, vds, vsz.val);
              vp = vds + vsz.val;
            }
          } else if (tid.id === 0xe1) {
            let ap = tds;
            while (ap < tde) {
              const aid = readEbmlId(b, ap);
              if (!aid) break;
              const asz = readVint(b, ap + aid.len);
              if (!asz) break;
              const ads = ap + aid.len + asz.len;
              if (aid.id === 0xb5) track.sampleRate = readFloat(b, ads, asz.val);
              else if (aid.id === 0x78b5) track.outSampleRate = readFloat(b, ads, asz.val);
              else if (aid.id === 0x9f) track.channels = readUint(b, ads, asz.val);
              ap = ads + asz.val;
            }
          }
          tp = tde;
        }
        tracks.push(track);
      }
      p = dEnd;
    }
  };

  const handleBlock = (
    dStart: number,
    dEnd: number,
    isKeyframeHint: boolean,
    blockDurationTicks = 0
  ) => {
    const trkVint = readVint(b, dStart);
    if (!trkVint) return;
    const trackNum = trkVint.val;
    let bp = dStart + trkVint.len;
    if (bp + 3 > dEnd) return;
    let relTime = (b[bp] << 8) | b[bp + 1];
    if (relTime & 0x8000) relTime -= 0x10000;
    const flags = b[bp + 2];
    bp += 3;
    const scaleMs = timecodeScale / 1_000_000;
    const absTimeMs = (currentClusterTime + relTime) * scaleMs;
    const isKeyframe = isKeyframeHint || Boolean(flags & 0x80);
    const lacing = (flags >> 1) & 0x03;
    const frames: Uint8Array[] = [];

    if (lacing === 0) {
      if (bp < dEnd) frames.push(b.subarray(bp, dEnd));
    } else if (bp < dEnd) {
      const numFrames = b[bp] + 1;
      bp += 1;
      const sizes: number[] = [];
      if (lacing === 1) {
        let sum = 0;
        for (let i = 0; i < numFrames - 1; i++) {
          let s = 0;
          while (bp < dEnd && b[bp] === 255) {
            s += 255;
            bp++;
          }
          if (bp < dEnd) {
            s += b[bp];
            bp++;
          }
          sizes.push(s);
          sum += s;
        }
        sizes.push(dEnd - bp - sum);
      } else if (lacing === 2) {
        const fsz = Math.floor((dEnd - bp) / numFrames);
        for (let i = 0; i < numFrames; i++) sizes.push(fsz);
      } else if (lacing === 3) {
        const first = readVint(b, bp);
        if (!first) return;
        bp += first.len;
        let prev = first.val;
        sizes.push(prev);
        let sum = prev;
        for (let i = 1; i < numFrames - 1; i++) {
          const dv = readVint(b, bp);
          if (!dv) return;
          bp += dv.len;
          const bias = (1 << (7 * dv.len - 1)) - 1;
          prev = prev + (dv.val - bias);
          sizes.push(prev);
          sum += prev;
        }
        sizes.push(dEnd - bp - sum);
      }
      for (const sz of sizes) {
        if (sz > 0 && bp + sz <= dEnd) {
          frames.push(b.subarray(bp, bp + sz));
          bp += sz;
        }
      }
    }

    const vTrack = tracks.find((t) => t.type === 1);
    const aTrack = tracks.find((t) => t.type === 2);
    const sTrack = tracks.find((t) => t.type === 17 && t.number === trackNum);
    if (vTrack && trackNum === vTrack.number) {
      const frameDurMs = vTrack.defaultDuration
        ? vTrack.defaultDuration / 1_000_000
        : 33.333;
      for (let i = 0; i < frames.length; i++) {
        videoSamples.push({
          ptsMs: absTimeMs + i * frameDurMs,
          data: frames[i],
          keyframe: isKeyframe && i === 0,
        });
      }
    } else if (aTrack && trackNum === aTrack.number) {
      const sr = aTrack.sampleRate || 44100;
      const frameDurMs = (1024 / sr) * 1000;
      for (let i = 0; i < frames.length; i++) {
        audioSamples.push({
          ptsMs: absTimeMs + i * frameDurMs,
          data: frames[i],
        });
      }
    } else if (sTrack && frames.length > 0) {
      try {
        const rawStr = new TextDecoder('utf-8').decode(frames[0]);
        let cleanText = rawStr;
        if (/ASS|SSA/i.test(sTrack.codecId)) {
          // Format: ReadOrder,Layer,Style,Name,MarginL,MarginR,MarginV,Effect,Text
          const parts = rawStr.split(',');
          if (parts.length >= 9) {
            cleanText = parts.slice(8).join(',');
          }
        }
        cleanText = cleanText
          .replace(/\{\\[^}]*\}/g, '')
          .replace(/\\N|\\n/g, ' ')
          .replace(/<[^>]+>/g, '')
          .replace(/\s{2,}/g, ' ')
          .trim();
        if (cleanText.length >= 2) {
          const durMs =
            blockDurationTicks > 0 ? blockDurationTicks * scaleMs : 3500;
          subtitleSamples.push({
            ptsMs: Math.max(0, absTimeMs),
            endPtsMs: Math.max(0, absTimeMs) + Math.min(8000, Math.max(1200, durMs)),
            text: cleanText,
            trackNum,
          });
        }
      } catch {
        // ignore malformed subtitle block
      }
    }
  };

  // If this is a mid-file chunk that doesn't start at EBML header (0x1A45DFA3), jump to first Cluster (0x1F43B675)
  if (
    b.byteLength >= 4 &&
    !(b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) &&
    !(b[0] === 0x1f && b[1] === 0x43 && b[2] === 0xb6 && b[3] === 0x75)
  ) {
    const firstCluster = findClusterOffset(b, 0);
    if (firstCluster !== -1) {
      pos = firstCluster;
    }
  }

  while (pos < b.byteLength) {
    const idObj = readEbmlId(b, pos);
    if (!idObj) break;
    const szObj = readVint(b, pos + idObj.len);
    if (!szObj) break;
    const dStart = pos + idObj.len + szObj.len;
    const isUnknownSize = szObj.val < 0;
    const rawEnd = isUnknownSize ? b.byteLength : dStart + szObj.val;

    if (idObj.id === 0x18538067) {
      // Segment container: step inside
      pos = dStart;
      continue;
    }

    if (idObj.id === 0x1549a966) {
      // Segment Info
      const dEnd = Math.min(b.byteLength, rawEnd);
      let ip = dStart;
      while (ip < dEnd) {
        const iid = readEbmlId(b, ip);
        if (!iid) break;
        const isz = readVint(b, ip + iid.len);
        if (!isz) break;
        const ids = ip + iid.len + isz.len;
        if (iid.id === 0x2ad7b1) timecodeScale = readUint(b, ids, isz.val);
        else if (iid.id === 0x4489) rawDuration = readFloat(b, ids, isz.val);
        ip = ids + isz.val;
      }
      pos = dEnd;
      continue;
    }

    if (idObj.id === 0x1654ae6b) {
      // Tracks
      const dEnd = Math.min(b.byteLength, rawEnd);
      parseTracksElement(dStart, dEnd);
      pos = dEnd;
      continue;
    }

    if (idObj.id === 0x1f43b675) {
      // Cluster
      // If this cluster overflows our downloaded buffer and we already parsed at least 1 complete cluster,
      // stop right at `pos` so the next HTTP Range fetch starts cleanly at this exact Cluster!
      if (!isUnknownSize && rawEnd > b.byteLength && lastCompleteClusterEnd > 0) {
        break;
      }

      const dEnd = Math.min(b.byteLength, rawEnd);
      let cp = dStart;
      while (cp < dEnd) {
        const cid = readEbmlId(b, cp);
        if (!cid) break;
        const csz = readVint(b, cp + cid.len);
        if (!csz) break;
        const cds = cp + cid.len + csz.len;
        const cRawEnd = csz.val < 0 ? dEnd : cds + csz.val;
        if (cRawEnd > b.byteLength) {
          cp = b.byteLength;
          break;
        }
        if (cid.id === 0xe7) {
          currentClusterTime = readUint(b, cds, csz.val);
        } else if (cid.id === 0xa3) {
          handleBlock(cds, cRawEnd, false, 0);
        } else if (cid.id === 0xa0) {
          let bgp = cds;
          let blockStart = -1;
          let blockEnd = -1;
          let hasReference = false;
          let blockDurTicks = 0;
          while (bgp < cRawEnd) {
            const bid = readEbmlId(b, bgp);
            if (!bid) break;
            const bsz = readVint(b, bgp + bid.len);
            if (!bsz) break;
            const bds = bgp + bid.len + bsz.len;
            const bde = Math.min(cRawEnd, bds + bsz.val);
            if (bid.id === 0xa1) {
              blockStart = bds;
              blockEnd = bde;
            } else if (bid.id === 0x9b) {
              blockDurTicks = readUint(b, bds, bsz.val);
            } else if (bid.id === 0xfb) {
              hasReference = true;
            }
            bgp = bde;
          }
          if (blockStart !== -1 && blockEnd !== -1) {
            handleBlock(blockStart, blockEnd, !hasReference, blockDurTicks);
          }
        }
        cp = cRawEnd;
      }

      lastCompleteClusterEnd = dEnd;
      pos = dEnd;
      continue;
    }

    if (rawEnd > b.byteLength) break;
    pos = rawEnd;
  }

  const durationSec =
    rawDuration > 0 ? (rawDuration * (timecodeScale / 1_000_000)) / 1000 : 0;

  return {
    tracks,
    timecodeScale,
    durationSec,
    videoSamples,
    audioSamples,
    subtitleSamples,
    consumedBytes: lastCompleteClusterEnd > 0 ? lastCompleteClusterEnd : b.byteLength,
  };
}

function box(type: string, ...payloads: Uint8Array[]): Uint8Array {
  let size = 8;
  for (const p of payloads) size += p.byteLength;
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, size, false);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  let offset = 8;
  for (const p of payloads) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

function u32(v: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v >>> 0, false);
  return b;
}

function u16(v: number): Uint8Array {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, v & 0xffff, false);
  return b;
}

function strBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/**
 * Builds a faststart ISO BMFF MP4 (ftyp + moov + mdat) from parsed H.264 & AAC samples.
 */
export function buildFastStartMp4(
  tracks: MkvTrackInfo[],
  rawVideoSamples: VideoSample[],
  rawAudioSamples: AudioSample[]
): { mp4Bytes: Uint8Array; durationSec: number; startSec: number } | null {
  const vTrack = tracks.find((t) => t.type === 1);
  if (!vTrack || !vTrack.codecPrivate || rawVideoSamples.length < 2) {
    return null;
  }
  const aTrack = tracks.find((t) => t.type === 2);

  const basePtsMs = rawVideoSamples[0].ptsMs;
  const vSamples = rawVideoSamples.map((s) => ({
    ptsTicks: Math.max(0, Math.round((s.ptsMs - basePtsMs) * 90)),
    data: s.data,
    keyframe: s.keyframe,
  }));

  const aSampleRate = aTrack ? aTrack.sampleRate || 22050 : 44100;
  const aSamples = aTrack
    ? rawAudioSamples
        .filter((s) => s.ptsMs >= basePtsMs - 40)
        .map((s) => ({
          ptsMs: Math.max(0, s.ptsMs - basePtsMs),
          data: s.data,
        }))
    : [];

  // Ensure every video sample has a strictly unique PTS in presentation order
  // (prevents duplicate PTS/DTS errors in Apple CoreMedia & FFmpeg when Matroska blocks share rounded ms timestamps)
  const presOrder = vSamples
    .map((_, idx) => idx)
    .sort((a, b) => vSamples[a].ptsTicks - vSamples[b].ptsTicks || a - b);
  for (let i = 1; i < presOrder.length; i++) {
    const prevPts = vSamples[presOrder[i - 1]].ptsTicks;
    if (vSamples[presOrder[i]].ptsTicks <= prevPts) {
      vSamples[presOrder[i]].ptsTicks = prevPts + 90;
    }
  }

  // Calculate strictly monotonic DTS & non-negative Composition Time Offsets (CTO) for B-frames
  const dtsTicks: number[] = new Array(vSamples.length);
  for (let i = 0; i < vSamples.length; i++) {
    dtsTicks[i] = vSamples[presOrder[i]].ptsTicks;
  }
  const vDeltas: number[] = [];
  const vCtos: number[] = [];
  let minDiff = 0;
  for (let i = 0; i < vSamples.length; i++) {
    const diff = vSamples[i].ptsTicks - dtsTicks[i];
    if (diff < minDiff) minDiff = diff;
  }
  for (let i = 0; i < vSamples.length; i++) {
    const nextDts =
      i + 1 < vSamples.length ? dtsTicks[i + 1] : dtsTicks[i] + 3000;
    vDeltas.push(Math.max(90, nextDts - dtsTicks[i]));
    vCtos.push(vSamples[i].ptsTicks - dtsTicks[i] - minDiff);
  }

  let vDataLen = 0;
  for (const s of vSamples) vDataLen += s.data.byteLength;
  let aDataLen = 0;
  for (const s of aSamples) aDataLen += s.data.byteLength;

  const totalDur90k = vDeltas.reduce((acc, d) => acc + d, 0);
  const totalDurMs = Math.max(1, Math.round(totalDur90k / 90));

  const ftyp = box(
    'ftyp',
    strBytes('isom'),
    u32(512),
    strBytes('isomiso2avc1mp41')
  );

  const buildMoovWithOffsets = (vChunkOffset: number, aChunkOffset: number) => {
    const matrix = new Uint8Array([
      0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0, 0x40, 0, 0, 0,
    ]);

    const tkhdV = box(
      'tkhd',
      new Uint8Array([0, 0, 0, 3]),
      u32(0),
      u32(0),
      u32(1),
      u32(0),
      u32(totalDurMs),
      new Uint8Array(8),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      matrix,
      u32((vTrack.width || 1280) << 16),
      u32((vTrack.height || 720) << 16)
    );

    const mdhdV = box(
      'mdhd',
      u32(0),
      u32(0),
      u32(0),
      u32(90000),
      u32(totalDur90k),
      u16(0x55c4),
      u16(0)
    );
    const hdlrV = box(
      'hdlr',
      u32(0),
      u32(0),
      strBytes('vide'),
      new Uint8Array(12),
      strBytes('VideoHandler\0')
    );
    const vmhd = box('vmhd', new Uint8Array([0, 0, 0, 1]), new Uint8Array(8));
    const dref = box(
      'dref',
      u32(0),
      u32(1),
      box('url ', new Uint8Array([0, 0, 0, 1]))
    );
    const dinf = box('dinf', dref);

    const isHevc = /HEVC/i.test(vTrack.codecId);
    const isAv1 = /AV1/i.test(vTrack.codecId);
    const sampleEntryFourCC = isHevc ? 'hvc1' : isAv1 ? 'av01' : 'avc1';
    const configFourCC = isHevc ? 'hvcC' : isAv1 ? 'av1C' : 'avcC';

    const codecConfigBox = box(configFourCC, vTrack.codecPrivate!);
    const visualSampleEntry = box(
      sampleEntryFourCC,
      new Uint8Array(6),
      u16(1),
      new Uint8Array(16),
      u16(vTrack.width || 1280),
      u16(vTrack.height || 720),
      u32(0x00480000),
      u32(0x00480000),
      u32(0),
      u16(1),
      new Uint8Array(32),
      u16(0x0018),
      u16(0xffff),
      codecConfigBox
    );
    const stsdV = box('stsd', u32(0), u32(1), visualSampleEntry);

    const sttsVBuf = new Uint8Array(8 + vDeltas.length * 8);
    const sttsVDv = new DataView(sttsVBuf.buffer);
    sttsVDv.setUint32(4, vDeltas.length, false);
    for (let i = 0; i < vDeltas.length; i++) {
      sttsVDv.setUint32(8 + i * 8, 1, false);
      sttsVDv.setUint32(12 + i * 8, vDeltas[i], false);
    }
    const sttsV = box('stts', sttsVBuf);

    const cttsVBuf = new Uint8Array(8 + vCtos.length * 8);
    const cttsVDv = new DataView(cttsVBuf.buffer);
    cttsVDv.setUint32(4, vCtos.length, false);
    for (let i = 0; i < vCtos.length; i++) {
      cttsVDv.setUint32(8 + i * 8, 1, false);
      cttsVDv.setUint32(12 + i * 8, vCtos[i], false);
    }
    const cttsV = box('ctts', cttsVBuf);

    const syncIndices: number[] = [];
    for (let i = 0; i < vSamples.length; i++) {
      if (vSamples[i].keyframe) syncIndices.push(i + 1);
    }
    if (syncIndices.length === 0) syncIndices.push(1);
    const stssVBuf = new Uint8Array(8 + syncIndices.length * 4);
    const stssVDv = new DataView(stssVBuf.buffer);
    stssVDv.setUint32(4, syncIndices.length, false);
    for (let i = 0; i < syncIndices.length; i++) {
      stssVDv.setUint32(8 + i * 4, syncIndices[i], false);
    }
    const stssV = box('stss', stssVBuf);

    const stscV = box(
      'stsc',
      u32(0),
      u32(1),
      u32(1),
      u32(vSamples.length),
      u32(1)
    );
    const stszVBuf = new Uint8Array(12 + vSamples.length * 4);
    const stszVDv = new DataView(stszVBuf.buffer);
    stszVDv.setUint32(8, vSamples.length, false);
    for (let i = 0; i < vSamples.length; i++) {
      stszVDv.setUint32(12 + i * 4, vSamples[i].data.byteLength, false);
    }
    const stszV = box('stsz', stszVBuf);
    const stcoV = box('stco', u32(0), u32(1), u32(vChunkOffset));

    const stblV = box('stbl', stsdV, sttsV, cttsV, stssV, stscV, stszV, stcoV);
    const minfV = box('minf', vmhd, dinf, stblV);
    const mdiaV = box('mdia', mdhdV, hdlrV, minfV);
    const trakV = box('trak', tkhdV, mdiaV);

    const traks: Uint8Array[] = [trakV];

    if (aTrack && aSamples.length > 0) {
      const aDurTicks = aSamples.length * 1024;
      const tkhdA = box(
        'tkhd',
        new Uint8Array([0, 0, 0, 3]),
        u32(0),
        u32(0),
        u32(2),
        u32(0),
        u32(totalDurMs),
        new Uint8Array(8),
        u16(0),
        u16(0),
        u16(0x0100),
        u16(0),
        matrix,
        u32(0),
        u32(0)
      );
      const mdhdA = box(
        'mdhd',
        u32(0),
        u32(0),
        u32(0),
        u32(aSampleRate),
        u32(aDurTicks),
        u16(0x55c4),
        u16(0)
      );
      const hdlrA = box(
        'hdlr',
        u32(0),
        u32(0),
        strBytes('soun'),
        new Uint8Array(12),
        strBytes('SoundHandler\0')
      );
      const smhd = box('smhd', u32(0), u32(0));

      const asc = aTrack.codecPrivate || new Uint8Array([0x12, 0x10]);
      const esdsPayload = new Uint8Array([
        0,
        0,
        0,
        0,
        0x03,
        23 + asc.byteLength,
        0x00,
        0x02,
        0x00,
        0x04,
        15 + asc.byteLength,
        0x40,
        0x15,
        0x00,
        0x00,
        0x00,
        0x00,
        0x01,
        0xf4,
        0x00,
        0x00,
        0x01,
        0xf4,
        0x00,
        0x05,
        asc.byteLength,
        ...Array.from(asc),
        0x06,
        0x01,
        0x02,
      ]);
      const esds = box('esds', esdsPayload);
      const mp4a = box(
        'mp4a',
        new Uint8Array(6),
        u16(1),
        new Uint8Array(8),
        u16(aTrack.channels || 2),
        u16(16),
        u16(0),
        u16(0),
        u32(aSampleRate << 16),
        esds
      );
      const stsdA = box('stsd', u32(0), u32(1), mp4a);
      const sttsA = box(
        'stts',
        u32(0),
        u32(1),
        u32(aSamples.length),
        u32(1024)
      );
      const stscA = box(
        'stsc',
        u32(0),
        u32(1),
        u32(1),
        u32(aSamples.length),
        u32(1)
      );
      const stszABuf = new Uint8Array(12 + aSamples.length * 4);
      const stszADv = new DataView(stszABuf.buffer);
      stszADv.setUint32(8, aSamples.length, false);
      for (let i = 0; i < aSamples.length; i++) {
        stszADv.setUint32(12 + i * 4, aSamples[i].data.byteLength, false);
      }
      const stszA = box('stsz', stszABuf);
      const stcoA = box('stco', u32(0), u32(1), u32(aChunkOffset));
      const stblA = box('stbl', stsdA, sttsA, stscA, stszA, stcoA);
      const minfA = box('minf', smhd, dinf, stblA);
      const mdiaA = box('mdia', mdhdA, hdlrA, minfA);
      const trakA = box('trak', tkhdA, mdiaA);
      traks.push(trakA);
    }

    const mvhd = box(
      'mvhd',
      u32(0),
      u32(0),
      u32(0),
      u32(1000),
      u32(totalDurMs),
      u32(0x00010000),
      u16(0x0100),
      new Uint8Array(10),
      matrix,
      new Uint8Array(24),
      u32(traks.length + 1)
    );

    return box('moov', mvhd, ...traks);
  };

  // First pass to measure exact moov size for faststart (ftyp + moov + mdat)
  const dummyMoov = buildMoovWithOffsets(0, 0);
  const vChunkOffset = ftyp.byteLength + dummyMoov.byteLength + 8;
  const aChunkOffset = vChunkOffset + vDataLen;
  const moov = buildMoovWithOffsets(vChunkOffset, aChunkOffset);

  const mdatSize = 8 + vDataLen + aDataLen;
  const finalMp4 = new Uint8Array(
    ftyp.byteLength + moov.byteLength + mdatSize
  );
  finalMp4.set(ftyp, 0);
  finalMp4.set(moov, ftyp.byteLength);

  const mdatOffset = ftyp.byteLength + moov.byteLength;
  new DataView(finalMp4.buffer).setUint32(mdatOffset, mdatSize, false);
  finalMp4.set(strBytes('mdat'), mdatOffset + 4);

  let writePos = mdatOffset + 8;
  for (const s of vSamples) {
    finalMp4.set(s.data, writePos);
    writePos += s.data.byteLength;
  }
  for (const s of aSamples) {
    finalMp4.set(s.data, writePos);
    writePos += s.data.byteLength;
  }

  return {
    mp4Bytes: finalMp4,
    durationSec: totalDurMs / 1000,
    startSec: basePtsMs / 1000,
  };
}

/**
 * Progressive Client-Side MKV-to-MP4 Stream Controller for iOS / Safari
 */
export class IosMkvStreamController {
  private url: string;
  private skipIntroSec: number;
  private aborted = false;
  private abortController = new AbortController();

  private tracks: MkvTrackInfo[] = [];
  private timecodeScale = 1_000_000;
  private totalFileBytes = 0;
  private totalDurationSec = 0;
  private nextByteOffset = 0;
  private eofReached = false;

  private carryVideo: VideoSample[] = [];
  private carryAudio: AudioSample[] = [];

  private segments: RemuxedSegmentItem[] = [];
  private buildingPromise: Promise<RemuxedSegmentItem | null> | null = null;

  constructor(url: string, skipIntroSec = 12) {
    this.url = url;
    this.skipIntroSec = skipIntroSec;
  }

  public destroy() {
    this.aborted = true;
    try {
      this.abortController.abort();
    } catch {
      // ignore
    }
    for (const seg of this.segments) {
      if (seg.blobUrl) {
        try {
          URL.revokeObjectURL(seg.blobUrl);
        } catch {
          // ignore
        }
      }
    }
    this.segments = [];
    this.carryVideo = [];
    this.carryAudio = [];
  }

  public getTotalDurationSec(): number {
    return this.totalDurationSec;
  }

  public async startInitialSegment(): Promise<RemuxedSegmentItem> {
    // 1. Fetch first 5.5 MB for ~35-55 seconds of video & instant <1s startup
    const INITIAL_BYTES = 5.5 * 1024 * 1024;
    const res = await fetch(this.url, {
      signal: this.abortController.signal,
      headers: {
        Range: `bytes=0-${INITIAL_BYTES - 1}`,
      },
    });

    if (!res.ok && res.status !== 206) {
      throw new Error(`HTTP ${res.status}`);
    }

    const contentRange = res.headers.get('content-range') || '';
    const totalMatch = contentRange.match(/\/(\d+)/);
    if (totalMatch) {
      this.totalFileBytes = Number(totalMatch[1]);
    }

    const buf = new Uint8Array(await res.arrayBuffer());
    if (this.aborted) throw new Error('Aborted');

    const parsed = parseMkvHeaderAndSamples(buf);
    this.tracks = parsed.tracks;
    this.timecodeScale = parsed.timecodeScale;
    if (parsed.durationSec > 0) {
      this.totalDurationSec = parsed.durationSec;
    }
    this.nextByteOffset = parsed.consumedBytes;
    if (this.totalFileBytes > 0 && this.nextByteOffset >= this.totalFileBytes) {
      this.eofReached = true;
    }

    let vSamples = parsed.videoSamples;
    let aSamples = parsed.audioSamples;

    // Strip the upstream 12s voice tag cleanly by starting at the first keyframe >= skipIntroSec
    if (this.skipIntroSec > 0 && (!this.totalDurationSec || this.totalDurationSec > 60)) {
      const targetSkipMs = Math.max(9500, (this.skipIntroSec - 0.5) * 1000);
      const kfIdx = vSamples.findIndex((s) => s.keyframe && s.ptsMs >= targetSkipMs);
      if (kfIdx > 0 && kfIdx < vSamples.length - 30) {
        const cutPts = vSamples[kfIdx].ptsMs;
        vSamples = vSamples.slice(kfIdx);
        aSamples = aSamples.filter((a) => a.ptsMs >= cutPts - 20);
      }
    }

    const seg0 = this.finalizeSegmentFromSamples(0, vSamples, aSamples);
    if (!seg0) {
      throw new Error('Unsupported MKV codec or empty segment');
    }

    this.segments.push(seg0);

    // Kick off Segment 1 pre-fetch in background immediately
    this.ensureNextSegmentPrebuffered(1);

    return seg0;
  }

  private finalizeSegmentFromSamples(
    segIndex: number,
    vAll: VideoSample[],
    aAll: AudioSample[]
  ): RemuxedSegmentItem | null {
    if (vAll.length < 2) return null;

    // Split at the last keyframe so the next segment ALWAYS starts on a clean IDR keyframe!
    let lastKeyframeIdx = -1;
    if (!this.eofReached) {
      for (let i = vAll.length - 1; i >= Math.min(30, Math.floor(vAll.length * 0.6)); i--) {
        if (vAll[i].keyframe) {
          lastKeyframeIdx = i;
          break;
        }
      }
    }

    let vForSeg = vAll;
    let aForSeg = aAll;

    if (lastKeyframeIdx > 15 && lastKeyframeIdx < vAll.length - 1) {
      const splitPtsMs = vAll[lastKeyframeIdx].ptsMs;
      vForSeg = vAll.slice(0, lastKeyframeIdx);
      this.carryVideo = vAll.slice(lastKeyframeIdx);
      aForSeg = aAll.filter((a) => a.ptsMs < splitPtsMs);
      this.carryAudio = aAll.filter((a) => a.ptsMs >= splitPtsMs);
    } else {
      this.carryVideo = [];
      this.carryAudio = [];
    }

    const built = buildFastStartMp4(this.tracks, vForSeg, aForSeg);
    if (!built) return null;

    const blob = new Blob([built.mp4Bytes as unknown as BlobPart], {
      type: 'video/mp4',
    });
    const blobUrl = URL.createObjectURL(blob);

    return {
      index: segIndex,
      blobUrl,
      startSec: built.startSec,
      durationSec: built.durationSec,
    };
  }

  public ensureNextSegmentPrebuffered(targetIndex: number): Promise<RemuxedSegmentItem | null> {
    const existing = this.segments.find((s) => s.index === targetIndex);
    if (existing) return Promise.resolve(existing);
    if (this.buildingPromise) return this.buildingPromise;
    if (this.eofReached && this.carryVideo.length === 0) return Promise.resolve(null);

    this.buildingPromise = (async () => {
      try {
        // Fetch 14 MB (~2.5 to 3.5 minutes of HD video) per background segment
        const CHUNK_BYTES = 14 * 1024 * 1024;
        let vCombined = [...this.carryVideo];
        let aCombined = [...this.carryAudio];
        this.carryVideo = [];
        this.carryAudio = [];

        if (!this.eofReached) {
          const rangeStart = this.nextByteOffset;
          const rangeEnd =
            this.totalFileBytes > 0
              ? Math.min(this.totalFileBytes - 1, rangeStart + CHUNK_BYTES - 1)
              : rangeStart + CHUNK_BYTES - 1;

          const res = await fetch(this.url, {
            signal: this.abortController.signal,
            headers: {
              Range: `bytes=${rangeStart}-${rangeEnd}`,
            },
          });

          if (res.ok || res.status === 206) {
            const buf = new Uint8Array(await res.arrayBuffer());
            if (this.aborted) return null;

            const parsed = parseMkvHeaderAndSamples(
              buf,
              this.tracks,
              this.timecodeScale
            );
            this.nextByteOffset = rangeStart + parsed.consumedBytes;
            if (
              buf.byteLength < CHUNK_BYTES ||
              (this.totalFileBytes > 0 && this.nextByteOffset >= this.totalFileBytes)
            ) {
              this.eofReached = true;
            }
            vCombined = vCombined.concat(parsed.videoSamples);
            aCombined = aCombined.concat(parsed.audioSamples);
          } else {
            this.eofReached = true;
          }
        }

        const seg = this.finalizeSegmentFromSamples(
          targetIndex,
          vCombined,
          aCombined
        );
        if (seg) {
          this.segments.push(seg);
          // Revoke segments older than targetIndex - 1 to keep iPhone RAM under ~20MB
          for (const old of this.segments) {
            if (old.index < targetIndex - 1 && old.blobUrl) {
              try {
                URL.revokeObjectURL(old.blobUrl);
              } catch {
                // ignore
              }
              old.blobUrl = '';
            }
          }
        }
        return seg;
      } catch {
        return null;
      } finally {
        this.buildingPromise = null;
      }
    })();

    return this.buildingPromise;
  }

  public async seekToSeconds(targetSec: number): Promise<RemuxedSegmentItem | null> {
    if (this.totalDurationSec <= 0 || this.totalFileBytes <= 0) {
      return null;
    }
    const clampedSec = Math.max(0, Math.min(this.totalDurationSec - 10, targetSec));
    const approxRatio = clampedSec / this.totalDurationSec;
    const approxByteOffset = Math.max(
      0,
      Math.floor(approxRatio * this.totalFileBytes)
    );

    const SEEK_CHUNK_BYTES = 7 * 1024 * 1024;
    const rangeEnd = Math.min(
      this.totalFileBytes - 1,
      approxByteOffset + SEEK_CHUNK_BYTES - 1
    );

    const res = await fetch(this.url, {
      signal: this.abortController.signal,
      headers: {
        Range: `bytes=${approxByteOffset}-${rangeEnd}`,
      },
    });

    if (!res.ok && res.status !== 206) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    if (this.aborted) return null;

    const parsed = parseMkvHeaderAndSamples(
      buf,
      this.tracks,
      this.timecodeScale
    );
    this.nextByteOffset = approxByteOffset + parsed.consumedBytes;
    this.eofReached = this.nextByteOffset >= this.totalFileBytes;

    const firstKfIdx = parsed.videoSamples.findIndex((s) => s.keyframe);
    if (firstKfIdx === -1) return null;

    const cutPts = parsed.videoSamples[firstKfIdx].ptsMs;
    const vSamples = parsed.videoSamples.slice(firstKfIdx);
    const aSamples = parsed.audioSamples.filter((a) => a.ptsMs >= cutPts - 20);

    // Clear old segments
    for (const old of this.segments) {
      if (old.blobUrl) {
        try {
          URL.revokeObjectURL(old.blobUrl);
        } catch {
          // ignore
        }
        old.blobUrl = '';
      }
    }
    this.segments = [];

    const newIdx = Math.floor(Date.now() % 100000);
    const seg = this.finalizeSegmentFromSamples(newIdx, vSamples, aSamples);
    if (seg) {
      this.segments.push(seg);
      this.ensureNextSegmentPrebuffered(newIdx + 1);
    }
    return seg;
  }
}
