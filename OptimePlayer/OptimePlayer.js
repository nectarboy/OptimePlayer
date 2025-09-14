/** GLOBALS GO HERE **/
let g_debug = false;

let g_enableStereoSeparation = false;
let g_enableForceStereoSeparation = false;
let g_enableCustomRNGSeed = false;
let g_lastUsedRNGSeed = 0;
let g_customRNGSeed = 0;
let g_enableRedundantCarryOverBug = false;
let g_useHardwareAccurateTuning = false;
let g_useAccurateMixing = false;
let g_usePureTuning = false;
let g_pureTuningTonic = 0;

// Global metrics
let g_instrumentsAdvanced = 0;
let g_samplesConsidered = 0;

/** @type {Controller | null} */
let g_currentController = null;
/** @type {FsVisController | null} */
let currentFsVisController = null;
/** @type {bool} */
let g_playbackPaused = false;
/** @type {string | null} */
let g_currentlyPlayingName = null;
/** @type {Sdat | null} */
let g_currentlyPlayingSdat = null;
/** @type {number} */
let g_currentlyPlayingId = 0;
/** @type {number} */
let g_currentlyPlayingSubId = 0;
/** @type {bool} */
let g_currentlyPlayingIsSsar = false;
/** @type {AudioPlayer | null} */
let g_currentPlayer = null;

/** @type {boolean[]} */
let g_trackEnables = new Array(16).fill(true);

/**
 * @param {string} name
 * @param {BlobPart} array
 */
function downloadUint8Array(name, array) {
    let blob = new Blob([array], {type: "application/octet-stream"});
    let link = document.createElement('a');
    link.href = window.URL.createObjectURL(blob);
    link.download = name;
    link.click();
}

//@ts-check
class WavEncoder {
    /**
     * @param {number} sampleRate
     * @param {number} bits
     */
    constructor(sampleRate, bits) {
        this.sampleRate = sampleRate;
        this.bits = bits;

        if (bits % 8 !== 0) {
            alert("WavDownloader.constructor: bits not multiple of 8:" + bits);
        }
    }

    recordBuffer = new Uint8ClampedArray(32);
    recordBufferAt = 0;

    /**
     * @param left {number}
     * @param right {number}
     */
    addSample(left, right) {
        if (this.recordBufferAt + 16 > this.recordBuffer.length) {
            const oldBuf = this.recordBuffer;
            this.recordBuffer = new Uint8ClampedArray(this.recordBufferAt * 2);
            this.recordBuffer.set(oldBuf);
        }

        switch (this.bits) {
            case 8:
                this.recordBuffer[this.recordBufferAt++] = clamp(Math.round(((left + 1) / 2) * 255), 0, 255);
                this.recordBuffer[this.recordBufferAt++] = clamp(Math.round(((right + 1) / 2) * 255), 0, 255);
                break;
            case 16:
                const out0_16bit = clamp(Math.round(left * 32767), -32768, 32767);
                const out1_16bit = clamp(Math.round(right * 32767), -32768, 32767);
                this.recordBuffer[this.recordBufferAt++] = out0_16bit & 0xFF;
                this.recordBuffer[this.recordBufferAt++] = (out0_16bit >> 8) & 0xFF;
                this.recordBuffer[this.recordBufferAt++] = out1_16bit & 0xFF;
                this.recordBuffer[this.recordBufferAt++] = (out1_16bit >> 8) & 0xFF;
                break;
        }

    }

    encode() {
        // Allocate exactly enough for a WAV header
        const wave = new Uint8Array(this.recordBufferAt + 44);

        // RIFF header
        wave[0] = 0x52;
        wave[1] = 0x49;
        wave[2] = 0x46;
        wave[3] = 0x46;

        const size = wave.length - 8;
        wave[4] = (size >> 0) & 0xFF;
        wave[5] = (size >> 8) & 0xFF;
        wave[6] = (size >> 16) & 0xFF;
        wave[7] = (size >> 24) & 0xFF;

        // WAVE
        wave[8] = 0x57;
        wave[9] = 0x41;
        wave[10] = 0x56;
        wave[11] = 0x45;

        // Subchunk1ID "fmt "
        wave[12] = 0x66;
        wave[13] = 0x6d;
        wave[14] = 0x74;
        wave[15] = 0x20;

        // Subchunk1Size
        wave[16] = 16;
        wave[17] = 0;
        wave[18] = 0;
        wave[19] = 0;

        // AudioFormat
        wave[20] = 1;
        wave[21] = 0;

        // 2 channels
        wave[22] = 2;
        wave[23] = 0;

        // Sample rate
        wave[24] = (this.sampleRate >> 0) & 0xFF;
        wave[25] = (this.sampleRate >> 8) & 0xFF;
        wave[26] = (this.sampleRate >> 16) & 0xFF;
        wave[27] = (this.sampleRate >> 24) & 0xFF;

        // ByteRate
        // SampleRate & NumChannels * BitsPerSample/8
        const byteRate = this.sampleRate * 2 * (this.bits / 8);
        wave[28] = (byteRate >> 0) & 0xFF;
        wave[29] = (byteRate >> 8) & 0xFF;
        wave[30] = (byteRate >> 16) & 0xFF;
        wave[31] = (byteRate >> 24) & 0xFF;

        // BlockAlign
        // NumChannels * BitsPerSample / 8
        const blockAlign = 2 * (this.bits / 8);
        wave[32] = (blockAlign >> 0) & 0xFF;
        wave[33] = (blockAlign >> 8) & 0xFF;

        // BitsPerSample
        wave[34] = this.bits;
        wave[35] = 0;

        // Subchunk2ID "data"
        wave[36] = 0x64;
        wave[37] = 0x61;
        wave[38] = 0x74;
        wave[39] = 0x61;

        // NumSamples * NumChannels * BitsPerSample/8
        const subchunk2Size = this.recordBufferAt * 2 * (this.bits / 8);
        wave[40] = (subchunk2Size >> 0) & 0xFF;
        wave[41] = (subchunk2Size >> 8) & 0xFF;
        wave[42] = (subchunk2Size >> 16) & 0xFF;
        wave[43] = (subchunk2Size >> 24) & 0xFF;

        for (let i = 0; i < this.recordBufferAt; i++) {
            wave[44 + i] = this.recordBuffer[i];
        }

        return wave;
    }
}

function fixAudioContext() {
    console.log("Fixing iOS audio context...");
    if (g_currentPlayer == null) throw new Error();

    // Create empty buffer
    let buffer = g_currentPlayer.ctx.createBuffer(1, 1, 22050);

    /** @type {any} */
    let source = g_currentPlayer.ctx.createBufferSource();
    source.buffer = buffer;
    // Connect to output (speakers)
    source.connect(g_currentPlayer.ctx.destination);
    // Play sound
    if (source.start) {
        source.start(0);
    } else if (source.play) {
        source.play(0);
    } else if (source.noteOn) {
        source.noteOn(0);
    }
}

class AudioPlayer {
    bufferLength;
    sampleRate;
    needMoreSamples;

    bufferPool;
    bufferPoolAt = 0;

    safariHax = false;

    /**
     * @param {number} bufferLength
     * @param {Function} needMoreSamples
     * @param {number | null} sampleRate
     */
    constructor(bufferLength, needMoreSamples, sampleRate) {
        if (!AudioBuffer.prototype.copyToChannel) this.safariHax = true;

        this.bufferLength = bufferLength;
        this.needMoreSamples = needMoreSamples;
        this.shouldEndPlaybackAfter = false;
        this.onEndedPlayback = function() {};

        const AudioContext = window.AudioContext   // Normal browsers
            //@ts-ignore
            || window.webkitAudioContext; // Sigh... Safari

        if (sampleRate) {
            this.ctx = new AudioContext({sampleRate: sampleRate});
        } else {
            this.ctx = new AudioContext();
        }
        this.sampleRate = this.ctx.sampleRate;

        this.bufferPool = this.genBufferPool(256, this.bufferLength);

        // iOS 6-8
        document.addEventListener('touchstart', fixAudioContext);
        // iOS 9
        document.addEventListener('touchend', fixAudioContext);

        this.gain = this.ctx.createGain();
        this.gain.gain.value = 1;
        this.gain.connect(this.ctx.destination);
    }

    gain;

    /** @type {AudioContext} */
    ctx;
    sourcesPlaying = 0;

    /**
     * @param {number} count
     * @param {number} length
     */
    genBufferPool(count, length) {
        let pool = new Array(count);
        for (let i = 0; i < count; i++) {
            pool[i] = this.ctx.createBuffer(2, length, this.sampleRate);
        }
        return pool;
    }

    /**
     * @param {Float64Array} bufferLeft
     * @param {Float64Array} bufferRight
     */
    queueAudio(bufferLeft, bufferRight) {
        let buffer = this.bufferPool[this.bufferPoolAt];
        this.bufferPoolAt++;
        this.bufferPoolAt &= 255;

        buffer.getChannelData(0).set(bufferLeft);
        buffer.getChannelData(1).set(bufferRight);

        let bufferSource = this.ctx.createBufferSource();

        bufferSource.onended = () => {
            if (this.shouldEndPlaybackAfter) {
                let player = this;
                this.ctx.onended = () => {
                    player.ctx.close();
                    player.onEndedPlayback();
                }
                return;
            }

            this.sourcesPlaying--;
            if (this.sourcesPlaying < 6) {
                this.needMoreSamples();
            }
            if (this.sourcesPlaying < 4) {
                this.needMoreSamples();
            }
        };

        if (this.audioSec <= this.ctx.currentTime + 0.05) {
            // Reset time if close to buffer underrun

            console.warn("AudioPlayer: fell behind, dropping time");
            this.audioSec = this.ctx.currentTime + 0.06;
        }
        bufferSource.buffer = buffer;
        bufferSource.connect(this.gain);
        bufferSource.start(this.audioSec);

        this.audioSec += this.bufferLength / this.sampleRate;

        this.sourcesPlaying++;

        // prevent dropouts when starting synthesis
        if (this.sourcesPlaying < 6) {
            this.needMoreSamples();
        }
        if (this.sourcesPlaying < 5) {
            this.needMoreSamples();
        }
    }

    audioSec = 0;

    reset() {
        // 50 ms buffer
        this.audioSec = this.ctx.currentTime + 0.06;
        // console.log(`Latency in seconds: ${(LATENCY / this.sampleRate)}`)
    }
}

/**
 * Creates a DataView that views an ArrayBuffer relative to another DataView.
 * @param {DataView} other
 * @param {number} offset
 * @param {number} [length]
 * @returns {DataView}
 */
function createRelativeDataView(other, offset, length) {
    return new DataView(other.buffer, other.byteOffset + offset, length);
}

/**
 * Checks if an offset is out of the bounds of a DataView.
 * @param {DataView} view
 * @param {number} offset
 * @returns {boolean}
 */
function dataViewOutOfBounds(view, offset) {
    return offset > view.byteLength;
}

/**
 * @param {DataView} data
 * @param {number} addr
 */
function read8(data, addr) {
    return data.getUint8(addr);
}

/**
 * @param {DataView} data
 * @param {number} addr
 */
function read16LE(data, addr) {
    return data.getUint16(addr, true);
}

/**
 * @param {DataView} data
 * @param {number} addr
 */
function read32LE(data, addr) {
    return data.getUint32(addr, true);
}

/**
 *
 * @param n {string}
 * @param width {number}
 * @param z {string}
 * @returns {string}
 */
function pad(n, width, z) {
    z = z || '0';
    n = n + '';
    return n.length >= width ? n : new Array(width - n.length + 1).join(z) + n;
}

/**
 *
 * @param i {number}
 * @param digits {number}
 * @returns {string}
 */
function hex(i, digits) {
    return `0x${pad(i.toString(16), digits, '0').toUpperCase()}`;
}

/**
 *
 * @param i {number}
 * @param digits {number}
 * @returns {string}
 */
function hexN(i, digits) {
    return pad(i.toString(16), digits, '0').toUpperCase();
}

/** @template T */
class CircularBuffer {
    /** @param {number} size */
    constructor(size) {
        this.size = size;
        /** @type T[] */
        this.buffer = new Array(size);

        this.entries = 0;
        this.readPos = 0;
        this.writePos = 0;
    }

    /** @param {T} data */
    insert(data) {
        if (this.entries < this.size) {
            this.entries++;
            this.buffer[this.writePos++] = data;

            if (this.writePos >= this.size) {
                this.writePos = 0;
            }

            return true;
        }

        throw "CircularBuffer: overflow";
    }

    /** @returns {T} */
    pop() {
        let data;
        if (this.entries > 0) {
            this.entries--;
            data = this.buffer[this.readPos++];

            if (this.readPos >= this.size) {
                this.readPos = 0;
            }
        } else {
            throw "CircularBuffer: underflow";
        }
        return data;
    }

    /**
     * @returns {T}
     * @param {number} offset
     */
    peek(offset) {
        return this.buffer[(this.readPos + offset) % this.size];
    }

    reset() {
        this.entries = 0;
        this.readPos = 0;
        this.writePos = 0;
    }
}

class SseqInfo {
    constructor() {
        /** @type {number | null} */
        this.fileId = null;
        /** @type {number | null} */
        this.bank = null;
        /** @type {number | null} */
        this.volume = null;
        /** @type {number | null} */
        this.cpr = null; // what the hell does this mean?
        /** @type {number | null} */
        this.ppr = null; // what the hell does this mean?
        /** @type {number | null} */
        this.ply = null; // what the hell does this mean?
    }
}

class SsarInfo {
    constructor() {
        /** @type {number | null} */
        this.fileId = null;
    }
}

/**
 * Info for an instrument bank.
 * Refers to up to 4 sound archives.
 */
class BankInfo {
    constructor() {
        /** @type {number | null} */
        this.fileId = null;
        this.swarId = new Uint16Array(4);
    }
}

class SwarInfo {
    constructor() {
        /** @type {number | null} */
        this.fileId = null;
    }
}

class StrmInfo {
    constructor() {
        /** @type {number | null} */
        this.fileId = null;
    };
}

class Sdat {
    constructor() {
        this.rawView = null;

        /**
         * @type {number[]}
         */
        this.sseqList = [];
        this.ssarList = [];
        this.strmList = [];

        /** @type {(SseqInfo | null)[]} */
        this.sseqInfos = [];
        this.sseqNameIdDict = new Map();
        this.sseqIdNameDict = new Map();
        this.ssarNameIdDict = new Map();
        this.ssarIdNameDict = new Map();
        this.ssarSseqSymbols = [];
        this.sbnkNameIdDict = new Map();
        this.sbnkIdNameDict = new Map();
        this.strmNameIdDict = new Map();
        this.strmIdNameDict = new Map();

        /** @type {(SsarInfo | null)[]} */
        this.ssarInfos = [];

        /** @type {(BankInfo | null)[]} */
        this.sbnkInfos = [];

        /** @type {(SwarInfo | null)[]} */
        this.swarInfos = [];

        /** @type {(StrmInfo | null)[]} */
        this.strmInfos = [];

        /** @type {InstrumentBank[]} */
        this.instrumentBanks = new Array(128);

        /** @type {Map<number, Sample[]>} */
        this.sampleArchives = new Map();

        /** @type {Map<number, DataView>} */
        this.fat = new Map();
    }

    /**
     * @param {DataView} view
     * @returns {Sdat[]}
     */
    static loadAllFromDataView(view) {
        let sdats = [];
        console.log(`ROM size: ${view.byteLength} bytes`);

        let sequence = [0x53, 0x44, 0x41, 0x54]; // "SDAT", then byte order 0xFEFF, then version 0x0100
        let res = searchDataViewForSequence(view, sequence);
        if (res.length > 0) {
            console.log(`Found SDATs at:`);
            for (let i = 0; i < res.length; i++) {
                console.log(hex(res[i], 8));
            }
        } else {
            console.log(`Couldn't find SDAT (maybe not an NDS ROM?)`);
        }

        let uncompressedSdats = [];
        let compressedSdats = [];
        for (let i = 0; i < res.length; i++) {
            let sdatView = createRelativeDataView(view, res[i]);

            let sdat = Sdat.parseFromDataView(sdatView);
            if (sdat != null) {
                uncompressedSdats.push(sdat);
            }
            else {
                console.log("SDAT misfigured; checking if it's compressed");
                sdatView = Sdat.getDecompressedSdatView(view, res[i] - 5); // LZSS Start?

                if (sdatView === null)
                    continue;

                sdat = Sdat.parseFromDataView(sdatView);
                if (sdat != null) {
                    compressedSdats.push(sdat);
                }
            }
        }

        return uncompressedSdats.concat(compressedSdats);
    }

    static getDecompressedSdatView(view, src) {
        if (src < 0)
            return null;

        switch (read8(view, src)) {
            // LZSS
            case 0x10: {
                console.log("Compression type: LZSS");

                let uncompSize = read32LE(view, src) >>> 8;
                console.log("Uncompressed Size: " + uncompSize);

                let out = new Uint8Array(uncompSize);
                let outOffs = 0;
                src += 4;

                let flags = 0;
                let flagcount = 0;
                function collectFlags() {
                    flags = read8(view, src);
                    flagcount = 8;
                    src += 1;
                }

                collectFlags();
                while (outOffs < uncompSize) {
                    if (flagcount === 0)
                        collectFlags();
                    flags <<= 1;
                    flagcount--;

                    if ((flags & 0x100) === 0) {
                        out[outOffs++] = read8(view, src++);
                    }
                    else {
                        let len = 3 + (read8(view, src) >> 4);
                        let disp = 1 + (read8(view, src) & 0xf) * 0x100 + read8(view, src + 1);
                        src += 2;
                        for (let i = 0; i < len; i++) {
                            out[outOffs] = out[outOffs - disp];
                            outOffs++;
                        }
                    }
                }
                        
                return new DataView(out.buffer);
                break;
            }
            default:
                return null;
        }
    }

