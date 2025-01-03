// @ts-check
const fs = require('fs');
const vm = require('vm');
const { createCanvas, loadImage } = require('canvas');
const ffmpeg = require('fluent-ffmpeg');
const stream = require('stream');

const FPS = 30;
const WIDTH = 1920;
const HEIGHT = 1080;

const canvas = createCanvas(WIDTH, HEIGHT);
const ctx = canvas.getContext("2d");

const toLoad = [
    './OptimePlayer/OptimePlayer.js'
];

for (let i = 0; i < toLoad.length; i++) {
    let data = fs.readFileSync(toLoad[i]);
    const script = new vm.Script(data.toString());
    script.runInThisContext();
}

async function renderVideoSeq(sdat, id, outFile) {
    const SAMPLE_RATE = 32768;

    let controller = new Controller(SAMPLE_RATE, sdat, id);
    let fsVisController = new FsVisController(sdat, id, 384 * 3);

    console.log("Rendering SSEQ Id:" + id);

    let sample = 0;
    let fadingOut = false;
    let fadeoutStartSample = 0;
    let loop = 0;

    let timer = 0;
    let playing = true;
    let fadeoutLength = .1; // in seconds 

    let encoder = new WavEncoder(SAMPLE_RATE, 16);

    let frameTimer = 0;
    let frames = 0;

    g_currentlyPlayingSdat = sdat;
    g_currentController = controller;
    currentFsVisController = fsVisController;
    g_currentlyPlayingId = id;

    let videoStream = new stream.PassThrough({ highWaterMark: WIDTH * HEIGHT * 4 * 2 });
    let videoFfmpeg = ffmpeg(videoStream);
    videoFfmpeg.inputFormat("rawvideo")
        .inputOptions(`-s ${WIDTH}x${HEIGHT}`)
        .inputOptions(`-framerate ${FPS}`)
        .inputOptions("-pix_fmt rgba")
        .videoCodec('libx264')
        .outputOptions('-crf 30')
        .outputOptions("-vf format=yuv420p")
        .output(outFile + "temp.mp4")
        .on('start', (cmdline) => console.log(cmdline))
        .run();

    let clipping = 0;

    // keep it under 480 seconds
    while (playing && sample < SAMPLE_RATE * 480) {
        // nintendo DS clock speed
        timer += 33513982;
        while (timer >= 64 * 2728 * SAMPLE_RATE) {
            timer -= 64 * 2728 * SAMPLE_RATE;

            controller.tick();
            fsVisController.tick();
        }

        if (controller.jumps > 0) {
            controller.jumps = 0;
            loop++;

            if (loop === 2) {
                fadeoutLength = 5;
                controller.fadingStart = true;
            }
        }

        if (controller.fadingStart) {
            controller.fadingStart = false;
            fadingOut = true;
            fadeoutStartSample = sample + SAMPLE_RATE * 2;
            console.log("Starting fadeout at sample: " + fadeoutStartSample);
        }

        let fadeoutVolMul = 1;

        if (fadingOut) {
            let fadeoutSample = sample - fadeoutStartSample;
            if (fadeoutSample >= 0) {
                let fadeoutTime = fadeoutSample / SAMPLE_RATE;

                let ratio = fadeoutTime / fadeoutLength;

                fadeoutVolMul = 1 - ratio;

                if (fadeoutVolMul <= 0) {
                    playing = false;
                }
            }
        }

        frameTimer += 1 / SAMPLE_RATE;
        if (frameTimer >= 1 / FPS) {
            frameTimer -= 1 / FPS;

            // @ts-ignore
            drawFsVis(ctx, frameTimer * 1000, fadeoutVolMul);
            let imageData = ctx.getImageData(0, 0, WIDTH, HEIGHT);

            if (!videoStream.write(new Uint8Array(imageData.data.buffer))) {
                await /** @type {Promise<void>} */(new Promise((resolve, reject) => {
                    videoStream.once("drain", () => {
                        resolve();
                    });
                }));
            }

            if (++frames % FPS === 0) {
                console.log(frames / FPS);
            }

        }

        let valL = 0;
        let valR = 0;
        for (let i = 0; i < 16; i++) {
            if (g_trackEnables[i]) {
                let synth = controller.synthesizers[i];
                synth.nextSample();
                valL += synth.valL;
                valR += synth.valR;
            }
        }

        valL *= 0.4 * fadeoutVolMul;
        valR *= 0.4 * fadeoutVolMul;
        if (Math.abs(valL) > 1.0 || Math.abs(valR) > 1.0) {
            clipping++;
        }
        encoder.addSample(valL, valR);

        sample++;
    }

    if (clipping > 0) {
        console.log(clipping + " samples hard clipped");
    }

    fs.writeFileSync(outFile + ".wav", encoder.encode());
    videoStream.end(() => {
        videoFfmpeg.on('end', () => {
            ffmpeg()
                .input(outFile + ".wav")
                .audioFrequency(48000)
                .audioCodec('aac')
                .audioBitrate('264k')
                .input(outFile + "temp.mp4")
                .videoCodec("copy")
                .on('start', (cmdline) => console.log(cmdline))
                .on('end', () => { fs.rmSync(outFile + 'temp.mp4'); })
                .save(outFile + ".mp4");
        });
    });
}

if (process.argv.length < 4) {
    console.log("Arguments: <path to DS ROM> <name of SSEQ to play> [video out file]");
    process.exit(1);
}
const dsRomPath = process.argv[2];
const sseqName = process.argv[3];
let outFile = process.argv[4];
if (outFile === undefined) {
    outFile = sseqName;
}
let sdats = Sdat.loadAllFromDataView(new DataView(fs.readFileSync(dsRomPath).buffer));
// console.log(sdats)
let sseqId = null;
let sdatWithSeq = null;
for (let sdat of sdats) {
    if (sdat.sseqNameIdDict.has(sseqName)) {
        sdatWithSeq = sdat;
        sseqId = sdat.sseqNameIdDict.get(sseqName);
    }
}


if (sseqId) {
    renderVideoSeq(sdatWithSeq, sseqId, outFile);
} else {
    console.log(`SSEQ "${sseqName}" not found in DS ROM`);
}