    /**
     * @param {DataView} view - Takes ownership
     */
    static parseFromDataView(view) {
        let sdat = new Sdat();
        sdat.rawView = view;

        const magicSequence = [0xFF, 0xFE, 0x00, 0x01];
        for (let i = 0; i < magicSequence.length; i++) {
            if (read8(view, 4 + i) !== magicSequence[i]) {
                console.log("Invalid SDAT magic, rejecting SDAT.");
                return null;
            }
        }

        console.log("Parsing SDAT...");
        console.log("SDAT file size: " + view.byteLength);

        let numOfBlocks = read16LE(view, 0xE);
        let headerSize = read16LE(view, 0xC);

        console.log("Number of Blocks: " + numOfBlocks);
        console.log("Header Size: " + headerSize);

        let symbOffs = read32LE(view, 0x10);
        let symbSize = read32LE(view, 0x14);
        let sdatHasSymbBlock = symbOffs !== 0 && symbSize !== 0;
        let infoOffs = read32LE(view, 0x18);
        let infoSize = read32LE(view, 0x1C);
        let fatOffs = read32LE(view, 0x20);
        let fatSize = read32LE(view, 0x24);
        let fileOffs = read32LE(view, 0x28);
        let fileSize = read32LE(view, 0x2C);

        if (headerSize !== 64) {
            if (headerSize === 16384)
                console.log("Invalid SDAT header (probably LZSS compressed), rejecting SDAT.");
            else
                console.log("Invalid SDAT header, rejecting SDAT.");
            return null;
        }

        console.log("SYMB Block Offset: " + hexN(symbOffs, 8));
        console.log("SYMB Block Size: " + hexN(symbSize, 8));
        console.log("INFO Block Offset: " + hexN(infoOffs, 8));
        console.log("INFO Block Size: " + hexN(infoSize, 8));
        console.log("FAT  Block Offset: " + hexN(fatOffs, 8));
        console.log("FAT  Block Size: " + hexN(fatSize, 8));
        console.log("FILE Block Offset: " + hexN(fileOffs, 8));
        console.log("FILE Block Size: " + hexN(fileSize, 8));

        let infoView = createRelativeDataView(view, infoOffs, infoSize);
        let fatView = createRelativeDataView(view, fatOffs, fatSize);
        let fileView = createRelativeDataView(view, fileOffs, fileSize);

        // SYMB processing
        function readCString(view, start) {
            let str = '';
            let offs = 0;

            // Read C string from symbol
            let char;
            do {
                char = read8(view, start + offs++);
                if (char !== 0) {
                    str += String.fromCharCode(char);
                }
            } while (char !== 0);

            return str;
        }

        if (sdatHasSymbBlock) {
            let symbView = createRelativeDataView(view, symbOffs, symbSize);
            {
                // SSEQ symbols
                let symbSseqListOffs = read32LE(symbView, 0x8);
                if (symbSseqListOffs !== 0) {
                    if (dataViewOutOfBounds(symbView, symbSseqListOffs)) {
                        console.log("SSEQ num entries pointer is out of bounds, rejecting SDAT.")
                        return;
                    }
                    let symbSseqListNumEntries = read32LE(symbView, symbSseqListOffs);

                    console.log("SYMB Bank List Offset: " + hexN(symbSseqListOffs, 8));
                    console.log("SYMB Number of SSEQ entries: " + symbSseqListNumEntries);

                    for (let i = 0; i < symbSseqListNumEntries; i++) {
                        let sseqNameOffs = read32LE(symbView, symbSseqListOffs + 4 + i * 4);

                        // for some reason games have a ton of empty symbols -- skip them
                        if (sseqNameOffs !== 0) {
                            let seqName = readCString(symbView, sseqNameOffs);

                            sdat.sseqNameIdDict.set(seqName, i);
                            sdat.sseqIdNameDict.set(i, seqName);
                        }
                    }
                }
            }

            {
                // SSAR symbols
                let symbSsarListOffs = read32LE(symbView, 0xC);
                if (symbSsarListOffs !== 0) {
                    let symbSsarListNumEntries = read32LE(symbView, symbSsarListOffs);

                    console.log("SYMB Number of SSAR entries: " + symbSsarListNumEntries);

                    sdat.ssarSseqSymbols.length = 0;
                    for (let i = 0; i < symbSsarListNumEntries; i++) {
                        let ssarNameOffs = read32LE(symbView, symbSsarListOffs + i * 8 + 4);

                        // for some reason games have a ton of empty symbols -- skip them
                        if (ssarNameOffs !== 0) {
                            let ssarName = readCString(symbView, ssarNameOffs);

                            sdat.ssarNameIdDict.set(ssarName, i);
                            sdat.ssarIdNameDict.set(i, ssarName);
                        }

                        // Sub-SSEQ symbols for this SSAR
                        let symbSsarSseqListOffs = read32LE(symbView, symbSsarListOffs + i*8 + 8);
                        let symbSsarSseqListNumEntries = read32LE(symbView, symbSsarSseqListOffs);
                        if (symbSsarSseqListNumEntries) {
                            sdat.ssarSseqSymbols[i] = {
                                ssarSseqNameIdDict: new Map(),
                                ssarSseqIdNameDict: new Map()
                            };
                        }
                        else {
                            sdat.ssarSseqSymbols[i] = null;
                        }
                        //console.log("SYMB Number of Sub-SSEQ entries for SSAR_" + i + ": " + symbSsarSseqListNumEntries);

                        for (let ii = 0; ii < symbSsarSseqListNumEntries; ii++) {
                            try {
                                let ssarSseqNameOffs = read32LE(symbView, symbSsarSseqListOffs + 4 + ii*4);

                                // for some reason games have a ton of empty symbols -- skip them
                                if (ssarSseqNameOffs !== 0) {
                                    let ssarSeqName = readCString(symbView, ssarSseqNameOffs);

                                    sdat.ssarSseqSymbols[i].ssarSseqNameIdDict.set(ssarSeqName, ii);
                                    sdat.ssarSseqSymbols[i].ssarSseqIdNameDict.set(ii, ssarSeqName);
                                }
                            }
                            catch(e) {
                                break;
                            }
                        }
                    }
                }
            }

            {
                // BANK symbols
                let symbBankListOffs = read32LE(symbView, 0x10);
                if (symbBankListOffs !== 0) {
                    let symbBankListNumEntries = read32LE(symbView, symbBankListOffs);

                    console.log("SYMB Bank List Offset: " + hexN(symbBankListOffs, 8));
                    console.log("SYMB Number of BANK entries: " + symbBankListNumEntries);

                    for (let i = 0; i < symbBankListNumEntries; i++) {
                        let bankNameOffs = read32LE(symbView, symbBankListOffs + 4 + i * 4);
                        if (i === 0) console.log("NDS file addr of BANK list 1st entry: " + hexN(view.byteOffset + symbOffs + bankNameOffs, 8));

                        // for some reason games have a ton of empty symbols -- skip them
                        if (bankNameOffs !== 0) {
                            let bankName = readCString(symbView, bankNameOffs);

                            sdat.sbnkNameIdDict.set(bankName, i);
                            sdat.sbnkIdNameDict.set(i, bankName);
                        }
                    }
                }
            }

            {
                // SWAR symbols (TODO)
                let symbSwarListOffs = read32LE(symbView, 0x14);
                let symbSwarListNumEntries = read32LE(symbView, symbSwarListOffs);

                console.log("SYMB Number of SWAR entries: " + symbSwarListNumEntries);
            }

            {
                // STRM symbols
                let symbStrmListOffs = read32LE(symbView, 0x24);
                if (symbStrmListOffs !== 0) {
                    let symbStrmListNumEntries = read32LE(symbView, symbStrmListOffs);

                    console.log("SYMB Bank List Offset: " + hexN(symbStrmListOffs, 8));
                    console.log("SYMB Number of STRM entries: " + symbStrmListNumEntries);

                    for (let i = 0; i < symbStrmListNumEntries; i++) {
                        let strmNameOffs = read32LE(symbView, symbStrmListOffs + 4 + i * 4);

                        // for some reason games have a ton of empty symbols -- skip them
                        if (strmNameOffs !== 0) {
                            let strmName = readCString(symbView, strmNameOffs);

                            sdat.strmNameIdDict.set(strmName, i);
                            sdat.strmIdNameDict.set(i, strmName);
                        }
                    }
                }
            }
        }

        // INFO processing
        {
            // SSEQ info
            let infoSseqListOffs = read32LE(infoView, 0x8);
            let infoSseqListNumEntries = read32LE(infoView, infoSseqListOffs);
            console.log("INFO Number of SSEQ entries: " + infoSseqListNumEntries);

            for (let i = 0; i < infoSseqListNumEntries; i++) {
                let infoSseqNameOffs = read32LE(infoView, infoSseqListOffs + 4 + i * 4);

                if (infoSseqNameOffs !== 0) {
                    let info = new SseqInfo();
                    info.fileId = read16LE(infoView, infoSseqNameOffs + 0);
                    info.bank = read16LE(infoView, infoSseqNameOffs + 4);
                    info.volume = read8(infoView, infoSseqNameOffs + 6);
                    info.cpr = read8(infoView, infoSseqNameOffs + 7);
                    info.ppr = read8(infoView, infoSseqNameOffs + 8);
                    info.ply = read8(infoView, infoSseqNameOffs + 9);

                    sdat.sseqInfos[i] = info;
                    sdat.sseqList.push(i);
                } else {
                    sdat.sseqInfos[i] = null;
                }
            }
        }

        {
            // SSAR info
            let infoSsarListOffs = read32LE(infoView, 0xC);
            let infoSsarListNumEntries = read32LE(infoView, infoSsarListOffs);
            console.log("INFO Number of SSAR entries: " + infoSsarListNumEntries);

            for (let i = 0; i < infoSsarListNumEntries; i++) {
                let infoSsarNameOffs = read32LE(infoView, infoSsarListOffs + 4 + i * 4);

                if (infoSsarNameOffs !== 0) {
                    let info = new SsarInfo();
                    try {
                        info.fileId = read16LE(infoView, infoSsarNameOffs + 0);

                        sdat.ssarInfos[i] = info;
                        sdat.ssarList.push(i);
                    }
                    catch (e) {
                        sdat.ssarInfos[i] = null;
                    }
                } else {
                    sdat.ssarInfos[i] = null;
                }
            }
        }

        {
            // BANK info
            let infoBankListOffs = read32LE(infoView, 0x10);
            let infoBankListNumEntries = read32LE(infoView, infoBankListOffs);
            console.log("INFO Number of BANK entries: " + infoBankListNumEntries);

            for (let i = 0; i < infoBankListNumEntries; i++) {
                let infoBankNameOffs = read32LE(infoView, infoBankListOffs + 4 + i * 4);

                if (infoBankNameOffs !== 0) {
                    let info = new BankInfo();
                    info.fileId = read16LE(infoView, infoBankNameOffs + 0x0);
                    info.swarId[0] = read16LE(infoView, infoBankNameOffs + 0x4);
                    info.swarId[1] = read16LE(infoView, infoBankNameOffs + 0x6);
                    info.swarId[2] = read16LE(infoView, infoBankNameOffs + 0x8);
                    info.swarId[3] = read16LE(infoView, infoBankNameOffs + 0xA);

                    sdat.sbnkInfos[i] = info;
                } else {
                    sdat.sbnkInfos[i] = null;
                }
            }
        }

        {
            // SWAR info
            let infoSwarListOffs = read32LE(infoView, 0x14);
            let infoSwarListNumEntries = read32LE(infoView, infoSwarListOffs);
            console.log("INFO Number of SWAR entries: " + infoSwarListNumEntries);

            for (let i = 0; i < infoSwarListNumEntries; i++) {
                let infoSwarNameOffs = read32LE(infoView, infoSwarListOffs + 4 + i * 4);

                if (infoSwarNameOffs) {
                    let info = new SwarInfo();
                    info.fileId = read16LE(infoView, infoSwarNameOffs + 0x0);

                    sdat.swarInfos[i] = info;
                } else {
                    sdat.swarInfos[i] = null;
                }
            }
        }

        {
            // STRM info
            let infoStrmListOffs = read32LE(infoView, 0x24);
            if (infoStrmListOffs !== 0) {
                let infoStrmListNumEntries = read32LE(infoView, infoStrmListOffs);
                console.log("INFO Number of STRM entries: " + infoStrmListNumEntries);

                for (let i = 0; i < infoStrmListNumEntries; i++) {
                    let infoStrmRecOffs = read32LE(infoView, infoStrmListOffs + 4 + i * 4);

                    if (infoStrmRecOffs) {
                        let info = new StrmInfo();
                        info.fileId = read16LE(infoView, infoStrmRecOffs + 0x0);

                        sdat.strmInfos[i] = info;
                        sdat.strmList.push(i);
                    } else {
                        sdat.strmInfos[i] = null;
                    }
                }
            }
        }

        // FAT / FILE processing
        let fatNumFiles = read32LE(fatView,8);
        console.log("FAT Number of files: " + fatNumFiles);

        for (let i = 0; i < fatNumFiles; i++) {
            let fileEntryOffs = 0xC + i * 0x10;

            let fileDataOffs = read32LE(fatView, fileEntryOffs);
            let fileSize = read32LE(fatView, fileEntryOffs + 4);

            sdat.fat.set(i, createRelativeDataView(view, fileDataOffs, fileSize));
        }

        // Decode sound banks
        for (let i = 0; i < sdat.sbnkInfos.length; i++) {
            let bank = new InstrumentBank();

            let bankInfo = sdat.sbnkInfos[i];

            if (bankInfo !== null) {
                if (bankInfo.fileId == null) throw new Error();
                let bankFile = sdat.fat.get(bankInfo.fileId);
                if (bankFile == null) throw new Error();

                let numberOfInstruments = read32LE(bankFile, 0x38);
                if (g_debug)
                    console.log(`Bank ${i} / ${sdat.sbnkIdNameDict.get(i)}: ${numberOfInstruments} instruments`);
                for (let j = 0; j < numberOfInstruments; j++) {
                    let fRecord = read8(bankFile, 0x3C + j * 4);
                    let recordOffset = read16LE(bankFile, 0x3C + j * 4 + 1);

                    let instrument = new InstrumentRecord();
                    instrument.fRecord = fRecord;

                    /**
                     * @param {number} index
                     * @param {number} offset
                     */
                    function readRecordData(index, offset) {
                        if (bankFile == null) throw new Error();
                        instrument.swavInfoId[index] = read16LE(bankFile, recordOffset + 0x0 + offset);
                        instrument.swarInfoId[index] = read16LE(bankFile, recordOffset + 0x2 + offset);
                        instrument.noteNumber[index] = read8(bankFile, recordOffset + 0x4 + offset);
                        instrument.attack[index] = read8(bankFile, recordOffset + 0x5 + offset);
                        instrument.attackCoefficient[index] = getEffectiveAttack(instrument.attack[index]);
                        instrument.decay[index] = read8(bankFile, recordOffset + 0x6 + offset);
                        instrument.decayCoefficient[index] = CalcDecayCoeff(instrument.decay[index]);
                        instrument.sustain[index] = read8(bankFile, recordOffset + 0x7 + offset);
                        instrument.sustainLevel[index] = getSustainLevel(instrument.sustain[index]);
                        instrument.release[index] = read8(bankFile, recordOffset + 0x8 + offset);
                        instrument.releaseCoefficient[index] = CalcDecayCoeff(instrument.release[index]);
                        instrument.pan[index] = read8(bankFile, recordOffset + 0x9 + offset);
                    }

                    switch (fRecord) {
                        case 0: // Empty
                            break;

                        case InstrumentType.SingleSample: // Sample
                        case InstrumentType.PsgPulse: // PSG Pulse
                        case InstrumentType.PsgNoise: // PSG Noise
                            instrument.instrumentTypes[0] = fRecord;
                            readRecordData(0, 0);
                            break;

                        case InstrumentType.Drumset: // Drumset
                        {
                            let instrumentCount = read8(bankFile, recordOffset + 1) - read8(bankFile, recordOffset) + 1;

                            instrument.lowerNote = read8(bankFile, recordOffset + 0);
                            instrument.upperNote = read8(bankFile, recordOffset + 1);

                            for (let k = 0; k < instrumentCount; k++) {
                                instrument.instrumentTypes[k] = read8(bankFile, recordOffset + k * 12 + 8);
                                readRecordData(k, 4 + k * 12);
                            }
                            break;
                        }
                        case InstrumentType.MultiSample: // Multi-Sample Instrument
                        {
                            let instrumentCount = 0;

                            for (let k = 0; k < 8; k++) {
                                let end = read8(bankFile, recordOffset + k);
                                instrument.regionEnd[k] = end;
                                if (end === 0) {
                                    instrumentCount = k;
                                    break;
                                } else if (end === 0x7F) {
                                    instrumentCount = k + 1;
                                    break;
                                }
                            }

                            for (let k = 0; k < instrumentCount; k++) {
                                instrument.instrumentTypes[k] = read8(bankFile, recordOffset + k * 12 + 8);
                                readRecordData(k, 10 + k * 12);
                            }
                            break;
                        }

                        default:
                            console.warn(`Instrument ${j}: Invalid fRecord: ${fRecord} Offset:${recordOffset}`);
                            break;
                    }

                    bank.instruments[j] = instrument;
                }

                sdat.instrumentBanks[i] = bank;
            }
        }

        return sdat;
    }

    getNumOfEntriesInSeqArc(ssarId) {
        return read32LE(this.fat.get(this.ssarInfos[ssarId].fileId), 28);
    }
}

class Message {
    /**
     * @param {boolean} fromKeyboard
     * @param {number} channel
     * @param {number} type
     * @param {number} param0
     * @param {number} param1
     * @param {number} param2
     */
    constructor(fromKeyboard, channel, type, param0, param1, param2, param3) {
        this.fromKeyboard = fromKeyboard;
        this.trackNum = channel;
        this.type = type;
        this.param0 = param0;
        this.param1 = param1;
        this.param2 = param2;
        this.param3 = param3;
        this.timestamp = 0;
    }
}

const MessageType = {
    PlayNote: 0, // P0: MIDI Note P1: Velocity P2: Duration
    InstrumentChange: 1, // P0: Bank P1: Program
    Jump: 2,
    TrackEnded: 3,
    VolumeChange: 4, // P0: Volume
    PanChange: 5, // P0: Pan (0-127)
    PitchBend: 6
};

class Sample {
    /**
     * @param {Float64Array} data
     * @param {number} frequency
     * @param {number} sampleRate
     * @param {boolean} looping
     * @param {number} loopPoint
     *
     */
    constructor(data, frequency, sampleRate, sampleTimer, looping, loopPoint) {
        this.data = data;
        this.frequency = frequency;
        this.sampleRate = sampleRate;
        this.invSampleRate = 1 / sampleRate;
        if (sampleTimer <= 0)
            this.sampleTimer = Math.floor(33513982 / 2 / sampleRate);
        else {
            this.sampleTimer = sampleTimer;
            //console.log(sampleTimer, Math.floor(33513982 / 2 / sampleRate));
        }
        this.looping = looping;
        this.loopPoint = loopPoint;

        this.resampleMode = ResampleMode.Cubic;
        this.sampleLength = 0;
    }
}

const ResampleMode = Object.seal({
    NearestNeighbor: 0,
    Cubic: 1,
});

const InstrumentType = Object.seal({
    SingleSample: 0x1,
    PsgPulse: 0x2,
    PsgNoise: 0x3,

    Drumset: 0x10,
    MultiSample: 0x11
});

class InstrumentRecord {
    // fRecord = 0x1 - Single-Region Instrument
    // fRecord = 0x2 - PSG Pulse
    // fRecord = 0x3 - PSG Noise

    // fRecord = 0x10 - Drumset
    // fRecord = 0x11 - Multi-Region Instrument

    constructor() {
        this.fRecord = 0;

        this.lowerNote = 0;
        this.upperNote = 0;

        this.regionEnd = new Uint8Array(8);

        /** @type {number[]} */
        this.instrumentTypes = [];
        /** @type {number[]} */
        this.swavInfoId = [];
        /** @type {number[]} */
        this.swarInfoId = [];
        /** @type {number[]} */
        this.noteNumber = [];
        /** @type {number[]} */
        this.attack = [];
        /** @type {number[]} */
        this.attackCoefficient = [];
        /** @type {number[]} */
        this.decay = [];
        /** @type {number[]} */
        this.decayCoefficient = [];
        /** @type {number[]} */
        this.sustain = [];
        /** @type {number[]} */
        this.sustainLevel = [];
        /** @type {number[]} */
        this.release = [];
        /** @type {number[]} */
        this.releaseCoefficient = [];
        /** @type {number[]} */
        this.pan = [];
    }

    /**
     * @returns {number}
     * @param {number} note
     */
    resolveEntryIndex(note) {
        switch (this.fRecord) {
            case InstrumentType.SingleSample:
            case InstrumentType.PsgPulse:
            case InstrumentType.PsgNoise:
                return 0;

            case InstrumentType.Drumset:
                if (note < this.lowerNote || note > this.upperNote) {
                    console.warn(`resolveEntryIndex: drumset note out of range (${this.lowerNote}-${this.upperNote} inclusive): ${note}`);
                    return -1;
                }
                return note - this.lowerNote;

            case InstrumentType.MultiSample:
                for (let i = 0; i < 8; i++) {
                    if (note <= this.regionEnd[i]) return i;
                }
                return 7;
            default:
                throw new Error(`Invalid fRecord: ${this.fRecord}`);
        }
    }
}

// SBNK
class InstrumentBank {
    constructor() {
        /** @type {InstrumentRecord[]} */
        this.instruments = [];
    }
}

class SampleInstrument {
    /**
     * @param {SampleSynthesizer} synth
     * @param {number} instrNum
     * @param {number} sampleRate
     * @param {Sample} sample
     */
    constructor(synth, instrNum, sampleRate, sample) {
        this.instrNum = instrNum;
        this.synth = synth;
        this.sampleRate = sampleRate;
        this.nyquist = sampleRate / 2;

        this.invSampleRate = 1 / sampleRate;
        /** @type {Sample} */
        this.sample = sample;

        this.isPsg = false;
        this.psgNoise = false;
        this.psgTick = 0;

        // sampleFrequency is the sample's tone frequency when played at sampleSampleRate
        this.frequency = 440;
        this.volume = 1;

        this.playing = false;
        this.startTime = 0;
        this.midiNote = 0;

        this.t = 0;
        this.sampleT = 0;
        this.resampleT = 0;

        this.finetune = 0;
        this.finetuneLfo = 0;

        this.freqRatio = 0;

        this.output = 0;

        Object.seal(this);
    }

    advance() {
        g_instrumentsAdvanced++;
        g_samplesConsidered++;

        if (this.psgNoise) {
            let convertedSampleRate = this.frequency * 8;
            this.sampleT += this.invSampleRate * convertedSampleRate;

            // TODO: there's probably a better way to do this?
            while (this.sampleT >= 1) {
                this.output = this.updateNoiseData() * this.volume;
                this.sampleT--;
            }
        }
        else {
            let convertedSampleRate = this.freqRatio * this.sample.sampleRate;
            this.sampleT += this.invSampleRate * convertedSampleRate;

            // Linear interpolation -- could be optimized
            if (false && !this.isPsg) {
                let interp = this.sampleT % 1;
                let t0 = Math.floor(this.sampleT);
                let t1 = t0 + 1;
                this.output = (this.getSampleDataAt(t0)*(1-interp) + this.getSampleDataAt(t1)*interp) * this.volume;
            }
            else {
            // TODO: Reintroduce ResampleMode consideration here - I removed it because I wasn't satisfied with the performance of BlipBuf,
            //      and because the cubic implementation was creating clicking noises in the Pokemon BW ending music */
            // TODO: Reintroduce anti-aliased zero-order hold but with high-speed fixed-function averaging instead of BlipBuf
                this.output = this.getSampleDataAt(Math.floor(this.sampleT)) * this.volume;
            }
        }
    }

    /**
     * @param {number} t
     */
    getSampleDataAt(t) {
        if (t >= this.sample.data.length && this.sample.looping) {
            let tNoIntro = t - this.sample.loopPoint;
            let loopLength = this.sample.data.length - this.sample.loopPoint;
            tNoIntro %= loopLength;
            t = tNoIntro + this.sample.loopPoint;
        }

        if (t < this.sample.data.length) {
            return this.sample.data[t];
        } else {
            return 0;
        }
    }

    updateNoiseData() {
        if (this.psgTick & 1) {
            this.psgTick = (this.psgTick >> 1) ^ 0x6000;
            return 1;
        }
        else {
            // The fire alarm is going off at this very moment! OK im back
            this.psgTick >>= 1;
            return -1;
        }
    }

    updateFrequency() {
        if (g_useHardwareAccurateTuning && !this.isPsg) {
            var timer = midiNoteToTimer(this.sample.sampleTimer, this.midiNote, this.finetuneLfo + this.finetune);
            this.frequency = 33513982/(2*timer) * this.sample.invSampleRate;
            // if (this.isPsg)
            //     this.frequency *= midiNoteToHz(0);
            this.freqRatio = this.frequency;
        }
        else {
            this.frequency = midiNoteToHz(this.midiNote + this.finetuneLfo + this.finetune);
            if (!this.psgNoise)
                this.freqRatio = this.frequency / this.sample.frequency; // TODO: sample.frequency is a bit redundant ? idk
        }
    }

    /** @param {number} midiNote */
    setNote(midiNote) {
        this.midiNote = midiNote;
        this.updateFrequency();
    }

    /** @param {number} semitones */
    setFinetuneLfo(semitones) {
        this.finetuneLfo = semitones;
        this.updateFrequency();
    }

    /**
     * @param {number} semitones
     */
    setFinetune(semitones) {
        this.finetune = semitones;
        this.updateFrequency();
    }

    // enableNoise() {
    //     this.psgNoise = true;
    //     this.psgTick = 0x7fff;
    // }
    // disableNoise() {
    //     this.psgNoise = false;
    // }
}

class Sequence {
    /** @param {DataView} sseqFile
     *  @param {number} dataOffset
     *  @param {CircularBuffer<Message>} messageBuffer
     *  @param {Controller>} controller
     **/
    constructor(sseqFile, dataOffset, messageBuffer, controller) {
        this.sseqFile = sseqFile;
        this.dataOffset = dataOffset;
        this.messageBuffer = messageBuffer;
        this.controller = controller;
        this.parentControllerIsFsVis = false;

        /** @type {SequenceTrack[]} */
        this.vars = new Int16Array(32);
        this.tracks = new Array(16);

        for (let i = 0; i < 32; i++) {
            this.vars[i] = !(i & 7) * 0xffff; // Source: Kermalis
        }
        for (let i = 0; i < 16; i++) {
            this.tracks[i] = new SequenceTrack(this, i);
        }

        this.randomstate = 0;

        this.tracks[0].active = true;
        this.bpm = 120;

        this.ticksElapsed = 0;
        this.ticksElapsedPaused = 0;
        this.paused = false;
    }

    calcRandom() {
        this.randomstate = (0xffffffff & (this.randomstate * 1664525 + 1013904223)) >>> 0; // src: pret/pokediamond
        return this.randomstate;
    }

    tick() {
        if (!this.paused) {
            for (let i = 0; i < 16; i++) {
                if (this.tracks[i].active) {
                    while (this.tracks[i].restingFor === 0 && !this.tracks[i].restingUntilAChannelEnds) {
                        this.tracks[i].execute();
                    }
                    this.tracks[i].restingFor -= !this.tracks[i].restingUntilAChannelEnds;
                }
            }
            this.calcRandom();
            this.calcRandom();
        }
        else {
            this.ticksElapsedPaused++;
        }
        this.ticksElapsed++;
    }

    /**
     * @param {number} id
     */
    readVar(id) {
        return this.vars[id & 0x1f]; // TODO: What happens when we read OOB ?
    }
    /**
     * @param {number} id
     * @param {number} val
     */
    writeVar(id, val) {
        this.vars[id & 0x1f] = val;
    }


    /**
     * @param {number} num
     * @param {number} pc
     */
    startTrack(num, pc) {
        this.tracks[num].active = true;
        this.tracks[num].pc = pc;
        this.tracks[num].debugLog("Started! PC: " + hexN(pc, 6));
    }

    /**
     * @param {number} num
     */
    endTrack(num) {
        this.tracks[num].active = false;
        this.tracks[num].debugLog("Ended track.");
    }
}

const ParamOverride = {
    Null: 0,
    Random: 1,
    Variable: 2
};

class SequenceTrack {
    /**
     * @param {Sequence} sequence
     * @param {number} id
     */
    constructor(sequence, id) {
        /** @type {Sequence} */
        this.sequence = sequence;
        this.id = id;

        this.conditionalFlag = true;
        this.exeCommandFlag = true;
        this.paramOverride = ParamOverride.Null;
        this.restingUntilAChannelEnds = false;
        this.restingForever = false;
        this.channelWaitingFor = null;

        this.active = false;
        this.activeChannels = [];

        this.pc = 0;
        this.pan = 64;
        this.mono = true;
        this.volume = 0x7f; // TODO: does the synthesizer need to be updated accordingly ?
        this.expression = 0x7f;
        this.priority = 0;
        this.program = 0;

        this.lfoType = 0;
        this.lfoDepth = 0;
        this.lfoRange = 1;
        this.lfoSpeed = 16;
        this.lfoDelay = 0;

        this.transpose = 0;

        this.pitchBend = 0;
        this.pitchBendRange = 2;

        this.tie = false;

        this.portamentoEnable = 0;
        this.portamentoKey = 60;
        this.portamentoTime = 0;

        this.sweepPitch = 0;

        this.restingFor = 0;

        this.stack = new Uint32Array(64);
        this.loopStack = new Uint32Array(64);
        this.loopStackCount = new Uint8Array(this.loopStack.length);
        this.sp = 0;
        this.loopSp = 0;

        this.attackRate = 0xff;
        this.decayRate = 0xff;
        this.sustainRate = 0xff;
        this.releaseRate = 0xff;
    }

    /**
     * @param {string} _msg
     */
    debugLog(msg) {
        //console.log(`${this.id}: ${msg}`);
    }

    /**
     * @param {string} msg
     */
    debugLogForce(msg) {
        console.log(`${this.id}: ${msg}`);
    }

    /**
     * @param {number} val
     */
    push(val) {
        this.stack[this.sp++] = val;
        if (this.sp >= this.stack.length) alert("SSEQ stack overflow");
    }

    pop() {
        if (this.sp === 0) alert("SSEQ stack underflow");
        return this.stack[--this.sp];
    }

    pushLoop(val, count) {
        this.loopStack[this.loopSp] = val;
        this.loopStackCount[this.loopSp++] = count;
        if (this.loopSp >= this.loopStack.length) alert("SSEQ loop stack overflow");
    }

    popLoop() {
        if (this.loopSp === 0) alert("SSEQ loop stack underflow");
        var i = this.loopSp - 1;
        var val = this.loopStack[i];
        if (this.loopStackCount[i]) {
            this.loopStackCount[i]--;
            this.loopSp -= this.loopStackCount[i] === 0;
        }
        return val;
    }

    read(addr) {
        return this.sequence.sseqFile.getUint8(addr + this.sequence.dataOffset);
    }

    readPc() {
        return this.sequence.sseqFile.getUint8(this.pc + this.sequence.dataOffset);
    }

    readPcInc(bytes = 1) {
        let val = 0;
        for (let i = 0; i < bytes; i++) {
            val |= this.readPc() << (i * 8);
            this.pc++;
        }

        return val;
    }

    readVariableLength() {
        let num = 0;
        for (let i = 0; i < 4; i++) {
            let val = this.readPcInc();

            num <<= 7;
            num |= val & 0x7F;

            if ((val & 0x80) === 0) {
                break;
            }
        }

        return num;
    }

    readRandom() {
        this.paramOverride = ParamOverride.Null;
        var min = this.readPcInc(2) << 16 >> 16;
        var max = this.readPcInc(2) << 16 >> 16;

        if (max === min)
            return min;
        else {
            var val = min + Math.abs(this.sequence.calcRandom() % (max - min + 1)) * Math.sign(max - min);
            return val;
        }
        // return Math.round(Math.random() * (max - min) + min);
    }
    readVariable() {
        this.paramOverride = ParamOverride.Null;
        return this.sequence.readVar(this.readPcInc());
    }

    readLastPcInc(bytes = 1) {
        if (!this.paramOverride)
            return this.readPcInc(bytes);
        else if (this.paramOverride === ParamOverride.Random)
            return this.readRandom();
        else if (this.paramOverride === ParamOverride.Variable)
            return this.readVariable();
    }
    readLastVariableLength() {
        if (!this.paramOverride)
            return this.readVariableLength();
        else if (this.paramOverride === ParamOverride.Random)
            return this.readRandom();
        else if (this.paramOverride === ParamOverride.Variable)
            return this.readVariable();
    }

    /**
     * @param {boolean} fromKeyboard
     * @param {number} type
     * @param {number} param0
     * @param {number} param1
     * @param {number} param2
     */
    sendMessage(fromKeyboard, type, param0 = 0, param1 = 0, param2 = 0, param3 = 0) {
        this.sequence.messageBuffer.insert(new Message(fromKeyboard, this.id, type, param0, param1, param2, param3));
    }

    executeOpcode(opcode) {
        if (opcode <= 0x7F) {
            let note = opcode + this.transpose;
            if (note < 0)
                note = 0;
            else if (note > 0x7f)
                note = 0x7f;

            let velocity = this.readPcInc();
            let duration = this.readLastVariableLength();

            this.debugLog("Note: " + note);
            this.debugLog("Velocity: " + velocity);
            this.debugLog("Duration: " + duration);

            if (this.mono) {
                this.restingFor = duration;

                if (duration === 0) {
                    this.restingUntilAChannelEnds = true;
                }
            }

            if (!this.sequence.parentControllerIsFsVis)
                this.sequence.controller.playNote(this.id, note, velocity, duration);
            else
                this.sendMessage(false, MessageType.PlayNote, note, velocity, duration);
            this.portamentoKey = note;
        } else {
            switch (opcode) {
                case 0x80: // Rest
                {
                    this.restingFor = this.readLastVariableLength();
                    if (this.restingFor < 0)
                        this.restingFor = 0;
                    this.debugLog("Resting For: " + this.restingFor);
                    break;
                }
                case 0x81: // Set bank and program
                {
                    let program = this.readLastVariableLength() >>> 0;
                    this.program = program & 0x7FFF;
                    this.debugLogForce(`Program: ${this.program}`);

                    this.sendMessage(false, MessageType.InstrumentChange, this.program);
                    break;
                }
                case 0x93: // Start new track thread 
                {
                    let trackNum = this.readPcInc();
                    let trackOffs = this.readLastPcInc(3);

                    this.sequence.startTrack(trackNum, trackOffs);

                    this.debugLogForce("Started track thread " + trackNum);
                    this.debugLog("Offset: " + hex(trackOffs, 6));

                    break;
                }
                case 0x94: // Jump
                {
                    var from = this.pc;
                    let dest = this.readLastPcInc(3);
                    this.pc = dest;
                    this.debugLogForce(`Jump from ${hexN(from, 6)} to: ${hexN(dest, 6)} Tick: ${this.sequence.ticksElapsed}`);

                    this.sendMessage(false, MessageType.Jump);
                    break;
                }
                case 0x95: // Call
                {
                    let dest = this.readLastPcInc(3);

                    // Push the return address
                    this.push(this.pc);
                    this.pc = dest;
                    break;
                }
                case 0xA0: // Random
                {
                    this.debugLogForce('RANDOM, opcode is ' + hexN(this.readPc(),2));
                    this.paramOverride = ParamOverride.Random;
                    break;
                }
                case 0xA1: // Variable
                {
                    this.debugLogForce('VARIABLE, opcode is ' + hexN(this.readPc(),2));
                    this.paramOverride = ParamOverride.Variable;
                    break;
                }
                case 0xA2: // Conditional Execution
                {
                    this.debugLogForce('CONDITIONAL EXE (' + this.conditionalFlag + '), opcode is ' + hexN(this.readPc(),2));
                    if (!this.conditionalFlag)
                        this.pc += this.determineCommandLength(this.pc);
                    break;
                }
                case 0xC0: // Pan
                {
                    this.pan = this.readLastPcInc();
                    if (this.pan < 0) this.pan = 0;
                    else if (this.pan >= 127) this.pan = 128;
                    //if (this.pan === 127) this.pan = 128;
                    this.debugLog("Pan: " + this.pan);
                    this.sendMessage(false, MessageType.PanChange, this.pan);
                    break;
                }
                case 0xC1: // Volume
                {
                    this.volume = this.readLastPcInc() & 0xff;
                    if (this.volume > 0x7f)
                        this.volume = 0x7f;
                    this.sendMessage(false, MessageType.VolumeChange, this.volume, this.expression);
                    this.debugLogForce("Volume: " + this.volume);
                    break;
                }
                case 0xC2: // Master Volume
                {
                    this.masterVolume = this.readLastPcInc() & 0xff;
                    this.debugLogForce("Master Volume: " + this.masterVolume);
                    console.warn('UNIMPLEMENTED MASTER VOLUME');
                    break;
                }
                case 0xC3: // Transpose
                {
                    this.transpose = this.readLastPcInc() << 24 >> 24;
                    this.debugLog("Transpose: " + this.transpose);
                    break;
                }
                case 0xC4: // Pitch Bend
                {
                    this.pitchBend = this.readLastPcInc() << 24 >> 24;
                    this.debugLog("Pitch Bend: " + this.pitchBend);
                    this.sendMessage(false, MessageType.PitchBend);
                    break;
                }
                case 0xC5: // Pitch Bend Range
                {
                    this.pitchBendRange = this.readLastPcInc() & 0xff;
                    this.debugLog("Pitch Bend Range: " + this.pitchBendRange);
                    this.sendMessage(false, MessageType.PitchBend);
                    break;
                }
                case 0xC6: // Track Priority
                {
                    this.priority = this.readLastPcInc() & 0xff;
                    this.debugLog("Track Priority: " + this.priority);
                    break;
                }
                case 0xC7: // Mono / Poly
                {
                    let param = this.readLastPcInc();
                    this.mono = bitTest(param, 0);
                    break;
                }
                case 0xC8: // Tie On / Off
                {
                    this.tie = bitTest(this.readLastPcInc(), 0);
                    this.debugLog("Tie On / Off: " + this.tie);

                    // Apparently when a tie command is reached, the track's currently playing channels immediately stop. AMMENDMENT: they dont stop, they are just set to release
                    this.lastActiveChannel = null;
                    for (let i in this.activeChannels) {
                        var channel = this.activeChannels[i];
                        //channel.stopFlag = true;
                        channel.adsrState = AdsrState.Release;
                    }

                    break;
                }
                case 0xC9: // Portamento Control
                {
                    this.portamentoKey = (this.readLastPcInc() + this.transpose);
                    if (this.portamentoKey < 0)
                        this.portamentoKey = 0;
                    else if (this.portamentoKey > 0x7f)
                        this.portamentoKey = 0x7f;

                    this.portamentoEnable = 1;
                    this.debugLog("Portamento Control: " + this.portamentoKey);
                    break;
                }
                case 0xCA: // LFO Depth
                {
                    this.lfoDepth = this.readLastPcInc() & 0xff;
                    this.debugLog("LFO Depth: " + this.lfoDepth);
                    break;
                }
                case 0xCB: // LFO Speed
                {
                    this.lfoSpeed = this.readLastPcInc() & 0xff;
                    this.debugLog("LFO Speed: " + this.lfoSpeed);
                    break;
                }
                case 0xCC: // LFO Type
                {
                    this.lfoType = this.readLastPcInc() & 0xff;
                    this.debugLog("LFO Type: " + this.lfoType);
                    break;
                }
                case 0xCD: // LFO Range
                {
                    this.lfoRange = this.readLastPcInc() & 0xff;
                    this.debugLog("LFO Range: " + this.lfoRange);
                    break;
                }
                case 0xCE: // Portamento On / Off
                {
                    this.portamentoEnable = this.readLastPcInc() & 0xff;
                    this.debugLog("Portamento On / Off: " + this.portamentoEnable);
                    break;
                }
                case 0xCF: // Portamento Time
                {
                    this.portamentoTime = this.readLastPcInc() & 0xff;
                    this.debugLog("Portamento Time: " + this.portamentoTime);
                    break;
                }
                case 0xB0: // Set Variable
                {
                    var index = this.readPcInc();
                    this.sequence.writeVar(index, this.readLastPcInc(2) << 16 >> 16);
                    break;
                }
                case 0xB1: // Add Variable
                {
                    var index = this.readPcInc();
                    this.sequence.writeVar(index, this.sequence.readVar(index) + (this.readLastPcInc(2) << 16 >> 16));
                    break;
                }
                case 0xB2: // Subtract Variable
                {
                    var index = this.readPcInc();
                    this.sequence.writeVar(index, this.sequence.readVar(index) - (this.readLastPcInc(2) << 16 >> 16));
                    break;
                }
                case 0xB3: // Multiply Variable
                {
                    var index = this.readPcInc();
                    this.sequence.writeVar(index, this.sequence.readVar(index) * (this.readLastPcInc(2) << 16 >> 16));
                    break;
                }
                case 0xB4: // Divide Variable
                {
                    var index = this.readPcInc();
                    this.sequence.writeVar(index, 0|(this.sequence.readVar(index) / (this.readLastPcInc(2) << 16 >> 16)));
                    break;
                } 
                case 0xB5: // Shift Variable
                {
                    var variable = this.sequence.readVar(this.readPcInc());
                    var shift = this.readLastPcInc(2) << 16 >> 16;
                    this.sequence.writeVar(index, shift < 0 ? variable >> -shift : variable << shift);
                    break;
                }
                case 0xB6: // Random Variable
                {
                    var index = this.readPcInc();
                    var max = this.readLastPcInc(2) << 16 >> 16;
                    this.sequence.writeVar(index, (this.sequence.calcRandom() % (Math.abs(max) + 1)) * Math.sign(max)); // TODO: may be wrong. TODO: THIS IS WRONG!
                    break;
                }
                case 0xB8: // Compare Equal
                {
                    var index = this.readPcInc();
                    this.conditionalFlag = this.sequence.readVar(index) === (this.readLastPcInc(2) << 16 >> 16);
                    this.debugLogForce("Equal To: " + this.conditionalFlag);
                    break;
                }
                case 0xB9: // Compare Greater Than Or Equal To
                {
                    var index = this.readPcInc();
                    this.conditionalFlag = this.sequence.readVar(index) >= (this.readLastPcInc(2) << 16 >> 16);
                    this.debugLogForce("Greater Than Or Equal To: " + this.conditionalFlag);
                    break;
                }
                case 0xBA: // Compare Greater Than
                {
                    var index = this.readPcInc();
                    this.conditionalFlag = this.sequence.readVar(index) > (this.readLastPcInc(2) << 16 >> 16);
                    this.debugLogForce("Greater Than: " + this.conditionalFlag);
                    break;
                }
                case 0xBB: // Compare Less Than Or Equal To
                {
                    var index = this.readPcInc();
                    this.conditionalFlag = this.sequence.readVar(index) <= (this.readLastPcInc(2) << 16 >> 16);
                    this.debugLogForce("Less Than Or Equal To: " + this.conditionalFlag);
                    break;
                }
                case 0xBC: // Compare Less Than
                {
                    var index = this.readPcInc();
                    this.conditionalFlag = this.sequence.readVar(index) < (this.readLastPcInc(2) << 16 >> 16);
                    this.debugLogForce("Less Than: " + this.conditionalFlag);
                    break;
                }
                case 0xBD: // Compare Not Equal
                {
                    var index = this.readPcInc();
                    this.conditionalFlag = this.sequence.readVar(index) !== (this.readLastPcInc(2) << 16 >> 16);
                    this.debugLogForce("Not Equal: " + this.conditionalFlag);
                    break;
                }
                case 0xE0: // LFO Delay
                {
                    this.lfoDelay = this.readLastPcInc(2) >>> 0;
                    this.debugLog("LFO Delay: " + this.lfoDelay);
                    break;
                }
                case 0xE1: // BPM
                {
                    // this.bpm = (this.readLastPcInc(2) >>> 0); // bruh
                    this.sequence.bpm = (this.readLastPcInc(2) >>> 0);
                    this.debugLog("BPM: " + this.bpm);
                    break;
                }
                case 0xE3: // Sweep Pitch
                {
                    this.sweepPitch = this.readLastPcInc(2) << 16 >> 16;
                    this.debugLog("Sweep Pitch: " + this.sweepPitch);
                    break;
                }
                case 0xD0: // Attack Rate
                {
                    this.attackRate = this.readLastPcInc() & 0xff;
                    break;
                }
                case 0xD1: // Decay Rate
                {
                    this.decayRate = this.readLastPcInc() & 0xff;
                    break;
                }
                case 0xD2: // Sustain Rate
                {
                    this.sustainRate = this.readLastPcInc() & 0xff;
                    break;
                }
                case 0xD3: // Release Rate
                {
                    this.releaseRate = this.readLastPcInc() & 0xff;
                    break;
                }
                case 0xD4: // Loop Start
                {
                    //this.debugLogForce('Loop Start ' + this.pc);
                    var count = this.readLastPcInc() & 0xff;
                    this.pushLoop(this.pc, count);
                    break;
                }
                case 0xD5: // Expression
                {
                    this.expression = this.readLastPcInc() & 0xff;
                    if (this.expression > 0x7f)
                        this.expression = 0x7f;
                    this.sendMessage(false, MessageType.VolumeChange, this.volume, this.expression);
                    this.debugLog("Expression: " + this.expression);
                    break;
                }
                case 0xFC: // Loop End
                {
                    if (this.loopSp !== 0) {
                        var i = this.loopSp - 1;
                        if (this.loopStackCount[i]) {
                            this.loopStackCount[i]--;
                            if (this.loopStackCount[i] === 0) {
                                this.loopSp--;
                                break;
                            }
                        }
                        else {
                            this.sendMessage(false, MessageType.Jump); // Because this is an infinite loop
                        }
                        this.pc = this.loopStack[i];
                        //this.debugLogForce('Loop End, back to ' + this.pc);
                    }
                    break;
                }
                case 0xFD: // Return
                {
                    if (this.sp !== 0)
                        this.pc = this.pop();
                    break;
                }
                case 0xFE: // Allocate track
                {
                    // This probably isn't important for emulation
                    let alloced = this.readPcInc(2);

                    for (let i = 0; i < 16; i++) {
                        if (bitTest(alloced, i)) {
                            this.debugLog("Allocated track " + i);
                        }
                    }
                    break;
                }
                case 0xFF: // End of Track
                {
                    this.sequence.endTrack(this.id);
                    this.sendMessage(false, MessageType.TrackEnded);
                    // Set restingFor to non-zero since the controller checks it to stop executing
                    this.restingFor = 1;
                    this.debugLogForce("Track hit a FIN");

                    // for (var note of this.activeChannels)
                    //     note.adsrState = AdsrState.Release;

                    // "When the sequence processes for all tracks end, the player processes also stop"
                    break;
                }
                default:
                    console.error(`${this.id}: Unknown opcode: ` + hex(opcode, 2) + " PC: " + hex(this.pc - 1, 6));
            }
        }
    }

    execute() {
        let opcodePc = this.pc;
        let opcode = this.readPcInc();

        this.executeOpcode(opcode);
        this.exeCommandFlag = true;
    }

    determineVariableLength(addr) {
        let bytes = 0;
        for (let i = 0; i < 4; i++) {
            let val = this.read(addr);
            addr++
            bytes++;

            if ((val & 0x80) === 0) {
                break;
            }
        }

        return bytes;
    }

    determineCommandLength(pc) {
        let opcode = this.read(pc);

        if (opcode <= 0x7f) {
            return 2 + this.determineVariableLength(pc + 2);
        }
        else {
            switch (opcode & 0xf0) {
                case 0x80: return 1 + this.determineVariableLength(pc + 1);
                case 0x90:
                {
                    if (opcode === 0x93)        return 2 + this.determineVariableLength(pc + 2);
                    else if (opcode <= 0x95)    return 4;
                    else throw new Error();
                }
                case 0xA0:
                {
                    if (opcode === 0xA0)        return 6;
                    else if (opcode === 0xA1)   return 3;
                    else if (opcode === 0xA2)   return 2;
                    else throw new Error();
                } 
                case 0xB0: return 4;
                case 0xC0: return 2;
                case 0xD0: return 2;
                case 0xE0: return 3;
                case 0xF0:
                {
                    if (opcode === 0xFF)        return 1;
                    else if (opcode === 0xFE)   return 3;
                    else if (opcode >= 0xFC)    return 1;
                    else throw new Error();
                } 
            }
        }
    }
}

class DelayLine {
    /** @param {number} maxLength */
    constructor(maxLength) {
        this.buffer = new Float64Array(maxLength);
        this.posOut = 0;
        this.delay = 0;
        this.gain = 1;
    }

    /** @param {number} val */
    process(val) {
        this.buffer[(this.posOut + this.delay) % this.buffer.length] = val;
        let outVal = this.buffer[this.posOut];
        this.posOut++;
        if (this.posOut >= this.buffer.length) {
            this.posOut = 0;
        }
        return outVal * this.gain;
    }

    /** @param {number} length */
    setDelay(length) {
        if (length > this.buffer.length) {
            throw "delay length > buffer length";
        }
        this.delay = length;
    }
}

class SampleSynthesizer {
    /**
     * @param {number} sampleRate
     * @param {number} instrsAvailable
     */
    constructor(sampleRate, instrsAvailable) {
        this.instrsAvailable = instrsAvailable;

        /** @type {SampleInstrument[]} */
        this.instrs = new Array(this.instrsAvailable);
        /** @type {SampleInstrument[]} */
        this.activeInstrs = [];
        this.t = 0;
        this.sampleRate = sampleRate;

        this.valL = 0;
        this.valR = 0;

        this.volume = 1;
        /** @private */
        this.pan = 0.5;

        this.delayLineL = new DelayLine(Math.round(this.sampleRate * 0.1));
        this.delayLineR = new DelayLine(Math.round(this.sampleRate * 0.1));

        this.playingIndex = 0;

        let emptySample = new Sample(new Float64Array(1), 440, sampleRate, -1, 0, false, 0);

        for (let i = 0; i < this.instrs.length; i++) {
            this.instrs[i] = new SampleInstrument(this, i, this.sampleRate, emptySample);
        }

        this.finetune = 0;
    }

    /**
     * @param {Sample} sample
     * @param {number} midiNote
     * @param {number} volume
     * @param {number} meta
     */
    play(sample, midiNote, volume, meta, isPsg, psgNoise) {
        let instr = this.instrs[this.playingIndex];
        if (instr.playing) {
            this.cutInstrument(this.playingIndex);
        }
        instr.isPsg = isPsg;
        instr.psgNoise = psgNoise;
        instr.sample = sample;
        instr.setNote(midiNote);
        instr.setFinetuneLfo(0);
        instr.setFinetune(this.finetune);
        instr.volume = volume;
        instr.startTime = meta;
        instr.t = 0;
        instr.sampleT = 0;
        instr.resampleT = 0;
        instr.playing = true;

        let currentIndex = this.playingIndex;

        this.playingIndex++;
        this.playingIndex %= this.instrsAvailable;

        this.activeInstrs.push(instr);

        return currentIndex;
    }

    /**
     * @param {number} instrIndex
     */
    cutInstrument(instrIndex) {
        const activeInstrIndex = this.activeInstrs.indexOf(this.instrs[instrIndex]);
        if (activeInstrIndex === -1) {
            console.warn("Tried to cut instrument that wasn't playing");
            return;
        }
        let instr = this.activeInstrs[activeInstrIndex];
        instr.playing = false;
        this.activeInstrs.splice(activeInstrIndex, 1);
    }

    nextSample() {
        let valL = 0;
        let valR = 0;

        for (const instr of this.activeInstrs) {
            instr.advance();
            valL += instr.output * (1 - this.pan);
            valR += instr.output * this.pan;
        }

        if (g_enableStereoSeparation) {
            this.valL = this.delayLineL.process(valL) * this.volume;
            this.valR = this.delayLineR.process(valR) * this.volume;
        } else {
            this.valL = valL * this.volume;
            this.valR = valR * this.volume;
        }

        this.t++;
    }

    /**
     * @param {number} semitones
     */
    setFinetune(semitones) {
        this.finetune = semitones;
        for (let instr of this.instrs) {
            instr.setFinetune(semitones);
        }
    }

    // TODO: Mid/side processing to keep the low-end tight :)
    /** @param {number} pan */
    setPan(pan) {
        const SPEED_OF_SOUND = 343; // meters per second
        // let's pretend panning moves the sound source in a semicircle around and in front of the listener
        let r = 3; // semicircle radius
        let earX = 0.20; // absolute position of ears on the X axis
        let x = pan * 2 - 1; // [0, 1] -> [-1, -1]
        // force stereo separation on barely panned channels
        let gainR = 1;
        if (g_enableForceStereoSeparation) {
            if (x > -0.2 && x < 0.2) {
                // gainR = -1;
                x = 0.2 * Math.sign(x);
            }
        }
        let y = Math.sqrt((r ** 2) - x ** 2);
        let distL = Math.sqrt((earX + x) ** 2 + y ** 2);
        let distR = Math.sqrt((-earX + x) ** 2 + y ** 2);
        let minDist = Math.min(distL, distR);
        distL -= minDist;
        distR -= minDist;
        let delaySL = distL / SPEED_OF_SOUND * 50;
        let delaySR = distR / SPEED_OF_SOUND * 50;
        let delayL = Math.round(delaySL * this.sampleRate);
        let delayR = Math.round(delaySR * this.sampleRate);
        // console.log(`L:${delaySL * 1000}ms R:${delaySR * 1000}ms X:${x}`);

        // TODO: Intelligent fadeouts to prevent clicking when panning
        //this.delayLineL.setDelay(delayL);
        //this.delayLineR.setDelay(delayR);
        //this.delayLineR.gain = gainR;

        this.pan = pan;
    }
}

const AdsrState = {
    Attack: 0,
    Decay: 1,
    Sustain: 2,
    Release: 3,
};

// from pret/pokediamond
const sAttackCoeffTable = [
    0, 1, 5, 14, 26, 38, 51, 63, 73, 84, 92, 100, 109, 116, 123, 127, 132, 137, 143, 0,
];

const SNDi_DecibelSquareTable = [
    -32768, -722, -721, -651, -601, -562, -530, -503,
    -480, -460, -442, -425, -410, -396, -383, -371,
    -360, -349, -339, -330, -321, -313, -305, -297,
    -289, -282, -276, -269, -263, -257, -251, -245,
    -239, -234, -229, -224, -219, -214, -210, -205,
    -201, -196, -192, -188, -184, -180, -176, -173,
    -169, -165, -162, -158, -155, -152, -149, -145,
    -142, -139, -136, -133, -130, -127, -125, -122,
    -119, -116, -114, -111, -109, -106, -103, -101,
    -99, -96, -94, -91, -89, -87, -85, -82,
    -80, -78, -76, -74, -72, -70, -68, -66,
    -64, -62, -60, -58, -56, -54, -52, -50,
    -49, -47, -45, -43, -42, -40, -38, -36,
    -35, -33, -31, -30, -28, -27, -25, -23,
    -22, -20, -19, -17, -16, -14, -13, -11,
    -10, -8, -7, -6, -4, -3, -1, 0,
];

// this table is located in the DS ARM7 BIOS, copied from desmume
const getvoltbl = [
    0x00, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01,
    0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01,
    0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01,
    0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01,
    0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01,
    0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01,
    0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02,
    0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02,
    0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x03, 0x03, 0x03,
    0x03, 0x03, 0x03, 0x03, 0x03, 0x03, 0x03, 0x03, 0x03, 0x03, 0x03, 0x03, 0x03, 0x03, 0x03, 0x03,
    0x03, 0x03, 0x03, 0x03, 0x03, 0x03, 0x03, 0x03, 0x03, 0x03, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04,
    0x04, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04,
    0x05, 0x05, 0x05, 0x05, 0x05, 0x05, 0x05, 0x05, 0x05, 0x05, 0x05, 0x05, 0x05, 0x05, 0x05, 0x05,
    0x05, 0x06, 0x06, 0x06, 0x06, 0x06, 0x06, 0x06, 0x06, 0x06, 0x06, 0x06, 0x06, 0x06, 0x06, 0x06,
    0x07, 0x07, 0x07, 0x07, 0x07, 0x07, 0x07, 0x07, 0x07, 0x07, 0x07, 0x07, 0x08, 0x08, 0x08, 0x08,
    0x08, 0x08, 0x08, 0x08, 0x08, 0x08, 0x08, 0x09, 0x09, 0x09, 0x09, 0x09, 0x09, 0x09, 0x09, 0x09,
    0x09, 0x0A, 0x0A, 0x0A, 0x0A, 0x0A, 0x0A, 0x0A, 0x0A, 0x0B, 0x0B, 0x0B, 0x0B, 0x0B, 0x0B, 0x0B,
    0x0B, 0x0C, 0x0C, 0x0C, 0x0C, 0x0C, 0x0C, 0x0C, 0x0C, 0x0D, 0x0D, 0x0D, 0x0D, 0x0D, 0x0D, 0x0E,
    0x0E, 0x0E, 0x0E, 0x0E, 0x0E, 0x0E, 0x0F, 0x0F, 0x0F, 0x0F, 0x0F, 0x10, 0x10, 0x10, 0x10, 0x10,
    0x10, 0x11, 0x11, 0x11, 0x11, 0x11, 0x12, 0x12, 0x12, 0x12, 0x12, 0x13, 0x13, 0x13, 0x13, 0x14,
    0x14, 0x14, 0x14, 0x14, 0x15, 0x15, 0x15, 0x15, 0x16, 0x16, 0x16, 0x16, 0x17, 0x17, 0x17, 0x18,
    0x18, 0x18, 0x18, 0x19, 0x19, 0x19, 0x19, 0x1A, 0x1A, 0x1A, 0x1B, 0x1B, 0x1B, 0x1C, 0x1C, 0x1C,
    0x1D, 0x1D, 0x1D, 0x1E, 0x1E, 0x1E, 0x1F, 0x1F, 0x1F, 0x20, 0x20, 0x20, 0x21, 0x21, 0x22, 0x22,
    0x22, 0x23, 0x23, 0x24, 0x24, 0x24, 0x25, 0x25, 0x26, 0x26, 0x27, 0x27, 0x27, 0x28, 0x28, 0x29,
    0x29, 0x2A, 0x2A, 0x2B, 0x2B, 0x2C, 0x2C, 0x2D, 0x2D, 0x2E, 0x2E, 0x2F, 0x2F, 0x30, 0x31, 0x31,
    0x32, 0x32, 0x33, 0x33, 0x34, 0x35, 0x35, 0x36, 0x36, 0x37, 0x38, 0x38, 0x39, 0x3A, 0x3A, 0x3B,
    0x3C, 0x3C, 0x3D, 0x3E, 0x3F, 0x3F, 0x40, 0x41, 0x42, 0x42, 0x43, 0x44, 0x45, 0x45, 0x46, 0x47,
    0x48, 0x49, 0x4A, 0x4A, 0x4B, 0x4C, 0x4D, 0x4E, 0x4F, 0x50, 0x51, 0x52, 0x52, 0x53, 0x54, 0x55,
    0x56, 0x57, 0x58, 0x59, 0x5A, 0x5B, 0x5D, 0x5E, 0x5F, 0x60, 0x61, 0x62, 0x63, 0x64, 0x65, 0x67,
    0x68, 0x69, 0x6A, 0x6B, 0x6D, 0x6E, 0x6F, 0x71, 0x72, 0x73, 0x75, 0x76, 0x77, 0x79, 0x7A, 0x7B,
    0x7D, 0x7E, 0x7F, 0x20, 0x21, 0x21, 0x21, 0x22, 0x22, 0x23, 0x23, 0x23, 0x24, 0x24, 0x25, 0x25,
    0x26, 0x26, 0x26, 0x27, 0x27, 0x28, 0x28, 0x29, 0x29, 0x2A, 0x2A, 0x2B, 0x2B, 0x2C, 0x2C, 0x2D,
    0x2D, 0x2E, 0x2E, 0x2F, 0x2F, 0x30, 0x30, 0x31, 0x31, 0x32, 0x33, 0x33, 0x34, 0x34, 0x35, 0x36,
    0x36, 0x37, 0x37, 0x38, 0x39, 0x39, 0x3A, 0x3B, 0x3B, 0x3C, 0x3D, 0x3E, 0x3E, 0x3F, 0x40, 0x40,
    0x41, 0x42, 0x43, 0x43, 0x44, 0x45, 0x46, 0x47, 0x47, 0x48, 0x49, 0x4A, 0x4B, 0x4C, 0x4D, 0x4D,
    0x4E, 0x4F, 0x50, 0x51, 0x52, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5A, 0x5B, 0x5C, 0x5D,
    0x5E, 0x5F, 0x60, 0x62, 0x63, 0x64, 0x65, 0x66, 0x67, 0x69, 0x6A, 0x6B, 0x6C, 0x6D, 0x6F, 0x70,
    0x71, 0x73, 0x74, 0x75, 0x77, 0x78, 0x79, 0x7B, 0x7C, 0x7E, 0x7E, 0x40, 0x41, 0x42, 0x43, 0x43,
    0x44, 0x45, 0x46, 0x47, 0x47, 0x48, 0x49, 0x4A, 0x4B, 0x4C, 0x4C, 0x4D, 0x4E, 0x4F, 0x50, 0x51,
    0x52, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5A, 0x5B, 0x5C, 0x5D, 0x5E, 0x5F, 0x60, 0x61,
    0x62, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6B, 0x6C, 0x6D, 0x6E, 0x70, 0x71, 0x72, 0x74, 0x75,
    0x76, 0x78, 0x79, 0x7B, 0x7C, 0x7D, 0x7E, 0x40, 0x41, 0x42, 0x42, 0x43, 0x44, 0x45, 0x46, 0x46,
    0x47, 0x48, 0x49, 0x4A, 0x4B, 0x4B, 0x4C, 0x4D, 0x4E, 0x4F, 0x50, 0x51, 0x52, 0x53, 0x54, 0x55,
    0x56, 0x57, 0x58, 0x59, 0x5A, 0x5B, 0x5C, 0x5D, 0x5E, 0x5F, 0x60, 0x61, 0x62, 0x63, 0x65, 0x66,
    0x67, 0x68, 0x69, 0x6A, 0x6C, 0x6D, 0x6E, 0x6F, 0x71, 0x72, 0x73, 0x75, 0x76, 0x77, 0x79, 0x7A,
    0x7C, 0x7D, 0x7E, 0x7F
];

const squares = [
    new Sample(new Float64Array([-1, -1, -1, -1, -1, -1, -1, 1]), 1, 8, -1, true, 0),
    new Sample(new Float64Array([-1, -1, -1, -1, -1, -1, 1, 1]), 1, 8, -1, true, 0),
    new Sample(new Float64Array([-1, -1, -1, -1, -1, 1, 1, 1]), 1, 8, -1, true, 0),
    new Sample(new Float64Array([-1, -1, -1, -1, 1, 1, 1, 1]), 1, 8, -1, true, 0),
    new Sample(new Float64Array([-1, -1, -1, 1, 1, 1, 1, 1]), 1, 8, -1, true, 0),
    new Sample(new Float64Array([-1, -1, 1, 1, 1, 1, 1, 1]), 1, 8, -1, true, 0),
    new Sample(new Float64Array([-1, 1, 1, 1, 1, 1, 1, 1]), 1, 8, -1, true, 0),
    new Sample(new Float64Array([-1, -1, -1, -1, -1, -1, -1, -1]), 1, 8, -1, true, 0)
];

// based off SND_CalcChannelVolume from pret/pokediamond
/**
 * @param {number} velocity
 * @param {number} adsrTimer
 */
function calcChannelVolume(velocity, adsrTimer, decay, lfo=0) {
    const SND_VOL_DB_MIN = -723;

    let vol = 0;

    vol += SNDi_DecibelSquareTable[velocity];
    vol += adsrTimer >> 7;
    vol += decay;

    if (vol > -0x8000)
        vol += lfo; // src: pret/pokediamond

    if (vol < SND_VOL_DB_MIN) {
        vol = SND_VOL_DB_MIN;
    } else if (vol > 0) {
        vol = 0;
    }

    let result = getvoltbl[vol - SND_VOL_DB_MIN];

    if (vol < -240)
        result /= 16;
    else if (vol < -120)
        result /= 4;
    else if (vol < -60)
        result /= 2;
    else
        result /= 1;

    return result / 127;
}

function calcChannelPan(pan, lfo=0) {
    return (pan + lfo) / 128
}

function calcChannelDecay(track) {
    let decay = 0;

    // src: pret/pokediamond
    decay = SNDi_DecibelSquareTable[track.volume] + SNDi_DecibelSquareTable[track.expression]; //+ SNDi_DecibelSquareTable[player->volume];

    if (decay < -0x8000)
        decay = -0x8000;

    return decay;
}

/**
 * Thanks to ipatix and pret/pokediamond
 * @param {number} vol
 */
function CalcDecayCoeff(vol) {
    if (vol === 127)
        return 0xFFFF;
    else if (vol === 126)
        return 0x3C00;
    else if (vol < 50)
        return (vol * 2 + 1) & 0xFFFF;
    else
        return (Math.floor(0x1E00 / (126 - vol))) & 0xFFFF;
}

/**
 * @param {number} attack
 * Thanks to ipatix and pret/pokediamond
 */
function getEffectiveAttack(attack) {
    if (attack < 109)
        return 255 - attack;
    else
        return sAttackCoeffTable[127 - attack];
}

/**
 * Thanks to ipatix and pret/pokediamond
 * @param {number} sustain
 */
function getSustainLevel(sustain) {
    return SNDi_DecibelSquareTable[sustain] << 7;
}

class FsVisController {
    /**
     * @param {Sdat} sdat
     * @param {number} id
     * @param {number} runAheadTicks
     */
    constructor(runAheadTicks) {
        this.runAheadTicks = runAheadTicks;
        this.bpmTimer = 0;

        /** @type {CircularBuffer<Message>} */
        this.messageBuffer = new CircularBuffer(512);
        this.sequence = null;
        /** @type {CircularBuffer<Message>} */
        this.activeNotes = new CircularBuffer(2048);
    }

    fsVisLoadSseq(sdat, id) {
        let info = sdat.sseqInfos[id];
        if (info == null) throw new Error();
        if (info.fileId == null) throw new Error();
        let file = sdat.fat.get(info.fileId);
        if (file == null) throw new Error();
        let dataOffset = read32LE(file, 0x18);

        this.messageBuffer = new CircularBuffer(512);
        this.sequence = new Sequence(file, dataOffset, this.messageBuffer, this);
        this.sequence.parentControllerIsFsVis = true;
        this.activeNotes = new CircularBuffer(2048);

        this.bpmTimer = 0;
    }
    fsVisLoadSsarSeq(sdat, ssarId, subSseqId) {
        let ssarInfo = sdat.ssarInfos[ssarId];
        if (!ssarInfo) throw `Invalid SSAR ID ${seqId}`;
        let ssarFile = sdat.fat.get(ssarInfo.fileId);
        if (!ssarFile) throw `No file found for SSAR ${seqId}`;

        //let ssarListNumEntries = read32LE(ssarFile, 28);
        let ssarListOffs = 32 + subSseqId * 12;
        let dataOffset = read32LE(ssarFile, 24);

        this.messageBuffer = new CircularBuffer(1024);
        this.sequence = new Sequence(ssarFile, dataOffset, this.messageBuffer, this);
        this.sequence.parentControllerIsFsVis = true;
        this.activeNotes = new CircularBuffer(2048);

        let trackPCOffset = read32LE(ssarFile, ssarListOffs);
        this.sequence.tracks[0].pc = trackPCOffset;

        this.bpmTimer = 0;
    }

    runAhead() {
        for (var i = 0; i < this.runAheadTicks; i++)
            this.tick();
    }

    tick() {
        this.bpmTimer += this.sequence.bpm;
        while (this.bpmTimer >= 240) {
            this.bpmTimer -= 240;

            this.sequence.tick();

            while (this.messageBuffer.entries > 0) {
                /** @type {Message} */
                let msg = this.messageBuffer.pop();

                switch (msg.type) {
                    case MessageType.PlayNote:
                        if (this.activeNotes.entries >= this.activeNotes.size) {
                            this.activeNotes.pop();
                        }

                        msg.timestamp = this.sequence.ticksElapsed - this.sequence.ticksElapsedPaused;
                        this.activeNotes.insert(msg);
                        break;
                }
            }
        }
    }
}

const LfoType = {
    Pitch: 0,
    Volume: 1,
    Pan: 2
};

// pret/pokediamond
const sLfoSinTable = [
    0,
    6,
    12,
    19,
    25,
    31,
    37,
    43,
    49,
    54,
    60,
    65,
    71,
    76,
    81,
    85,
    90,
    94,
    98,
    102,
    106,
    109,
    112,
    115,
    117,
    120,
    122,
    123,
    125,
    126,
    126,
    127,
    127,
    0,
    0,
    0
];

class Controller {
    /**
     * @param {number} sampleRate
     */
    constructor(sampleRate) {

        /** @type {Sample[][]} */
        this.decodedSampleArchives = [];

        /** @type {CircularBuffer<Message>} */
        this.messageBuffer = new CircularBuffer(1024);
        this.sequence = null;

        /** @type {Uint8Array[]} */
        this.notesOn = [];
        this.notesOnKeyboard = [];
        for (let i = 0; i < 16; i++) {
            this.notesOn[i] = new Uint8Array(128);
            this.notesOnKeyboard[i] = new Uint8Array(128);
        }

        /** @type {SampleSynthesizer[]} */
        this.synthesizers = new Array(16);
        for (let i = 0; i < 16; i++) {
            this.synthesizers[i] = new SampleSynthesizer(sampleRate, 16);
        }

        this.jumps = 0;
        this.fadingStart = false;
        /**
         * @type {{ trackNum: number; midiNote: number; velocity: number; synthInstrIndex: number; startTime: number; endTime: number; instrument: InstrumentRecord; instrumentEntryIndex: number; adsrState: number; adsrTimer: number; // idk why this number, ask gbatek
         fromKeyboard: boolean; lfoCounter: number; lfoDelayCounter: number; delayCounter: number; }[]}
         */
        this.activeNoteData = [];
        this.bpmTimer = 0;
        this.lfoValue = BigInt(0);
        /**
         * @type {number | null}
         */
        this.activeKeyboardTrackNum = null;
    }

    nextSynthesizedMixedSample() {
        let valL = 0;
        let valR = 0;
        for (let i = 0; i < 16; i++) {
            this.synthesizers[i].nextSample();
            if (g_trackEnables[i]) {
                valL += this.synthesizers[i].valL;
                valR += this.synthesizers[i].valR;

                // if (valL > max) valL = max
                // else if (valL < -max) valL = -max;
                // if (valR > max) valR = max
                // else if (valR < -max) valR = -max;   
            }
        }
        // EXPERIMENTAL: truncate resolution to 10 bits
        // valL = Math.floor(valL * 1024) / 1024;
        // valR = Math.floor(valR * 1024) / 1024;

        // Master volume
        const max = 2;

        if (valL > max) valL = max;
        else if (valL < -max) valL = -max;
        if (valR > max) valR = max;
        else if (valR < -max) valR = -max;   

        valL /= 2;
        valR /= 2;

        let out = {
            valL: valL,
            valR: valR
        };
        return out;
    }

    /**
     * @param {Sdat} sdat
     * @param {number} sseqId
     */
    loadSseq(sdat, sseqId) {
        this.sdat = sdat;

        let sseqInfo = sdat.sseqInfos[sseqId];
        if (!sseqInfo) throw `Invalid SSEQ ID ${seqId}`;
        if (sseqInfo.bank === null) throw new Error();
        this.bankInfo = sdat.sbnkInfos[sseqInfo.bank];
        if (!this.bankInfo) throw `Invalid bank number ${bank}`;
        this.instrumentBank = sdat.instrumentBanks[sseqInfo.bank];
        if (!this.instrumentBank) throw `Invalid instrument bank ${bank}`;

        console.log("Playing SSEQ Id:" + sseqId);
        console.log("FAT ID:" + sseqInfo.fileId);

        if (sseqInfo.fileId == null) throw `No file found for SSEQ ${seqId}`;

        let sseqFile = sdat.fat.get(sseqInfo.fileId);
        if (!sseqFile) throw `No file found for SSEQ ${seqId}`;

        this.decodeSampleArchives();

        let dataOffset = read32LE(sseqFile, 0x18);
        if (dataOffset !== 0x1C) alert("SSEQ offset is not 0x1C? it is: " + hex(dataOffset, 8));

        /** @type {CircularBuffer<Message>} */
        this.messageBuffer = new CircularBuffer(1024);
        this.sequence = new Sequence(sseqFile, dataOffset, this.messageBuffer, this);

        /** @type {Uint8Array[]} */
        // this.notesOn = [];
        // this.notesOnKeyboard = [];
        // for (let i = 0; i < 16; i++) {
        //     this.notesOn[i] = new Uint8Array(128);
        //     this.notesOnKeyboard[i] = new Uint8Array(128);
        // }

        /** @type {SampleSynthesizer[]} */
        // this.synthesizers = new Array(16);
        // for (let i = 0; i < 16; i++) {
        //     this.synthesizers[i] = new SampleSynthesizer(sampleRate, 16);
        // }

        this.jumps = 0;
        this.fadingStart = false;
        /**
         * @type {{ trackNum: number; midiNote: number; velocity: number; synthInstrIndex: number; startTime: number; endTime: number; instrument: InstrumentRecord; instrumentEntryIndex: number; adsrState: number; adsrTimer: number; // idk why this number, ask gbatek
         fromKeyboard: boolean; lfoCounter: number; lfoDelayCounter: number; delayCounter: number; }[]}
         */
        this.activeNoteData = [];
        this.bpmTimer = 0;
        /**
         * @type {number | null}
         */
        this.activeKeyboardTrackNum = null;
    }

    /**
     * @param {Sdat} sdat
     * @param {number} ssarId
     * @param {number} subSseqId
     */
    loadSsarSeq(sdat, ssarId, subSseqId) {
        console.log('Loading SSAR: ' + ssarId + ', Sub-Seq: ' + subSseqId);

        this.sdat = sdat;

        let ssarInfo = sdat.ssarInfos[ssarId];
        if (!ssarInfo) throw `Invalid SSAR ID ${seqId}`;
        let ssarFile = sdat.fat.get(ssarInfo.fileId);
        if (!ssarFile) throw `No file found for SSAR ${seqId}`;

        let ssarListNumEntries = read32LE(ssarFile, 28);
        let ssarListOffs = 32 + subSseqId * 12;

        let bank = read16LE(ssarFile, ssarListOffs + 4);
        this.bankInfo = sdat.sbnkInfos[bank];
        if (!this.bankInfo) throw `Invalid bank number ${bank}`;
        console.log('SSAR bank ID: ' + bank);
        this.instrumentBank = sdat.instrumentBanks[bank];
        if (!this.instrumentBank) throw `Invalid instrument bank ${bank}`;

        this.decodeSampleArchives();

        let dataOffset = read32LE(ssarFile, 24);
        if (dataOffset !== ssarListNumEntries * 12 + 32) alert("SSEQ offset is not ssarListNumEntries * 12 + 32? it is: " + hex(dataOffset, 8));

        /** @type {CircularBuffer<Message>} */
        this.messageBuffer = new CircularBuffer(1024);
        this.sequence = new Sequence(ssarFile, dataOffset, this.messageBuffer, this);

        let trackPCOffset = read32LE(ssarFile, ssarListOffs);
        this.sequence.tracks[0].pc = trackPCOffset;

        /** @type {Uint8Array[]} */
        // this.notesOn = [];
        // this.notesOnKeyboard = [];
        // for (let i = 0; i < 16; i++) {
        //     this.notesOn[i] = new Uint8Array(128);
        //     this.notesOnKeyboard[i] = new Uint8Array(128);
        // }

        /** @type {SampleSynthesizer[]} */
        // this.synthesizers = new Array(16);
        // for (let i = 0; i < 16; i++) {
        //     this.synthesizers[i] = new SampleSynthesizer(sampleRate, 16);
        // }

        this.jumps = 0;
        this.fadingStart = false;
        /**
         * @type {{ trackNum: number; midiNote: number; velocity: number; synthInstrIndex: number; startTime: number; endTime: number; instrument: InstrumentRecord; instrumentEntryIndex: number; adsrState: number; adsrTimer: number; // idk why this number, ask gbatek
         fromKeyboard: boolean; lfoCounter: number; lfoDelayCounter: number; delayCounter: number; }[]}
         */
        this.activeNoteData = [];
        this.bpmTimer = 0;
        /**
         * @type {number | null}
         */
        this.activeKeyboardTrackNum = null;
    }

    carryOverRedundantControllerData(prevController) {
        // Sample archive slot carry over bug (is it?). EG. in SM64DS, TIMER_FAST plays correctly only after TIMER_SLOW plays because its missing a wave archive slot
        let prevDecoded = prevController.decodedSampleArchives;
        for (let i = 0; i < 4; i++) {
            if (this.decodedSampleArchives[i] || !prevDecoded[i])
                continue;

            this.decodedSampleArchives[i] = [];
            for (let ii = 0; ii < prevDecoded[i].length; ii++) {
                let sample = prevDecoded[i][ii];
                this.decodedSampleArchives[i][ii] = new Sample(sample.data, sample.frequency, sample.sampleRate, sample.sampleTimer, sample.looping, sample.loopPoint);
            }
        }    
    }

    decodeSampleArchives() {
        this.decodedSampleArchives.length = 0;

        let nSamples = 0;
        let sSamples = 0;
        // Decode sample archives
        for (let i = 0; i < 4; i++) {
            let decodedArchive = [];
            let swarId = this.bankInfo.swarId[i];
            let swarInfo = this.sdat.swarInfos[swarId];
            if (swarInfo != null) {
                console.log(`Linked archive: ${this.bankInfo.swarId[0]}`);
                if (swarInfo.fileId == null) throw new Error();
                let swarFile = this.sdat.fat.get(swarInfo.fileId);
                if (swarFile == null) throw new Error();

                let sampleCount = read32LE(swarFile, 0x38);
                for (let j = 0; j < sampleCount; j++) {
                    let sampleOffset = read32LE(swarFile, 0x3C + j * 4);
                    if (dataViewOutOfBounds(swarFile, sampleOffset)) {
                        console.warn("Out of bounds SWAR entry");
                        continue;
                    }

                    let wavType = read8(swarFile, sampleOffset + 0);
                    let loopFlag = read8(swarFile, sampleOffset + 1);
                    let sampleRate = read16LE(swarFile, sampleOffset + 2);
                    let sampleTimer = read16LE(swarFile, sampleOffset + 4);
                    let swarLoopOffset = read16LE(swarFile, sampleOffset + 6); // in 4-byte units
                    let swarSampleLength = read32LE(swarFile, sampleOffset + 8); // in 4-byte units (excluding ADPCM header if any)

                    let sampleDataLength = (swarLoopOffset + swarSampleLength) * 4;

                    let sampleData = createRelativeDataView(swarFile, sampleOffset + 0xC, sampleDataLength);

                    let decoded;
                    let loopPoint = 0;

                    switch (wavType) {
                        case 0: // PCM8
                            loopPoint = swarLoopOffset * 4;
                            decoded = decodePcm8(sampleData);
                            // console.log(`Archive ${i}, Sample ${j}: PCM8`);
                            break;
                        case 1: // PCM16
                            loopPoint = swarLoopOffset * 2;
                            decoded = decodePcm16(sampleData);
                            // console.log(`Archive ${i}, Sample ${j}: PCM16`);
                            break;
                        case 2: // IMA-ADPCM
                            loopPoint = swarLoopOffset * 8 - 8;
                            decoded = decodeAdpcm(sampleData);
                            // console.log(`Archive ${i}, Sample ${j}: ADPCM`);
                            break;
                        default:
                            throw new Error();
                    }

                    nSamples++;
                    sSamples += decoded.length * 8; // Each Float64Array entry is 8 bytes

                    decodedArchive[j] = new Sample(decoded, 440, sampleRate, sampleTimer, loopFlag !== 0, loopPoint);
                    decodedArchive[j].sampleLength = swarSampleLength * 4;
                }

                this.decodedSampleArchives[i] = decodedArchive;
            }
        }

        console.log("Samples decoded: " + nSamples);
        console.log(`Total in-memory size of samples: ${(sSamples / 1048576).toPrecision(4)} MiB`);

        for (let i = 0; i < this.instrumentBank.instruments.length; i++) {
            let instrument = this.instrumentBank.instruments[i];
            let typeString = "";
            switch (instrument.fRecord) {
                case InstrumentType.Drumset:
                    typeString = "Drumset";
                    break;
                case InstrumentType.MultiSample:
                    typeString = "Multi-Sample Instrument";
                    break;
                case InstrumentType.PsgNoise:
                    typeString = "PSG Noise";
                    break;
                case InstrumentType.PsgPulse:
                    typeString = "PSG Pulse";
                    break;
                case InstrumentType.SingleSample:
                    typeString = "Single-Sample Instrument";
                    break;
                default:
                    console.warn(`Unrecognized instrument type: ${instrument.fRecord}`);
                    break;
            }

            if (instrument.fRecord !== 0) {
                //console.log(`Program ${i}: ${typeString}\nLinked archive ${instrument.swarInfoId[0]} Sample ${instrument.swavInfoId[0]}`);
            }
        }
    }

    updateNoteFinetuneLfo(note) {
        let instr = this.synthesizers[note.trackNum].instrs[note.synthInstrIndex];

        var finetune;
        if (note.sweepPitch && note.sweepCounter) {
            finetune = note.sweepPitch * (note.sweepCounter / note.sweepLength);
        }
        else {
            finetune = 0;
        }
        finetune += (this.sequence.tracks[note.trackNum].lfoType === LfoType.Pitch) * Number(this.lfoValue);

        instr.setFinetuneLfo((finetune) / 64);
    }

    tick() {
        this.updateSequence(); // The order in which this is called actually has a noticable difference for some sounds (like the mini mushroom)

        let indexToDelete = -1;

        for (let index in this.activeNoteData) {
            let entry = this.activeNoteData[index];
            /** @type {InstrumentRecord} */
            let instrument = entry.instrument;

            let track = this.sequence.tracks[entry.trackNum];
            let synth = this.synthesizers[entry.trackNum];
            let instr = synth.instrs[entry.synthInstrIndex];

            // sometimes a SampleInstrument will be reused before the note it is playing is over due to Synthesizer polyphony limits
            // check here to make sure the note entry stored in the heap is referring to the same note it originally did 
            if (instr.startTime === entry.startTime && instr.playing) {
                // Cut instruments that have ended samples
                if (instr.sample && !instr.sample.looping && instr.sampleT > instr.sample.data.length) {
                    // @ts-ignore
                    indexToDelete = index;
                    this.synthesizers[entry.trackNum].cutInstrument(entry.synthInstrIndex);
                }

                if (entry.stopFlag) {
                    if (entry.adsrState !== AdsrState.Release) {
                        this.notesOn[entry.trackNum][entry.midiNote] = 0;
                        entry.adsrState = AdsrState.Release;
                        entry.adsrTimer = -92544;
                    }
                }
                else if (this.sequence.ticksElapsed >= entry.endTime && !entry.fromKeyboard && !entry.infiniteDuration/* && !track.tie*/) {
                    if (entry.adsrState !== AdsrState.Release) {
                        this.notesOn[entry.trackNum][entry.midiNote] = 0;
                        entry.adsrState = AdsrState.Release;
                    }
                }

                // LFO code based off pret/pokediamond
                if (track.lfoDepth === 0) {
                    this.lfoValue = BigInt(0);
                } else if (entry.lfoDelayCounter++ < track.lfoDelay) {
                    this.lfoValue = BigInt(0);
                } else {
                    /**
                     * pret/pokediamond
                     * @param {number} x
                     */
                    function SND_SinIdx(x) {
                        if (x < 0x20) {
                            return sLfoSinTable[x];
                        } else if (x < 0x40) {
                            return sLfoSinTable[0x40 - x];
                        } else if (x < 0x60) {
                            return (-sLfoSinTable[x - 0x40]) << 24 >> 24;
                        } else {
                            return (-sLfoSinTable[0x20 - (x - 0x60)]) << 24 >> 24;
                        }
                    }


                    this.lfoValue = BigInt(SND_SinIdx(entry.lfoCounter >>> 8) * track.lfoDepth * track.lfoRange);
                }

                // OPTIMIZE
                if (this.lfoValue !== 0n) {
                    switch (track.lfoType) {
                        case LfoType.Volume:
                            this.lfoValue *= 60n;
                            break;
                        case LfoType.Pitch:
                            this.lfoValue <<= 6n;
                            break;
                        case LfoType.Pan:
                            this.lfoValue <<= 6n;
                            break;
                    }
                    this.lfoValue >>= 14n;
                }

                // var finetune;
                // if (entry.sweepPitch && entry.sweepCounter) {
                //     finetune = entry.sweepPitch * (entry.sweepCounter / entry.sweepLength);
                //     if (entry.autoSweep)
                //         entry.sweepCounter--;
                // }
                // else {
                //     finetune = 0;
                // }
                if (entry.sweepPitch && entry.sweepCounter && entry.autoSweep) {
                    entry.sweepCounter--;
                }

                if (entry.delayCounter < track.lfoDelay) {
                    entry.delayCounter++;
                } else {
                    let tmp = entry.lfoCounter;
                    tmp += track.lfoSpeed << 6;
                    tmp >>>= 8;
                    while (tmp >= 0x80) {
                        tmp -= 0x80;
                    }
                    entry.lfoCounter += track.lfoSpeed << 6;
                    entry.lfoCounter &= 0xFF;
                    entry.lfoCounter |= tmp << 8;

                }

                this.updateNoteFinetuneLfo(entry);

                // all thanks to @ipatix at pret/pokediamond
                switch (entry.adsrState) {
                    case AdsrState.Attack:
                        entry.adsrTimer = -((-entry.attackCoefficient * entry.adsrTimer) >> 8);
                        // console.log(data.adsrTimer);
                        //instr.volume = calcChannelVolume(entry.velocity, entry.adsrTimer);
                        entry.decay = calcChannelDecay(track);  
                        // one instrument hits full volume, start decay
                        if (entry.adsrTimer === 0) {
                            entry.adsrState = AdsrState.Decay;
                        }
                        break;
                    case AdsrState.Decay:
                        entry.adsrTimer -= entry.decayCoefficient;
                        // when instrument decays to sustain volume, go into sustain state

                        if (entry.adsrTimer <= entry.sustainLevel) {
                            entry.adsrTimer = entry.sustainLevel;
                            entry.adsrState = AdsrState.Sustain;
                        }

                        //instr.volume = calcChannelVolume(entry.velocity, entry.adsrTimer);
                        entry.decay = calcChannelDecay(track);
                        break;
                    case AdsrState.Sustain:
                        //instr.volume = calcChannelVolume(entry.velocity, entry.adsrTimer);
                        entry.decay = calcChannelDecay(track);
                        break;
                    case AdsrState.Release:
                        if (entry.adsrTimer <= -92544) {
                            // ADSR curve hit zero, cut the instrument
                            this.synthesizers[entry.trackNum].cutInstrument(entry.synthInstrIndex);
                            // @ts-ignore
                            indexToDelete = index;
                            this.notesOn[entry.trackNum][entry.midiNote] = 0;
                        } else {
                            entry.adsrTimer -= entry.releaseCoefficient;
                            //instr.volume = calcChannelVolume(entry.velocity, entry.adsrTimer);
                        }

                        // Decay isn't recalculated for released channels
                        // TODO: neither is pan, pan range whatever that is, or the lfo value! (pret/pokediamond: TrackUpdateChannel) not so noticable but still (does this differ between versions of the player?)
                        break;
                }
                
                instr.volume = calcChannelVolume(entry.velocity, entry.adsrTimer, entry.decay, Number(this.lfoValue) * (track.lfoType === LfoType.Volume));
                synth.setPan(calcChannelPan(track.pan, Number(this.lfoValue) * (track.lfoType === LfoType.Pan)));

            } else {
                // @ts-ignore
                indexToDelete = index;
                this.notesOn[entry.trackNum][entry.midiNote] = 0;
            }
        }

        if (indexToDelete !== -1) {
            var note = this.activeNoteData[indexToDelete];
            var track = this.sequence.tracks[note.trackNum];
            var indexToDeleteInTrackChannel = track.activeChannels.indexOf(note);
            if (indexToDeleteInTrackChannel !== -1) {
                if (track.lastActiveChannel === note)
                    track.lastActiveChannel = null;

                track.activeChannels.splice(indexToDeleteInTrackChannel, 1);
            }
            if (track.restingUntilAChannelEnds && track.channelWaitingFor === note) {
                track.restingUntilAChannelEnds = false;
                track.channelWaitingFor = null;
            }
            this.activeNoteData.splice(indexToDelete, 1);
        }

        // this.updateSequence();
    }

    updateSequence() {
        this.bpmTimer += this.sequence.bpm;
        while (this.bpmTimer >= 240) {
            this.bpmTimer -= 240;

            for (let note of this.activeNoteData) {
                if (!note.autoSweep && note.sweepCounter /*&& this.sequence.tracks[note.trackNum].active*/) {
                    note.sweepCounter--;
                    //this.updateNoteFinetuneLfo(note);
                }
                this.updateNoteFinetuneLfo(note);
            }

            this.sequence.tick();

            while (this.messageBuffer.entries > 0) {

                /** @type {Message} */
                let msg = this.messageBuffer.pop();

                switch (msg.type) {
                    case MessageType.PlayNote:
                        this.playNote(msg.trackNum, msg.param0, msg.param1, msg.param2);
                        break;
                    case MessageType.Jump: {
                        this.jumps++;
                        break;
                    }
                    case MessageType.InstrumentChange: {
                        break;
                    } 
                    case MessageType.TrackEnded: {
                        for (var channel of this.sequence.tracks[msg.trackNum].activeChannels)
                            channel.adsrState = AdsrState.Release; // Src: pret/pokediamond

                        let tracksActive = 0;
                        for (let i = 0; i < 16; i++) {
                            if (this.sequence.tracks[i].active) {
                                tracksActive++;
                            }
                        }

                        if (tracksActive === 0) {
                            this.fadingStart = true;
                            // for (var note of this.activeNoteData) {
                            //     note.adsrState = AdsrState.Release; // TODO: Is this correct? it fixes some bad loops. Ill call this the fin release theory 
                            // }
                        }
                        break;
                    }
                    case MessageType.VolumeChange: {
                        //this.synthesizers[msg.trackNum].volume = ((msg.param0 / 127) * (msg.param1 / 127)) ** 2;
                        break;
                    }
                    case MessageType.PanChange: {
                        // this.synthesizers[msg.trackNum].setPan(msg.param0 / 128);
                        break;
                    }
                    case MessageType.PitchBend: {
                        let track = this.sequence.tracks[msg.trackNum];
                        let pitchBend = track.pitchBend << 24 >> 24; // sign extend
                        pitchBend *= track.pitchBendRange / 2;
                        // pitch bend specified in 1/64 of a semitone
                        this.synthesizers[msg.trackNum].setFinetune(pitchBend / 64);
                        break;
                    }
                }
            }
        }
    }

    playNote(trackNum, midiNote, velocity, duration, fromKeyboard=false) {
        let track = this.sequence.tracks[trackNum];
        let rawMidiNote = midiNote;

        if (midiNote < 21 || midiNote > 108) console.log("MIDI note out of piano range: " + midiNote);

        // The archive ID inside each instrument record inside each SBNK file
        // refers to the archive ID referred to by the corresponding SBNK entry in the INFO block

        /** @type {InstrumentRecord} */
        let instrument = this.instrumentBank.instruments[track.program];
        if (!instrument) {
            console.warn(`Invalid instrument, prg: ${track.program}, track: ${trackNum}`);
            return;
        }

        // Null note
        if (instrument.fRecord === 0) {
            console.warn('Null note');
            return;
        }

        // TODO: only allow certain instrument types on certain channels
        // EG. Noise is only supported on channels 14 and 15

        let index = instrument.resolveEntryIndex(midiNote);
        if (index === -1) {
            console.warn('Invalid index');
            return;
        }
        let instrumentType = instrument.instrumentTypes[index];
        let archiveIndex = instrument.swarInfoId[index];
        let sampleId = instrument.swavInfoId[index];

        // if (trackNum === 1) {
        //     console.log(archiveIndex, instrument);
        // }

        let archive = this.decodedSampleArchives[archiveIndex];
        if (!archive) {
            console.warn('No archive');
            return; //throw new Error();
        }

        let sample;
        let isPsg;
        let psgNoise;
        if (instrumentType === InstrumentType.PsgPulse) {
            sample = squares[sampleId];
            sample.frequency = 1;
            isPsg = true;
            psgNoise = false;
            midiNote = midiNote + 60 - instrument.noteNumber[index]; // For multi-sample instruments
            sample.resampleMode = ResampleMode.NearestNeighbor;
        }
        else if (instrumentType === InstrumentType.PsgNoise) {
            sample = null;
            isPsg = true;
            psgNoise = true;
            midiNote = midiNote + 60 - instrument.noteNumber[index]; // For multi-sample instruments
            //sample.resampleMode = ResampleMode.NearestNeighbor;
        }
        else {
            sample = archive[sampleId];
            if (!sample) {
                console.warn('No sample');
                return;
            }
            isPsg = false;
            psgNoise = false;
            sample.frequency = midiNoteToHz(0); // TODO: This causes bugs and needs to go..
            midiNote += 0 - instrument.noteNumber[index]; // For multi-sample instruments
            sample.resampleMode = ResampleMode.Cubic;
        }

        let attackRate, attackCoefficient, decayRate, decayCoefficient, sustainRate, sustainLevel, releaseRate, releaseCoefficient;
        if (track.attackRate !== 0xff) {
            attackRate = track.attackRate;
            attackCoefficient = getEffectiveAttack(attackRate);
        }
        else {
            attackRate = instrument.attack[index];
            attackCoefficient = instrument.attackCoefficient[index];
        }

        if (track.decayRate !== 0xff) {
            decayRate = track.decayRate;
            decayCoefficient = CalcDecayCoeff(decayRate);
        }
        else {
            decayRate = instrument.decay[index];
            decayCoefficient = instrument.decayCoefficient[index];
        }

        if (track.sustainRate !== 0xff) {
            sustainRate = track.sustainRate;
            sustainLevel = getSustainLevel(sustainRate);
        }
        else {
            sustainRate = instrument.sustain[index];
            sustainLevel = instrument.sustainLevel[index];
        }
        
        if (track.releaseRate !== 0xff) {
            releaseRate = track.releaseRate;
            releaseCoefficient = CalcDecayCoeff(releaseRate);
        }
        else {
            releaseRate = instrument.release[index];
            releaseCoefficient = instrument.releaseCoefficient[index];
        }

        if (g_debug) {
            console.log(this.instrumentBank);
            console.log("Program " + track.program);
            console.log("MIDI Note " + midiNote);
            console.log("Base MIDI Note: " + instrument.noteNumber[index]);

            if (instrumentType === InstrumentType.PsgPulse) {
                console.log("PSG Pulse");
            }

            console.log("Attack: " + attackRate);
            console.log("Decay: " + decayRate);
            console.log("Sustain: " + sustainRate);
            console.log("Release: " + releaseRate);

            console.log("Attack Coefficient: " + attackCoefficient);
            console.log("Decay Coefficient: " + decayCoefficient);
            console.log("Sustain Level: " + sustainLevel);
            console.log("Release Coefficient: " + releaseCoefficient);
        }

        var channel = null;
        var tieInPrevious = track.tie && track.lastActiveChannel;
        if (tieInPrevious) {
            channel = track.lastActiveChannel; //track.activeChannels[track.activeChannels.length - 1];
            var instr = this.synthesizers[trackNum].instrs[channel.synthInstrIndex];
            instr.setNote(midiNote);

            this.notesOn[trackNum][channel.midiNote] = 0;
            this.notesOn[trackNum][rawMidiNote] = 1;
            channel.midiNote = rawMidiNote;
            channel.velocity = velocity;
            channel.infiniteDuration = duration === 0 || track.tie;
            channel.endTime = this.sequence.ticksElapsed + duration + 1;
        }
        else {
            let decay = calcChannelDecay(track);
            let initialVolume = attackCoefficient === 0 ? calcChannelVolume(velocity, 0, decay) : 0;
            let synthInstrIndex = this.synthesizers[trackNum].play(sample, midiNote, initialVolume, this.sequence.ticksElapsed, isPsg, psgNoise);

            this.notesOn[trackNum][rawMidiNote] = 1;
            channel = {
                stopFlag: false,
                trackNum: trackNum,
                midiNote: rawMidiNote,
                velocity: velocity,
                decay: decay,
                synthInstrIndex: synthInstrIndex,
                startTime: this.sequence.ticksElapsed,
                endTime: this.sequence.ticksElapsed + duration + 1, // TODO: kind of fucky ik but this is what makes it play correctly
                infiniteDuration: duration === 0 || track.tie,
                instrument: instrument,
                instrumentEntryIndex: index,
                adsrState: AdsrState.Attack,
                adsrTimer: -92544, // idk why this number, ask gbatek
                fromKeyboard: fromKeyboard,
                lfoCounter: 0,
                lfoDelayCounter: 0,
                delayCounter: 0
            };
            this.activeNoteData.push(channel);
            track.activeChannels.push(channel);
            track.lastActiveChannel = channel;

            if (track.restingUntilAChannelEnds && duration === 0 && track.mono) {
                track.channelWaitingFor = channel;

                // Looping mono duration 0 channels make the track rest forever
                // TODO: I assume PSG noise loops
                if (psgNoise || sample.looping) {
                    track.restingForever = true;

                    // Fade out if all active tracks are resting forever
                    var shouldFadeOut = true;
                    for (var i = 0; i < 16; i++) {
                        if (!this.sequence.tracks[i].active)
                            continue;

                        if (!this.sequence.tracks[i].restingForever) {
                            shouldFadeOut = false;
                            break;
                        }
                    }
                    this.fadingStart ||= shouldFadeOut;
                }
            }

            this.synthesizers[trackNum].instrs[channel.synthInstrIndex].psgTick = 0x7fff;
        }

        var sweepPitch = track.sweepPitch + (track.portamentoEnable !== 0) * ((track.portamentoKey - rawMidiNote) << 6);
        var sweepLength;
        var autoSweep;
        if (track.portamentoTime) {
            sweepLength = (track.portamentoTime * track.portamentoTime * Math.abs(sweepPitch)) >> 11;
            autoSweep = true;
        }
        else {
            sweepLength = duration;
            autoSweep = false;
        }

        channel.sweepPitch = sweepPitch;
        channel.sweepCounter = sweepLength;
        channel.sweepLength = sweepLength;
        channel.autoSweep = autoSweep;
        this.updateNoteFinetuneLfo(channel);

        channel.attackCoefficient = attackCoefficient;
        channel.decayCoefficient = decayCoefficient;
        channel.sustainLevel = sustainLevel;
        channel.releaseCoefficient = releaseCoefficient;
    }
}

/**
 * @param {number} i
 * @param {number} bit
 */
function bitTest(i, bit) {
    return (i & (1 << bit)) !== 0;
}


/**
 * @param {AudioPlayer} player
 * @param {Controller} controller
 * @param {FsVisController} fsVisController
 */
function playController(player, controller, fsVisController) {
    const BUFFER_SIZE = player.bufferLength;
    const SAMPLE_RATE = player.sampleRate;
    console.log("Playing with sample rate: " + SAMPLE_RATE);

    let bufferL = new Float64Array(BUFFER_SIZE);
    let bufferR = new Float64Array(BUFFER_SIZE);

    let timer = 0;

    function synthesizeMore() {
        let startTimestamp = performance.now();

        for (let i = 0; i < BUFFER_SIZE; i++) {
            // nintendo DS clock speed
            timer += 33513982;
            // tick the sequence controller every (64 * 2728) cycles
            while (timer >= 64 * 2728 * SAMPLE_RATE) {
                timer -= 64 * 2728 * SAMPLE_RATE;

                controller.tick();
                fsVisController.tick();
            }

            if (g_useAccurateMixing) {
                let mixedSample = controller.nextSynthesizedMixedSample();
                bufferL[i] = mixedSample.valL;
                bufferR[i] = mixedSample.valR;
            }
            else {
                let valL = 0;
                let valR = 0;
                for (let i = 0; i < 16; i++) {
                    controller.synthesizers[i].nextSample();
                    if (g_trackEnables[i]) {
                        valL += controller.synthesizers[i].valL;
                        valR += controller.synthesizers[i].valR;
                    }
                }

                bufferL[i] = valL;
                bufferR[i] = valR;
            }
        }

        player.queueAudio(bufferL, bufferR);
    }
    player.needMoreSamples = synthesizeMore;

    synthesizeMore();
}

/**
 * @param {Sdat} sdat
 * @param {number} id
 */
async function playSeq(sdat, id) {
    g_currentlyPlayingSdat = sdat;
    await stopAndReleaseCurrentPlayer();

    const BUFFER_SIZE = 1024;
    let player = new AudioPlayer(BUFFER_SIZE, null, null);
    g_currentPlayer = player;
    const SAMPLE_RATE = player.sampleRate;
    console.log("Playing with sample rate: " + SAMPLE_RATE);

    g_currentlyPlayingId = id;
    g_currentlyPlayingIsSsar = false;

    let fsVisController = new FsVisController(384 * 5);
    let controller = new Controller(SAMPLE_RATE);
    controller.loadSseq(sdat, id);
    fsVisController.fsVisLoadSseq(sdat, id);
    if (g_enableRedundantCarryOverBug && g_currentController)
        controller.carryOverRedundantControllerData(g_currentController);

    controller.sequence.randomstate = g_enableCustomRNGSeed ? g_customRNGSeed : Math.round(Math.random() * 0xffffffff)|0;
    fsVisController.sequence.randomstate = controller.sequence.randomstate;
    fsVisController.runAhead();
    g_lastUsedRNGSeed = controller.sequence.randomstate;

    g_currentController = controller;
    currentFsVisController = fsVisController;

    playController(player, controller, fsVisController);
}

/**
 * @param {Sdat} sdat
 * @param {number} ssarId
 * @param {number} seqId
 */
async function playSsarSeq(sdat, ssarId, seqId) {
    g_currentlyPlayingSdat = sdat;
    await stopAndReleaseCurrentPlayer();

    const BUFFER_SIZE = 1024;
    let player = new AudioPlayer(BUFFER_SIZE, null, null); // TODO: a sample rate higher or lower than 32768 causes artifacts [nsmb drill, mkds ssar_0 sseq_311]
    g_currentPlayer = player;
    const SAMPLE_RATE = player.sampleRate;
    console.log("Playing with sample rate: " + SAMPLE_RATE);

    g_currentlyPlayingId = ssarId;
    g_currentlyPlayingSubId = seqId;
    g_currentlyPlayingIsSsar = true;

    let fsVisController = new FsVisController(384 * 5);
    let controller = new Controller(SAMPLE_RATE);
    controller.loadSsarSeq(sdat, ssarId, seqId);
    fsVisController.fsVisLoadSsarSeq(sdat, ssarId, seqId);
    if (g_enableRedundantCarryOverBug && g_currentController)
        controller.carryOverRedundantControllerData(g_currentController);

    controller.sequence.randomstate = g_enableCustomRNGSeed ? g_customRNGSeed : Math.round(Math.random() * 0xffffffff)|0;
    fsVisController.sequence.randomstate = controller.sequence.randomstate;
    fsVisController.runAhead();
    g_lastUsedRNGSeed = controller.sequence.randomstate;

    g_currentController = controller;
    currentFsVisController = fsVisController;

    playController(player, controller, fsVisController);
}

async function playStrm(sdat, strmId) {
    g_currentlyPlayingSdat = sdat;
    await stopAndReleaseCurrentPlayer();
    g_currentController = null;

    const BUFFER_SIZE = 1024;
    const SAMPLE_RATE = 32768;
    let player = new AudioPlayer(BUFFER_SIZE, null, SAMPLE_RATE);
    g_currentPlayer = player;
    console.log("Playing with sample rate: " + SAMPLE_RATE);

    let strmInfo = sdat.strmInfos[strmId];
    let strmFile = sdat.fat.get(strmInfo.fileId);
    playStrmData(strmFile, player);
}

async function stopAndReleaseCurrentPlayer() {
    if (!g_currentPlayer)
        return;

    g_currentPlayer.ctx.onended = null;
    await g_currentPlayer?.ctx.close();
    g_currentPlayer = null;
}

/**
 * @param {Sample} sample
 */
async function downloadSample(sample) {
    let totalSamples = 0;
    let downloader = new WavEncoder(sample.sampleRate, 16);
    for (let i = 0; i < sample.data.length; i++) {
        let val = sample.data[i];
        downloader.addSample(val, val);
        totalSamples++;
    }

    for (let i = 0; i < 2; i++) {
        let pos = sample.loopPoint;
        console.log(totalSamples);
        while (pos < sample.data.length) {
            let val = sample.data[pos++];
            downloader.addSample(val, val);
            totalSamples++;
        }
    }

    downloadUint8Array("sample.wav", downloader.encode());
}

async function downloadSdatFile(sdat) {
    var data = new Uint8Array(sdat.rawView.byteLength);
    for (var i = 0; i < data.length; i++)
        data[i] = sdat.rawView.getUint8(i);

    downloadUint8Array("sounddata.sdat", data);
}

/**
 * @param {number} val
 * @param {number} min
 * @param {number} max
 */
function clamp(val, min, max) {
    return Math.min(Math.max(val, min), max);
}

/**
 * @param {DataView} pcm8Data
 */
function decodePcm8(pcm8Data) {
    let out = new Float64Array(pcm8Data.byteLength);

    for (let i = 0; i < out.length; i++) {
        out[i] = (read8(pcm8Data, i) << 24 >> 24) / 128;
    }

    return out;
}

/**
 * @param {DataView} pcm16Data
 */
function decodePcm16(pcm16Data) {
    let out = new Float64Array(pcm16Data.byteLength >> 1);

    for (let i = 0; i < out.length; i++) {
        out[i] = ((read16LE(pcm16Data, i * 2) << 16) >> 16) / 32768;
    }

    return out;
}

const indexTable = [-1, -1, -1, -1, 2, 4, 6, 8];
const adpcmTable = [
    0x0007, 0x0008, 0x0009, 0x000A, 0x000B, 0x000C, 0x000D, 0x000E, 0x0010, 0x0011, 0x0013, 0x0015,
    0x0017, 0x0019, 0x001C, 0x001F, 0x0022, 0x0025, 0x0029, 0x002D, 0x0032, 0x0037, 0x003C, 0x0042,
    0x0049, 0x0050, 0x0058, 0x0061, 0x006B, 0x0076, 0x0082, 0x008F, 0x009D, 0x00AD, 0x00BE, 0x00D1,
    0x00E6, 0x00FD, 0x0117, 0x0133, 0x0151, 0x0173, 0x0198, 0x01C1, 0x01EE, 0x0220, 0x0256, 0x0292,
    0x02D4, 0x031C, 0x036C, 0x03C3, 0x0424, 0x048E, 0x0502, 0x0583, 0x0610, 0x06AB, 0x0756, 0x0812,
    0x08E0, 0x09C3, 0x0ABD, 0x0BD0, 0x0CFF, 0x0E4C, 0x0FBA, 0x114C, 0x1307, 0x14EE, 0x1706, 0x1954,
    0x1BDC, 0x1EA5, 0x21B6, 0x2515, 0x28CA, 0x2CDF, 0x315B, 0x364B, 0x3BB9, 0x41B2, 0x4844, 0x4F7E,
    0x5771, 0x602F, 0x69CE, 0x7462, 0x7FFF
];

/**
 * Decodes IMA-ADPCM to PCM16
 * @param {DataView} adpcmData
 */
function decodeAdpcm(adpcmData) {
    let out = new Float64Array((adpcmData.byteLength - 4) * 2);
    let outOffs = 0;

    // ADPCM header
    let header = read32LE(adpcmData, 0);
    let currentValue = header & 0xFFFF;
    let adpcmIndex = clamp(header >> 16, 0, 88);

    for (let i = 4; i < adpcmData.byteLength; i++) {
        for (let j = 0; j < 2; j++) {
            let data = (adpcmData.getUint8(i) >> (j * 4)) & 0xF;

            let tableVal = adpcmTable[adpcmIndex];
            let diff = tableVal >> 3;
            if ((data & 1) !== 0) diff += tableVal >> 2;
            if ((data & 2) !== 0) diff += tableVal >> 1;
            if ((data & 4) !== 0) diff += tableVal >> 0;

            if ((data & 8) === 8) {
                currentValue = Math.max(currentValue - diff, -0x7FFF);
            } else {
                currentValue = Math.min(currentValue + diff, 0x7FFF);
            }
            adpcmIndex = clamp(adpcmIndex + indexTable[data & 7], 0, 88);

            out[outOffs++] = currentValue / 32768;
        }
    }

    return out;
}

/**
 * Decodes multiple IMA-ADPCM blocks to one PCM16 array
 * @param {DataView} adpcmData
 * @param {number} numberOfBlocks
 * @param {number} blockLength
 * @param {number} nOfChannels
 * @param {number} channelNo
 */
function decodeAdpcmBlocks(adpcmData, numberOfBlocks, blockLength, nOfChannels, channelNo) {
    let out = new Float64Array((adpcmData.byteLength/nOfChannels - 4*numberOfBlocks) * 2);
    let outOffs = 0;
    let currentValue = read16LE(adpcmData, 0);
    let adpcmIndex;

    for (let i = 0; i < numberOfBlocks; i++) {
        let blockStart = (i * nOfChannels + channelNo) * blockLength;

        // ADPCM block header (only first block uses currentValue field, all use adpcmIndex field)
        adpcmIndex = clamp(read16LE(adpcmData, blockStart + 2), 0, 88);

        for (let j = 4; j < blockLength; j++) {
            for (let k = 0; k < 2; k++) {
                let data = (adpcmData.getUint8(blockStart + j) >> (k * 4)) & 0xF;

                let tableVal = adpcmTable[adpcmIndex];
                let diff = tableVal >> 3;
                if ((data & 1) !== 0) diff += tableVal >> 2;
                if ((data & 2) !== 0) diff += tableVal >> 1;
                if ((data & 4) !== 0) diff += tableVal >> 0;

                if ((data & 8) === 8) {
                    currentValue = Math.max(currentValue - diff, -0x7FFF);
                } else {
                    currentValue = Math.min(currentValue + diff, 0x7FFF);
                }
                adpcmIndex = clamp(adpcmIndex + indexTable[data & 7], 0, 88);

                out[outOffs++] = currentValue / 32768;
            }
        }
    }

    return out;
}

/**
 * @param {DataView} wavData
 * @param {number} sampleFrequency
 */
function decodeWavToSample(wavData, sampleFrequency) {
    /** @type {number[]} */
    let sampleData = [];

    let numChannels = read16LE(wavData, 22);
    let sampleRate = read32LE(wavData, 24);
    let bitsPerSample = read16LE(wavData, 34);

    console.log("decodeWav: sample rate: " + sampleRate);

    switch (bitsPerSample) {
        case 8:
        case 16:
            break;
        default:
            console.error("decodeWav: unsupported bits per sample: " + bitsPerSample);
            return;
    }

    // Number of bytes in the wav data
    let subchunk2Size = read32LE(wavData, 40);

    for (let i = 44; i < 44 + subchunk2Size; i += bitsPerSample / 8 * numChannels) {
        switch (bitsPerSample) {
            case 8:
                sampleData.push(read8(wavData, i) / 255);
                break;
            case 16:
                sampleData.push(((read16LE(wavData, i) << 16) >> 16) / 32767);
                break;
            default:
                throw new Error();
        }
    }

    return new Sample(Float64Array.from(sampleData), sampleFrequency, sampleRate, -1, false, 0);
}

/**
 * @param {DataView} strmData
 */
function playStrmData(strmData, player) {
    const BUFFER_SIZE = player.bufferLength;
    const SAMPLE_RATE = player.sampleRate;

    let bufferL = new Float64Array(BUFFER_SIZE);
    let bufferR = new Float64Array(BUFFER_SIZE);

    console.log("Number of Samples: " + read32LE(strmData, 0x24));

    let channels = read8(strmData, 0x1A);
    let numberOfBlocks = read32LE(strmData, 0x2C);
    let blockLength = read32LE(strmData, 0x30);
    let samplesPerBlock = read32LE(strmData, 0x34);
    let lastBlockLength = read32LE(strmData, 0x38);
    let lastBlockSamples = read32LE(strmData, 0x3C);

    console.log("Channels: " + channels);
    console.log("Number of blocks per channel: " + numberOfBlocks);
    console.log("Block length: " + blockLength);
    console.log("Samples per block: " + samplesPerBlock);
    console.log("Last block length: " + lastBlockLength);
    console.log("Last block samples: " + lastBlockSamples);

    if (channels > 2) {
        console.log("Why are there more than 2 channels?");
    }
    let mono = (channels < 2);

    let sampleRate = read16LE(strmData, 0x1C);
    console.log("Sample Rate: " + sampleRate);
    console.log("Time: " + read16LE(strmData, 0x1E));

    let looping = read8(strmData, 0x19) !== 0;
    let loopPoint = read32LE(strmData, 0x20);
    console.log("Looping: " + looping);
    console.log("Loop point: " + loopPoint);

    let waveDataSizePerChan = blockLength * numberOfBlocks;

    console.log("Strm file data size: " + strmData.byteLength);
    console.log("Total wave data size: " + waveDataSizePerChan * channels);

    let waveDataL;
    let waveDataR;
    /** @type {Float64Array} */
    let decodedL;
    /** @type {Float64Array} */
    let decodedR;
    let format;
    switch (read8(strmData, 0x18)) {
        case 0:
            format = "PCM8";
            waveDataL = createRelativeDataView(strmData, 0x68, waveDataSizePerChan);
            waveDataR = mono ? null : createRelativeDataView(strmData, 0x68 + blockLength, waveDataSizePerChan);
            decodedL = decodePcm8(waveDataL);
            decodedR = mono ? decodedL : decodePcm8(waveDataR);
            break;
        case 1:
            format = "PCM16";
            waveDataL = createRelativeDataView(strmData, 0x68, waveDataSizePerChan);
            waveDataR = mono ? null : createRelativeDataView(strmData, 0x68 + blockLength, waveDataSizePerChan);
            decodedL = decodePcm16(waveDataL);
            decodedR = mono ? decodedL : decodePcm16(waveDataR);
            break;
        case 2:
            format = "IMA-ADPCM";
            numberOfBlocks -= (numberOfBlocks > 1); // Last block seems to always be 0xFF (or maybe that's only the case if last block < normal block length?)
            waveData = createRelativeDataView(strmData, 0x68, blockLength * numberOfBlocks * channels);
            decodedL = decodeAdpcmBlocks(waveData, numberOfBlocks, blockLength, channels, 0);
            decodedR = mono ? decodedL : decodeAdpcmBlocks(waveData, numberOfBlocks, blockLength, channels, 1);
            break;
        default:
            throw new Error();
    }

    console.log("Format: " + format);

    let inBufferPos = 0;
    let timer = 0;

    function synthesizeMore() {
        let ended = false;

        for (let i = 0; i < BUFFER_SIZE; i++) {
            bufferL[i] = decodedL[inBufferPos];
            bufferR[i] = decodedR[inBufferPos];

            timer += sampleRate;
            while (timer >= SAMPLE_RATE) { // TODO: interpolation options?
                timer -= SAMPLE_RATE;

                if (++inBufferPos >= decodedL.length) {
                    if (looping) {
                        inBufferPos = loopPoint;
                    }
                    else {
                        player.shouldEndPlaybackAfter = true;
                        inBufferPos = decodedL.length - 1;
                    }
                }
            }
        }

        player.queueAudio(bufferL, bufferR);
    }

    player.needMoreSamples = synthesizeMore;
    player.onEndedPlayback = function() {
        g_currentPlayer = null;
    };
    synthesizeMore();
}

/**
 * @param {Sample} sample
 * */
function playSample(sample) {
    return /** @type {Promise<void>} */(new Promise(resolve => {
        const BUFFER_SIZE = 4096;
        const SAMPLE_RATE = sample.sampleRate;

        let bufferL = new Float64Array(BUFFER_SIZE);
        let bufferR = new Float64Array(BUFFER_SIZE);

        let inBufferPos = 0;
        let timer = 0;

        function synthesizeMore() {

            let ended = false;

            for (let i = 0; i < BUFFER_SIZE; i++) {
                if (inBufferPos >= sample.data.length) {
                    ended = true;
                    bufferL[i] = 0;
                    bufferR[i] = 0;
                } else {
                    bufferL[i] = sample.data[inBufferPos];
                    bufferR[i] = sample.data[inBufferPos];
                }

                timer += sample.sampleRate;
                if (timer >= SAMPLE_RATE) {
                    timer -= SAMPLE_RATE;

                    inBufferPos++;
                }
            }

            if (ended) {
                resolve();
                return;
            }

            player.queueAudio(bufferL, bufferR);

        }

        let player = new AudioPlayer(BUFFER_SIZE, synthesizeMore, SAMPLE_RATE);
        synthesizeMore();
    }));
}

/**
 * pureRootNote is an offset from A in
 * @returns {number}
 * @param {number} note
 */
function midiNoteToHz(note) {
    if (g_usePureTuning) {
        let roundError = note - Math.round(note);
        note = Math.round(note);

        let noteRelRoot = note - 69 - g_pureTuningTonic;
        let octave = Math.floor(noteRelRoot / 12);
        let noteInOctave = ((noteRelRoot % 12) + 12) % 12;
        let rootNoteHz = 440 * 2 ** (((g_pureTuningTonic + roundError) / 12) + octave);

        const pythagoreanTuningRatios = [
            1,          // Do / C
            256 / 243,  // Di / C#
            9 / 8,      // Re / D
            32 / 27,    // Ri / D#
            81 / 64,    // Mi / E
            4 / 3,      // Fa / F
            729 / 512,  // Fi / F#
            3 / 2,      // So / G
            128 / 81,   // Si / G#
            27 / 16,    // La / A
            16 / 9,     // Li / A#
            243 / 128,  // Ti / B
        ]

        return rootNoteHz * pythagoreanTuningRatios[noteInOctave];
    } else {
        return 440 * 2 ** ((note - 69) / 12);
    }
}

// src: pret/pokediamond
// TODO: can be optimized, probably doesnt need BigInt
function midiNoteToTimer(timer, note, finetune) {
    var pitch = note * 0x40 + Math.floor(finetune * 64);

    var octave = 0n;
    var pitch_normalized = BigInt(-pitch);

    while (pitch_normalized < 0n)
    {
        octave--;
        pitch_normalized += 768n;
    }

    while (pitch_normalized >= 768n)
    {
        octave++;
        pitch_normalized -= 768n;
    }

    var result = BigInt(BIOS_pitchTable[pitch_normalized]);

    result += 0x10000n;
    result *= BigInt(timer);

    var shift = octave - 16n;

    if (shift <= 0n)
    {
        shift = -shift;
        result >>= shift;
    }
    else if (shift < 32n)
    {
        // clamp in case timer value overflows
        var tmp = result & 0xFFFFFFFFFFFFFFFFn << (32n - shift);
        if (tmp != 0)
            return 0xFFFF;
        result <<= shift;
        // if (result > 0xFFFFn)
        //     return 0x10000 - 0xFFFF;
    }
    else
    {
        return 0xFFFF;
    }

    if (result < 0x10n)
        result = 0x10n;
    else if (result > 0xFFFFn)
        result = 0xFFFFn;

    return Number(result);
}

// src: RocketRobz/SSEQPlayer
const BIOS_pitchTable = [
    0x0000, 0x003B, 0x0076, 0x00B2, 0x00ED, 0x0128, 0x0164, 0x019F, 0x01DB, 0x0217, 0x0252, 0x028E, 0x02CA, 0x0305, 0x0341, 0x037D, // 0x0-0xF
    0x03B9, 0x03F5, 0x0431, 0x046E, 0x04AA, 0x04E6, 0x0522, 0x055F, 0x059B, 0x05D8, 0x0614, 0x0651, 0x068D, 0x06CA, 0x0707, 0x0743, // 0x10-0x1F
    0x0780, 0x07BD, 0x07FA, 0x0837, 0x0874, 0x08B1, 0x08EF, 0x092C, 0x0969, 0x09A7, 0x09E4, 0x0A21, 0x0A5F, 0x0A9C, 0x0ADA, 0x0B18, // 0x20-0x2F
    0x0B56, 0x0B93, 0x0BD1, 0x0C0F, 0x0C4D, 0x0C8B, 0x0CC9, 0x0D07, 0x0D45, 0x0D84, 0x0DC2, 0x0E00, 0x0E3F, 0x0E7D, 0x0EBC, 0x0EFA, // 0x30-0x3F
    0x0F39, 0x0F78, 0x0FB6, 0x0FF5, 0x1034, 0x1073, 0x10B2, 0x10F1, 0x1130, 0x116F, 0x11AE, 0x11EE, 0x122D, 0x126C, 0x12AC, 0x12EB, // 0x40-0x4F
    0x132B, 0x136B, 0x13AA, 0x13EA, 0x142A, 0x146A, 0x14A9, 0x14E9, 0x1529, 0x1569, 0x15AA, 0x15EA, 0x162A, 0x166A, 0x16AB, 0x16EB, // 0x50-0x5F
    0x172C, 0x176C, 0x17AD, 0x17ED, 0x182E, 0x186F, 0x18B0, 0x18F0, 0x1931, 0x1972, 0x19B3, 0x19F5, 0x1A36, 0x1A77, 0x1AB8, 0x1AFA, // 0x60-0x6F
    0x1B3B, 0x1B7D, 0x1BBE, 0x1C00, 0x1C41, 0x1C83, 0x1CC5, 0x1D07, 0x1D48, 0x1D8A, 0x1DCC, 0x1E0E, 0x1E51, 0x1E93, 0x1ED5, 0x1F17, // 0x70-0x7F
    0x1F5A, 0x1F9C, 0x1FDF, 0x2021, 0x2064, 0x20A6, 0x20E9, 0x212C, 0x216F, 0x21B2, 0x21F5, 0x2238, 0x227B, 0x22BE, 0x2301, 0x2344, // 0x80-0x8F
    0x2388, 0x23CB, 0x240E, 0x2452, 0x2496, 0x24D9, 0x251D, 0x2561, 0x25A4, 0x25E8, 0x262C, 0x2670, 0x26B4, 0x26F8, 0x273D, 0x2781, // 0x90-0x9F
    0x27C5, 0x280A, 0x284E, 0x2892, 0x28D7, 0x291C, 0x2960, 0x29A5, 0x29EA, 0x2A2F, 0x2A74, 0x2AB9, 0x2AFE, 0x2B43, 0x2B88, 0x2BCD, // 0xA0-0xAF
    0x2C13, 0x2C58, 0x2C9D, 0x2CE3, 0x2D28, 0x2D6E, 0x2DB4, 0x2DF9, 0x2E3F, 0x2E85, 0x2ECB, 0x2F11, 0x2F57, 0x2F9D, 0x2FE3, 0x302A, // 0xB0-0xBF
    0x3070, 0x30B6, 0x30FD, 0x3143, 0x318A, 0x31D0, 0x3217, 0x325E, 0x32A5, 0x32EC, 0x3332, 0x3379, 0x33C1, 0x3408, 0x344F, 0x3496, // 0xC0-0xCF
    0x34DD, 0x3525, 0x356C, 0x35B4, 0x35FB, 0x3643, 0x368B, 0x36D3, 0x371A, 0x3762, 0x37AA, 0x37F2, 0x383A, 0x3883, 0x38CB, 0x3913, // 0xD0-0xDF
    0x395C, 0x39A4, 0x39ED, 0x3A35, 0x3A7E, 0x3AC6, 0x3B0F, 0x3B58, 0x3BA1, 0x3BEA, 0x3C33, 0x3C7C, 0x3CC5, 0x3D0E, 0x3D58, 0x3DA1, // 0xE0-0xEF
    0x3DEA, 0x3E34, 0x3E7D, 0x3EC7, 0x3F11, 0x3F5A, 0x3FA4, 0x3FEE, 0x4038, 0x4082, 0x40CC, 0x4116, 0x4161, 0x41AB, 0x41F5, 0x4240, // 0xF0-0xFF
    0x428A, 0x42D5, 0x431F, 0x436A, 0x43B5, 0x4400, 0x444B, 0x4495, 0x44E1, 0x452C, 0x4577, 0x45C2, 0x460D, 0x4659, 0x46A4, 0x46F0, // 0x100-0x10F
    0x473B, 0x4787, 0x47D3, 0x481E, 0x486A, 0x48B6, 0x4902, 0x494E, 0x499A, 0x49E6, 0x4A33, 0x4A7F, 0x4ACB, 0x4B18, 0x4B64, 0x4BB1, // 0x110-0x11F
    0x4BFE, 0x4C4A, 0x4C97, 0x4CE4, 0x4D31, 0x4D7E, 0x4DCB, 0x4E18, 0x4E66, 0x4EB3, 0x4F00, 0x4F4E, 0x4F9B, 0x4FE9, 0x5036, 0x5084, // 0x120-0x12F
    0x50D2, 0x5120, 0x516E, 0x51BC, 0x520A, 0x5258, 0x52A6, 0x52F4, 0x5343, 0x5391, 0x53E0, 0x542E, 0x547D, 0x54CC, 0x551A, 0x5569, // 0x130-0x13F
    0x55B8, 0x5607, 0x5656, 0x56A5, 0x56F4, 0x5744, 0x5793, 0x57E2, 0x5832, 0x5882, 0x58D1, 0x5921, 0x5971, 0x59C1, 0x5A10, 0x5A60, // 0x140-0x14F
    0x5AB0, 0x5B01, 0x5B51, 0x5BA1, 0x5BF1, 0x5C42, 0x5C92, 0x5CE3, 0x5D34, 0x5D84, 0x5DD5, 0x5E26, 0x5E77, 0x5EC8, 0x5F19, 0x5F6A, // 0x150-0x15F
    0x5FBB, 0x600D, 0x605E, 0x60B0, 0x6101, 0x6153, 0x61A4, 0x61F6, 0x6248, 0x629A, 0x62EC, 0x633E, 0x6390, 0x63E2, 0x6434, 0x6487, // 0x160-0x16F
    0x64D9, 0x652C, 0x657E, 0x65D1, 0x6624, 0x6676, 0x66C9, 0x671C, 0x676F, 0x67C2, 0x6815, 0x6869, 0x68BC, 0x690F, 0x6963, 0x69B6, // 0x170-0x17F
    0x6A0A, 0x6A5E, 0x6AB1, 0x6B05, 0x6B59, 0x6BAD, 0x6C01, 0x6C55, 0x6CAA, 0x6CFE, 0x6D52, 0x6DA7, 0x6DFB, 0x6E50, 0x6EA4, 0x6EF9, // 0x180-0x18F
    0x6F4E, 0x6FA3, 0x6FF8, 0x704D, 0x70A2, 0x70F7, 0x714D, 0x71A2, 0x71F7, 0x724D, 0x72A2, 0x72F8, 0x734E, 0x73A4, 0x73FA, 0x7450, // 0x190-0x19F
    0x74A6, 0x74FC, 0x7552, 0x75A8, 0x75FF, 0x7655, 0x76AC, 0x7702, 0x7759, 0x77B0, 0x7807, 0x785E, 0x78B4, 0x790C, 0x7963, 0x79BA, // 0x1A0-0x1AF
    0x7A11, 0x7A69, 0x7AC0, 0x7B18, 0x7B6F, 0x7BC7, 0x7C1F, 0x7C77, 0x7CCF, 0x7D27, 0x7D7F, 0x7DD7, 0x7E2F, 0x7E88, 0x7EE0, 0x7F38, // 0x1B0-0x1BF
    0x7F91, 0x7FEA, 0x8042, 0x809B, 0x80F4, 0x814D, 0x81A6, 0x81FF, 0x8259, 0x82B2, 0x830B, 0x8365, 0x83BE, 0x8418, 0x8472, 0x84CB, // 0x1C0-0x1CF
    0x8525, 0x857F, 0x85D9, 0x8633, 0x868E, 0x86E8, 0x8742, 0x879D, 0x87F7, 0x8852, 0x88AC, 0x8907, 0x8962, 0x89BD, 0x8A18, 0x8A73, // 0x1D0-0x1DF
    0x8ACE, 0x8B2A, 0x8B85, 0x8BE0, 0x8C3C, 0x8C97, 0x8CF3, 0x8D4F, 0x8DAB, 0x8E07, 0x8E63, 0x8EBF, 0x8F1B, 0x8F77, 0x8FD4, 0x9030, // 0x1E0-0x1EF
    0x908C, 0x90E9, 0x9146, 0x91A2, 0x91FF, 0x925C, 0x92B9, 0x9316, 0x9373, 0x93D1, 0x942E, 0x948C, 0x94E9, 0x9547, 0x95A4, 0x9602, // 0x1F0-0x1FF
    0x9660, 0x96BE, 0x971C, 0x977A, 0x97D8, 0x9836, 0x9895, 0x98F3, 0x9952, 0x99B0, 0x9A0F, 0x9A6E, 0x9ACD, 0x9B2C, 0x9B8B, 0x9BEA, // 0x200-0x20F
    0x9C49, 0x9CA8, 0x9D08, 0x9D67, 0x9DC7, 0x9E26, 0x9E86, 0x9EE6, 0x9F46, 0x9FA6, 0xA006, 0xA066, 0xA0C6, 0xA127, 0xA187, 0xA1E8, // 0x210-0x21F
    0xA248, 0xA2A9, 0xA30A, 0xA36B, 0xA3CC, 0xA42D, 0xA48E, 0xA4EF, 0xA550, 0xA5B2, 0xA613, 0xA675, 0xA6D6, 0xA738, 0xA79A, 0xA7FC, // 0x220-0x22F
    0xA85E, 0xA8C0, 0xA922, 0xA984, 0xA9E7, 0xAA49, 0xAAAC, 0xAB0E, 0xAB71, 0xABD4, 0xAC37, 0xAC9A, 0xACFD, 0xAD60, 0xADC3, 0xAE27, // 0x230-0x23F
    0xAE8A, 0xAEED, 0xAF51, 0xAFB5, 0xB019, 0xB07C, 0xB0E0, 0xB145, 0xB1A9, 0xB20D, 0xB271, 0xB2D6, 0xB33A, 0xB39F, 0xB403, 0xB468, // 0x240-0x24F
    0xB4CD, 0xB532, 0xB597, 0xB5FC, 0xB662, 0xB6C7, 0xB72C, 0xB792, 0xB7F7, 0xB85D, 0xB8C3, 0xB929, 0xB98F, 0xB9F5, 0xBA5B, 0xBAC1, // 0x250-0x25F
    0xBB28, 0xBB8E, 0xBBF5, 0xBC5B, 0xBCC2, 0xBD29, 0xBD90, 0xBDF7, 0xBE5E, 0xBEC5, 0xBF2C, 0xBF94, 0xBFFB, 0xC063, 0xC0CA, 0xC132, // 0x260-0x26F
    0xC19A, 0xC202, 0xC26A, 0xC2D2, 0xC33A, 0xC3A2, 0xC40B, 0xC473, 0xC4DC, 0xC544, 0xC5AD, 0xC616, 0xC67F, 0xC6E8, 0xC751, 0xC7BB, // 0x270-0x27F
    0xC824, 0xC88D, 0xC8F7, 0xC960, 0xC9CA, 0xCA34, 0xCA9E, 0xCB08, 0xCB72, 0xCBDC, 0xCC47, 0xCCB1, 0xCD1B, 0xCD86, 0xCDF1, 0xCE5B, // 0x280-0x28F
    0xCEC6, 0xCF31, 0xCF9C, 0xD008, 0xD073, 0xD0DE, 0xD14A, 0xD1B5, 0xD221, 0xD28D, 0xD2F8, 0xD364, 0xD3D0, 0xD43D, 0xD4A9, 0xD515, // 0x290-0x29F
    0xD582, 0xD5EE, 0xD65B, 0xD6C7, 0xD734, 0xD7A1, 0xD80E, 0xD87B, 0xD8E9, 0xD956, 0xD9C3, 0xDA31, 0xDA9E, 0xDB0C, 0xDB7A, 0xDBE8, // 0x2A0-0x2AF
    0xDC56, 0xDCC4, 0xDD32, 0xDDA0, 0xDE0F, 0xDE7D, 0xDEEC, 0xDF5B, 0xDFC9, 0xE038, 0xE0A7, 0xE116, 0xE186, 0xE1F5, 0xE264, 0xE2D4, // 0x2B0-0x2BF
    0xE343, 0xE3B3, 0xE423, 0xE493, 0xE503, 0xE573, 0xE5E3, 0xE654, 0xE6C4, 0xE735, 0xE7A5, 0xE816, 0xE887, 0xE8F8, 0xE969, 0xE9DA, // 0x2C0-0x2CF
    0xEA4B, 0xEABC, 0xEB2E, 0xEB9F, 0xEC11, 0xEC83, 0xECF5, 0xED66, 0xEDD9, 0xEE4B, 0xEEBD, 0xEF2F, 0xEFA2, 0xF014, 0xF087, 0xF0FA, // 0x2D0-0x2DF
    0xF16D, 0xF1E0, 0xF253, 0xF2C6, 0xF339, 0xF3AD, 0xF420, 0xF494, 0xF507, 0xF57B, 0xF5EF, 0xF663, 0xF6D7, 0xF74C, 0xF7C0, 0xF834, // 0x2E0-0x2EF
    0xF8A9, 0xF91E, 0xF992, 0xFA07, 0xFA7C, 0xFAF1, 0xFB66, 0xFBDC, 0xFC51, 0xFCC7, 0xFD3C, 0xFDB2, 0xFE28, 0xFE9E, 0xFF14, 0xFF8A  // 0x2F0-0x2FF
];


/**
 * @param {DataView} view
 * @param {string | any[]} sequence
 */
function searchDataViewForSequence(view, sequence) {
    let seqs = [];

    for (let i = 0; i < view.byteLength; i++) {
        if (view.getUint8(i) === sequence[0]) {
            for (let j = 1; j < sequence.length; j++) {
                if (view.getUint8(i + j) !== sequence[j]) {
                    break;
                }

                if (j === sequence.length - 1) seqs.push(i);
            }
        }
    }

    return seqs;
}

/**
 * @param {DataView} view
 * @param {string | any[]} sequence
 */
function findFirstSequenceInDataView(view, sequence) {
    for (let i = 0; i < view.byteLength; i++) {
        if (view.getUint8(i) === sequence[0]) {
            for (let j = 1; j < sequence.length; j++) {
                if (view.getUint8(i + j) !== sequence[j]) {
                    break;
                }

                if (j === sequence.length - 1) return i;
            }
        }
    }

    return -1;
}

/**
 * THIS IS STARTING FROM THE KEY OF A
 * index is the "key in the octave"
 * @type {{[index: number]: number}} */
const getKeyNum = {
    0: 0,
    2: 1,
    3: 2,
    5: 3,
    7: 4,
    8: 5,
    10: 6,
    1: 0,
    4: 2,
    6: 3,
    9: 5,
    11: 6,
};

/**
 * THIS IS STARTING FROM THE KEY OF A
 * index is the "key in the octave"
 * @type {{[index: number]: boolean}} */
const isBlackKey = {
    0: false,
    2: false,
    3: false,
    5: false,
    7: false,
    8: false,
    10: false,
    1: true,
    4: true,
    6: true,
    9: true,
    11: true,
};

const fsVisPalette = [
    "#da3fb1",
    "#ad42ba",
    "#5443c2",
    "#2b68d7",
    "#3095f2",
    "#2acdfe",
    "#2bceff",
    "#52ddf6",
    "#57d677",
    "#5ed62e",
    "#aeeb20",
    "#fef711",
    "#ff991d",
    "#ff641d",
    "#ff1434",
    "#fa30a3",
];

let activeNoteTrackNums = new Int8Array(128).fill(-1);
let lastTickTime = 0;
let lastTicks = 0;

/**
 @param {CanvasRenderingContext2D} ctx
 @param {number} time
 @param {number} noteAlpha */
function drawFsVis(ctx, time, noteAlpha) {
    ctx.imageSmoothingEnabled = false;

    // normalize to 0-1 on both axes
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(ctx.canvas.width - 1, ctx.canvas.height - 1);
    ctx.fillStyle = "#222222";
    ctx.fillRect(0, 0, 1, 1);

    let wKeyWidth = 1 / 52;
    let wKeyHeight = 1 / 7;
    let pixelX = 1 / ctx.canvas.width;
    let pixelY = 1 / ctx.canvas.height;

    ctx.fillStyle = "#FF0000";
    if (currentFsVisController && g_currentController && g_currentlyPlayingSdat) {

        let activeNotes = currentFsVisController.activeNotes;

        if (lastTicks !== currentFsVisController.sequence.ticksElapsed) {
            lastTickTime = time;
        }
        ctx.globalAlpha = noteAlpha;

        let drew = 0;
        for (let i = 0; i < activeNotes.entries; i++) {
            let entry = activeNotes.peek(i);
            let midiNote = entry.param0;
            let duration = entry.param2;

            let bpm = g_currentController.sequence.bpm;
            let sPerTick = (1 / (bpm / 60)) / 48;

            let ticksAdj = g_currentController.sequence.ticksElapsed - g_currentController.sequence.ticksElapsedPaused;
            if (!g_playbackPaused)
                ticksAdj += (time - lastTickTime) / 1000 / sPerTick;
            let relTime = entry.timestamp - ticksAdj;

            let pianoKey = midiNote - 21;

            let ticksToDisplay = 384;

            let height = duration / ticksToDisplay;
            let y = 1 - relTime / ticksToDisplay - height - wKeyHeight;
            if (y + height >= 1 - wKeyHeight) {
                height = 1 - wKeyHeight - y;
            }

            let octave = Math.floor(pianoKey / 12);
            let keyInOctave = pianoKey % 12;

            let keyNum = getKeyNum[keyInOctave];
            let blackKey = isBlackKey[keyInOctave];

            let whiteKeyNum = octave * 7 + keyNum;
            ctx.strokeStyle = "#444444";

            ctx.lineWidth = 0.001;

            if (y < 1 - wKeyHeight && y + height > 0) {
                if (!blackKey) {
                    ctx.fillStyle = fsVisPalette[entry.trackNum];

                    let x = whiteKeyNum * wKeyWidth;
                    let w = wKeyWidth - pixelX * 2;
                    let h = height;

                    ctx.fillRect(x, y, w, h);
                    ctx.strokeRect(x, y, w, h);

                    if (relTime < 0 && relTime > -duration) {
                        activeNoteTrackNums[midiNote] = entry.trackNum;
                    }
                } else {
                    ctx.fillStyle = fsVisPalette[entry.trackNum];

                    let x = whiteKeyNum * wKeyWidth + wKeyWidth * 0.5;
                    let w = wKeyWidth - pixelX * 2;
                    let h = height;

                    ctx.fillRect(x, y, w, h);
                    ctx.strokeRect(x, y, w, h);

                    if (relTime < 0 && relTime > -duration) {
                        activeNoteTrackNums[midiNote] = entry.trackNum;
                    }
                }
                drew++;
            }
        }

        // console.log("Drew " + drew + "Notes");

        /**
         * @param {boolean} black
         */
        function drawKeys(black) {
            // piano has 88 keys
            for (let j = 0; j < 88; j++) {
                let midiNote = j + 21; // lowest piano note is 21 on midi

                // using the key of A as octave base
                let octave = Math.floor(j / 12);
                let keyInOctave = j % 12;

                let keyNum = getKeyNum[keyInOctave];
                let blackKey = isBlackKey[keyInOctave];

                if (blackKey === black) {
                    let whiteKeyNum = octave * 7 + keyNum;

                    if (!blackKey) {
                        if (activeNoteTrackNums[midiNote] !== -1) {
                            ctx.fillStyle = fsVisPalette[activeNoteTrackNums[midiNote]];
                            activeNoteTrackNums[midiNote] = -1;
                        } else {
                            ctx.fillStyle = "#ffffff";
                        }

                        let x = whiteKeyNum * wKeyWidth;
                        let y = 1 - wKeyHeight;
                        let w = wKeyWidth - pixelX * 2;
                        let h = wKeyHeight;

                        ctx.fillRect(x, y, w, h);
                    } else {
                        if (activeNoteTrackNums[midiNote] !== -1) {
                            ctx.fillStyle = fsVisPalette[activeNoteTrackNums[midiNote]];
                            activeNoteTrackNums[midiNote] = -1;
                        } else {
                            ctx.fillStyle = "#000000";
                        }

                        let x = whiteKeyNum * wKeyWidth + wKeyWidth * 0.5;
                        let y = 1 - wKeyHeight;
                        let w = wKeyWidth - pixelX * 2;
                        let h = wKeyHeight * 0.58;

                        ctx.fillRect(x, y, w, h);
                    }
                }
            }
        }

        drawKeys(false);
        drawKeys(true);

        ctx.setTransform(1, 0, 0, 1, 0, 0);

        ctx.globalAlpha = 1;
        ctx.textBaseline = "top";
        ctx.fillStyle = "#ffffff";
        if (typeof process !== 'undefined') {
            // Running under node
            // TODO: this probably breaks for SSARs ?
            if (process?.env?.songName) {
                ctx.font = 'bold 48px Arial';
                ctx.fillText(`${process.env.songName}`, 24, 24);
                if (process.env.nextSongName) {
                    ctx.fillStyle = "#00ff00";
                    ctx.font = '48x Arial';
                    ctx.fillText(`Next Up: ${process.env.nextSongName}`, 24, 72);
                }
            }
        } else {
            // Running under a browser
            ctx.font = 'bold 24px monospace';
            if (g_currentlyPlayingIsSsar)
                ctx.fillText(g_currentlyPlayingSdat.ssarSseqSymbols[g_currentlyPlayingId] ? `${g_currentlyPlayingSdat.ssarSseqSymbols[g_currentlyPlayingId].ssarSseqIdNameDict.get(g_currentlyPlayingSubId)} (SSAR: ${g_currentlyPlayingId} ID: ${g_currentlyPlayingSubId})` : `(SSAR: ${g_currentlyPlayingId} ID: ${g_currentlyPlayingSubId})`, 24, 24);
            else
                ctx.fillText(`${g_currentlyPlayingSdat.sseqIdNameDict.get(g_currentlyPlayingId)} (ID: ${g_currentlyPlayingId})` || `(ID: ${g_currentlyPlayingId})`, 24, 24);
        }
    }

    if (currentFsVisController)
        lastTicks = currentFsVisController.sequence.ticksElapsed;
}