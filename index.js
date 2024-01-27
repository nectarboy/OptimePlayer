function downloadFileFromUrl(url) {
    return new Promise((resolve, reject) => {
        let client = new XMLHttpRequest();
        client.responseType = "arraybuffer";
        client.open("GET", url);
        client.onreadystatechange = () => {
            if (client.status != 404) {
                if (client.response instanceof ArrayBuffer) {
                    resolve(new Uint8Array(client.response));

                }
            } else {
                reject();

            }
        };
        client.send();
    });
}

/** @returns {Promise<HTMLImageElement>} */
function loadHtmlImageElementFromUrl(url) {
    return new Promise((resolve, reject) => {
        let htmlImageElement = new Image();
        htmlImageElement.src = url;
        htmlImageElement.onload = () => {
            resolve(htmlImageElement);
        };
        htmlImageElement.onerror = () => reject();
    });
}

async function loadNdsRom(data) {
    let songPicker = document.querySelector(".song-picker");
    while (songPicker.firstChild) {
        songPicker.removeChild(songPicker.firstChild);
    }

    console.log(`ROM size: ${data.length} bytes`);

    let sequence = [0x53, 0x44, 0x41, 0x54, 0xFF, 0xFE, 0x00, 0x01]; // "SDAT", then byte order 0xFEFF, then version 0x0100
    let res = searchForSequences(data, sequence);
    if (res.length > 0) {
        console.log(`Found SDATs at:`);
        for (let i = 0; i < res.length; i++) {
            console.log(hex(res[i], 8));
        }
    } else {
        console.log(`Couldn't find SDAT (maybe not an NDS ROM?)`);
    }

    for (let i = 0; i < res.length; i++) {
        let sdat = parseSdatFromRom(data, res[i]);

        if (sdat != null) {
            for (let i = 0; i < sdat.sseqIdNameDict.length; i++) {
                let seqName = sdat.sseqIdNameDict[i];
                if (seqName != undefined) {
                    let button = document.createElement('button');
                    button.innerText = `${seqName} (ID: ${i})`;
                    button.style.textAlign = 'left';
                    document.querySelector(".song-picker").appendChild(button);
                    button.onclick = e => {
                        console.log(seqName);
                        playSeq(sdat, seqName);
                    };
                }
            }

            console.log("Searching for STRMs");
            for (let i = 0; i < sdat.fat.length; i++) {
                if (read32LE(sdat.fat[i], 0) == 0x4D525453) {
                    console.log(`file id:${i} is STRM`);

                    // playStrm(sdat.fat[i]);
                }
            }

            // for (let i = 0; i < sdat.sampleArchives.length; i++) {
            //     let archive = sdat.sampleArchives[i];
            //     for (let j = 0; j < archive.length; j++) {
            //         let sample = archive[j];

            //         console.log(`Playing archive ${i}, sample ${j}, length ${sample.data.length / sample.sampleRate} seconds`)

            //         await playSample(sample);
            //     }
            // }
            // console.log("Done playing samples");
        }
    }

    /** @type {HTMLElement} */
    let filePickerContainer = document.querySelector("#file-picker-container");
    // filePickerContainer.style.display = 'none';

    /** @type {HTMLElement} */
    let visualizerPane = document.querySelector("#visualizer-pane");
    visualizerPane.style.display = 'block';
    // (/** @type {HTMLElement} */ (document.querySelector('#soundgoodizer-container'))).style.display = 'block';

}

window.onload = async () => {
    console.log("Optime Player");

    /** @type {HTMLElement} */
    let dropZone = document.querySelector('#drop-zone');
    /** @type {HTMLInputElement} */
    let filePicker = document.querySelector('#file-picker');

    dropZone.style.visibility = 'hidden';
    window.addEventListener('dragover', e => {
        e.preventDefault();
        // console.log("File dragged over");
        dropZone.style.visibility = 'visible';
    });
    dropZone.addEventListener('dragleave', e => {
        e.preventDefault();
        // console.log("File drag leave");
        dropZone.style.visibility = 'hidden';
    });
    window.addEventListener('drop', e => {
        e.preventDefault();
        if (e.dataTransfer.files[0] instanceof Blob) {
            console.log("File dropped");

            dropZone.style.visibility = 'hidden';

            let reader = new FileReader();
            reader.onload = function () {
                if (this.result instanceof ArrayBuffer) {
                    loadNdsRom(new Uint8Array(this.result));
                }
            };
            reader.readAsArrayBuffer(e.dataTransfer.files[0]);
        }
    });

    filePicker.addEventListener("input", () => {
        if (filePicker.files && filePicker.files.length > 0) {
            let file = filePicker.files[0];
            let reader = new FileReader();
            reader.readAsArrayBuffer(file);
            reader.onload = function () {
                let result = reader.result;
                if (result instanceof ArrayBuffer) {
                    loadNdsRom(new Uint8Array(result));
                } else {
                    alert("Failed to read file! Probably a result of a lack of API support.");
                }
            };
        }
    });

    let progressModal = document.getElementById("progress-modal");
    let progressBar = document.getElementById("progress-bar");
    let progressInfo = document.getElementById("progress-info");
    const FADEOUT_LENGTH = 10; // in seconds 
    const LOOP_COUNT = 2;
    const SAMPLE_RATE = 32768;

    function getSseqLength(sdat, name) {
        let id = sdat.sseqNameIdDict[name];
        let bridge = new ControllerBridge(SAMPLE_RATE, sdat, id);
        let loop = 0;
        let playing = true;

        let ticks = 0;

        // nintendo DS clock speed
        while (true) {
            bridge.tick();
            ticks++;

            if (bridge.jumps > 0) {
                bridge.jumps = 0;
                loop++;

                if (loop == LOOP_COUNT) {
                    break;
                }
            }

            if (bridge.fadingStart) {
                break;
            }
        }

        let time = ticks * (64 * 2728) / 33513982;
        time += FADEOUT_LENGTH;

        return time;
    }

    /**
    * @param {Sdat} sdat
    * @param {string} name
    */
    async function renderAndDownloadSeq(sdat, name) {
        progressModal.style.display = "block";

        currentBridge?.destroy();
        await currentPlayer?.ctx.close();
        currentBridge = null;

        let id = sdat.sseqNameIdDict[name];

        let bridge = new ControllerBridge(SAMPLE_RATE, sdat, id);

        console.log("Rendering SSEQ Id:" + id);
        // console.log("FAT ID:" + info.fileId);

        let encoder = new WavEncoder(SAMPLE_RATE, 16);

        let sample = 0;
        let fadingOut = false;
        let fadeoutStartSample = 0;
        let loop = 0;

        let timer = 0;
        let playing = true;

        let startTimestamp = performance.now();

        instrumentsAdvanced = 0;
        samplesConsidered = 0;

        // keep it under 480 seconds

        const lengthS = getSseqLength(sdat, name);
        console.log(lengthS);
        const CHUNK_SIZE = Math.floor(SAMPLE_RATE);

        let intervalNum;

        function renderChunk() {
            for (let i = 0; i < CHUNK_SIZE; i++) {
                if (!(playing && sample < SAMPLE_RATE * 480)) {
                    done();
                    return;
                }
                // nintendo DS clock speed
                timer += 33513982;
                while (timer >= 64 * 2728 * SAMPLE_RATE) {
                    timer -= 64 * 2728 * SAMPLE_RATE;

                    bridge.tick();
                }

                if (bridge.jumps > 0) {
                    bridge.jumps = 0;
                    loop++;

                    if (loop == 2) {
                        bridge.fadingStart = true;
                    }
                }

                if (bridge.fadingStart) {
                    bridge.fadingStart = false;
                    fadingOut = true;
                    fadeoutStartSample = sample + SAMPLE_RATE * 2;
                    console.log("Starting fadeout at sample: " + fadeoutStartSample);
                }

                let fadeoutVolMul = 1;

                if (fadingOut) {
                    let fadeoutSample = sample - fadeoutStartSample;
                    if (fadeoutSample >= 0) {
                        let fadeoutTime = fadeoutSample / SAMPLE_RATE;

                        let ratio = fadeoutTime / FADEOUT_LENGTH;

                        fadeoutVolMul = 1 - ratio;

                        if (fadeoutVolMul <= 0) {
                            playing = false;
                        }
                    }
                }

                let valL = 0;
                let valR = 0;
                for (let i = 0; i < 16; i++) {
                    if (trackEnables[i]) {
                        let synth = bridge.synthesizers[i];
                        synth.nextSample();
                        valL += synth.valL;
                        valR += synth.valR;
                    }
                }

                encoder.addSample(valL * 0.5 * fadeoutVolMul, valR * 0.5 * fadeoutVolMul);

                sample++;
            }

            let finishedTime = sample / SAMPLE_RATE;
            // @ts-ignore
            progressBar.value = Math.round((finishedTime / lengthS) * 100);
            progressInfo.innerText = `${Math.round(finishedTime)} / ${Math.round(lengthS)} seconds`;
        }

        intervalNum = setInterval(renderChunk, 0);

        function done() {
            clearInterval(intervalNum);

            progressModal.style.display = "none";

            let elapsed = (performance.now() - startTimestamp) / 1000;

            console.log(
                `Rendered ${sample} samples in ${Math.round(elapsed * 10) / 10} seconds (${Math.round(sample / elapsed)} samples/s) (${Math.round(sample / elapsed / SAMPLE_RATE * 10) / 10}x realtime speed)
                        Average instruments advanced per sample: ${Math.round((instrumentsAdvanced / sample) * 10) / 10}
                        Average samples considered per sample: ${Math.round((samplesConsidered / sample) * 10) / 10}
                        Stereo separation: ${g_enableStereoSeparation}
                        Audio anti-aliasing ${g_enableAntiAliasing}
                        Enable filter: ${g_enableFilter}
                        Use cubic resampling (check) / Sinc resampling (uncheck): ${g_useCubicResampler}
                        `
            );

            downloadUint8Array(name + ".wav", encoder.encode());
        }
    }

    // Visualizer
    Promise.all(
        [
            loadHtmlImageElementFromUrl("assets/piano_section_1.png"),
            loadHtmlImageElementFromUrl("assets/piano_section_2.png"),
            loadHtmlImageElementFromUrl("assets/piano_section_3.png")
        ]
    ).then(([section1Img, section2Img, section3Img]) => {
        /** @type {HTMLCanvasElement} */
        let visualizerCanvas = document.querySelector("#visualizer-canvas");
        let ctx = visualizerCanvas.getContext('2d');

        let sectionHeight = 43;
        let whiteKeyWidth = 6;
        let whiteKeyHeight = 31;
        let blackKeyWidth = 3;
        let blackKeyHeight = 17;

        let midsections = 5;

        /**
         * @param {number} ofsX
         * @param {number} ofsY
         * @param {boolean} layer2
         */
        function createBackdropCanvas(ofsX, ofsY, layer2) {
            let canvas = document.createElement("canvas");
            canvas.width = 400;
            canvas.height = 688;
            let ctx = canvas.getContext("2d");

            // 15 left-section keys + 5 * 12 mid-section keys + 13 right-section keys
            // = 88 keys 
            for (let trackNum = 0; trackNum < 16; trackNum++) {
                function drawKeys(black) {
                    // piano has 88 keys
                    for (let j = 0; j < 88; j++) {
                        let midiNote = j + 21; // lowest piano note is 21 on midi

                        // using the key of A as octave base
                        let octave = Math.floor(j / 12);
                        let keyInOctave = j % 12;

                        let keyNum = getKeyNum(keyInOctave);
                        let blackKey = isBlackKey(keyInOctave);

                        if (blackKey == black) {
                            let whiteKeyNum = octave * 7 + keyNum;

                            let fillStyle;
                            if (!blackKey) {
                                if (ctx.fillStyle != fillStyle) {
                                    ctx.fillStyle = "#ffffff";
                                }

                                ctx.fillRect(ofsX + 3 + whiteKeyNum * whiteKeyWidth, ofsY + 3 + trackNum * sectionHeight, whiteKeyWidth, whiteKeyHeight);
                            } else {
                                if (ctx.fillStyle != fillStyle) {
                                    ctx.fillStyle = "#dddddd";
                                }

                                ctx.fillRect(ofsX + 8 + whiteKeyNum * whiteKeyWidth, ofsY + 4 + trackNum * sectionHeight, blackKeyWidth, blackKeyHeight);
                            }
                        }
                    }
                }

                if (!layer2) {
                    drawKeys(false); // draw white keys

                    ctx.drawImage(section1Img, ofsX + 0, ofsY + trackNum * sectionHeight);

                    for (let j = 0; j < midsections; j++) {
                        ctx.drawImage(section2Img, ofsX + section1Img.width + j * section2Img.width, ofsY + trackNum * sectionHeight);
                    }

                    ctx.drawImage(section3Img, ofsX + section1Img.width + midsections * section2Img.width, ofsY + trackNum * sectionHeight);
                } else {

                    drawKeys(true); // then draw black keys on top
                }
            }

            return canvas;
        }

        function drawVisualizerBackdrop(backdropCanvas) {
            ctx.drawImage(backdropCanvas, 0, 0);
        }

        function drawVisualizer(ofsX, ofsY, black) {
            for (let trackNum = 0; trackNum < 16; trackNum++) {
                function drawKeys(black) {
                    // piano has 88 keys
                    for (let j = 0; j < 88; j++) {
                        let midiNote = j + 21; // lowest piano note is 21 on midi

                        // using the key of A as octave base
                        let octave = Math.floor(j / 12);
                        let keyInOctave = j % 12;

                        let keyNum = getKeyNum(keyInOctave);
                        let blackKey = isBlackKey(keyInOctave);

                        if (blackKey == black) {
                            let whiteKeyNum = octave * 7 + keyNum;

                            let fillStyle;
                            let noteOn = currentBridge?.notesOn[trackNum][midiNote];
                            let noteOnKeyboard = currentBridge?.notesOnKeyboard[trackNum][midiNote];
                            if (!blackKey) {
                                if (noteOn) {
                                    ctx.fillStyle = "#000000";
                                    if (noteOnKeyboard) {
                                        ctx.fillStyle = "#FF0000";
                                    }
                                    ctx.fillRect(ofsX + 3 + whiteKeyNum * whiteKeyWidth, ofsY + 3 + trackNum * sectionHeight, whiteKeyWidth, whiteKeyHeight);
                                }
                            } else {
                                if (noteOn) {
                                    ctx.fillStyle = "#000000";
                                    if (noteOnKeyboard) {
                                        ctx.fillStyle = "#FF0000";
                                    }
                                    ctx.fillRect(ofsX + 8 + whiteKeyNum * whiteKeyWidth, ofsY + 4 + trackNum * sectionHeight, blackKeyWidth, blackKeyHeight);
                                }
                            }
                        }
                    }
                }

                if (!black) {
                    drawKeys(false); // draw white keys

                    if (trackNum == currentBridge?.activeKeyboardTrackNum) {
                        let x0 = ofsX + 0;
                        let y0 = ofsY + trackNum * sectionHeight;
                        let x1 = ofsX + section1Img.width + midsections * section2Img.width + section3Img.width;
                        let y1 = y0 + section3Img.height;

                        ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
                    }

                } else {
                    drawKeys(true); // then draw black keys on top
                }
            }


        }

        /**
         * @param {number} ofsX
         * @param {number} ofsY
         */
        function drawToggleButtons(ofsX, ofsY) {
            ctx.strokeStyle = 'black';
            ctx.lineWidth = 1;
            for (let i = 0; i < 16; i++) {
                if (trackEnables[i]) {
                    ctx.fillStyle = '#00cc00';
                } else {
                    ctx.fillStyle = '#cc0000';
                }
                ctx.fillRect(ofsX + 0, ofsY + sectionHeight * i + 3, 16, 31);
                ctx.strokeRect(ofsX + 0, ofsY + sectionHeight * i + 3, 16, 31);
            }
        }

        let backdropCanvas1 = createBackdropCanvas(24, 2, false);
        let backdropCanvas2 = createBackdropCanvas(24, 2, true);
        let lastVisualizerTime = 0;
        const VISUALIZER_FPS = 30;
        function animationFrameHandler(time) {
            if (time >= lastVisualizerTime + 1 / VISUALIZER_FPS) {
                ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);

                if (!currentBridge) {
                    ctx.globalAlpha = 0.25;
                } else {
                    ctx.globalAlpha = 1;
                }
                drawToggleButtons(2, 2);
                drawVisualizerBackdrop(backdropCanvas1);
                drawVisualizer(24, 2, false);
                drawVisualizerBackdrop(backdropCanvas2);
                drawVisualizer(24, 2, true);
                lastVisualizerTime = time;
            }
            requestAnimationFrame(animationFrameHandler);
        }

        requestAnimationFrame(animationFrameHandler);

        class ClickRect {
            constructor() {
                // top left coordinates
                this.x0 = 0;
                this.y0 = 0;

                // bottom right coordinates
                this.x1 = 0;
                this.y1 = 0;

                this.callback = () => { };
            }
        }

        /** @type {ClickRect[]} */
        let clickRects = [];

        function setupToggleButtons(ofsX, ofsY) {
            for (let i = 0; i < 16; i++) {
                let clickRect = new ClickRect();
                clickRect.x0 = ofsX + 0;
                clickRect.y0 = ofsY + sectionHeight * i + 3;
                clickRect.x1 = clickRect.x0 + 16;
                clickRect.y1 = clickRect.y0 + 31;

                clickRect.callback = () => {
                    trackEnables[i] = !trackEnables[i];
                };

                clickRects.push(clickRect);
            }
        }
        setupToggleButtons(2, 0);

        function setupTrackButtons(ofsX, ofsY) {
            for (let trackNum = 0; trackNum < 16; trackNum++) {
                let clickRect = new ClickRect();
                clickRect.x0 = ofsX + 0;
                clickRect.y0 = ofsY + trackNum * sectionHeight;
                clickRect.x1 = ofsX + section1Img.width + midsections * section2Img.width + section3Img.width;
                clickRect.y1 = ofsY + trackNum * sectionHeight + section3Img.height;

                clickRect.callback = () => {
                    if (currentBridge) {
                        if (currentBridge.activeKeyboardTrackNum == trackNum) {
                            currentBridge.activeKeyboardTrackNum = null;
                        } else {
                            currentBridge.activeKeyboardTrackNum = trackNum;
                        }
                    }
                };

                clickRects.push(clickRect);
            }
        }
        setupTrackButtons(24, 0);

        visualizerCanvas.addEventListener('click', event => {
            event.preventDefault();
            let x = event.pageX - visualizerCanvas.offsetLeft - visualizerCanvas.clientLeft;
            let y = event.pageY - visualizerCanvas.offsetTop - visualizerCanvas.clientTop;
            for (let i of clickRects) {
                if (x >= i.x0 && y >= i.y0 && x <= i.x1 && y <= i.y1) {
                    i.callback();
                }
            }
        });

        visualizerCanvas.addEventListener('mousemove', event => {
            let x = event.pageX - visualizerCanvas.offsetLeft - visualizerCanvas.clientLeft;
            let y = event.pageY - visualizerCanvas.offsetTop - visualizerCanvas.clientTop;

            let hovered = false;
            for (let i of clickRects) {
                if (x >= i.x0 && y >= i.y0 && x <= i.x1 && y <= i.y1) {
                    hovered = true;
                    break;
                }
            }

            if (hovered) {
                document.body.style.cursor = "pointer";
            } else {
                document.body.style.cursor = "default";
            }
        });

        function keyboardPress(key, down) {
            if (down) {
                switch (key) {
                    case "ArrowLeft":
                    case "ArrowRight":
                        let currentSseqListIndex = currentlyPlayingSdat.sseqList.indexOf(currentlyPlayingId);
                        let nextSseqListIndex;
                        if (key === "ArrowLeft") {
                            nextSseqListIndex = currentlyPlayingSdat.sseqList[currentSseqListIndex - 1];
                        } else if (key === "ArrowRight") {
                            nextSseqListIndex = currentlyPlayingSdat.sseqList[currentSseqListIndex + 1];
                        }
                        if (nextSseqListIndex != undefined) {
                            playSeqById(currentlyPlayingSdat, nextSseqListIndex);
                        }
                        break;
                    default:
                        break;
                }
            }
            if (currentBridge?.activeKeyboardTrackNum != null) {
                let isNote = false;
                let note = 0;

                switch (key) {
                    case "z": note = 60; isNote = true; break;
                    case "s": note = 61; isNote = true; break;
                    case "x": note = 62; isNote = true; break;
                    case "d": note = 63; isNote = true; break;
                    case "c": note = 64; isNote = true; break;
                    case "v": note = 65; isNote = true; break;
                    case "g": note = 66; isNote = true; break;
                    case "b": note = 67; isNote = true; break;
                    case "h": note = 68; isNote = true; break;
                    case "n": note = 69; isNote = true; break;
                    case "j": note = 70; isNote = true; break;
                    case "m": note = 71; isNote = true; break;
                    case ",": note = 72; isNote = true; break;
                    case "l": note = 73; isNote = true; break;
                    case ".": note = 74; isNote = true; break;
                    case ";": note = 75; isNote = true; break;
                    case "/": note = 76; isNote = true; break;

                    case "q": note = 72; isNote = true; break;
                    case "2": note = 73; isNote = true; break;
                    case "w": note = 74; isNote = true; break;
                    case "3": note = 75; isNote = true; break;
                    case "e": note = 76; isNote = true; break;
                    case "r": note = 77; isNote = true; break;
                    case "5": note = 78; isNote = true; break;
                    case "t": note = 79; isNote = true; break;
                    case "6": note = 80; isNote = true; break;
                    case "y": note = 81; isNote = true; break;
                    case "7": note = 82; isNote = true; break;
                    case "u": note = 83; isNote = true; break;
                    case "i": note = 84; isNote = true; break;
                    case "9": note = 85; isNote = true; break;
                    case "o": note = 86; isNote = true; break;
                    case "0": note = 87; isNote = true; break;
                    case "p": note = 88; isNote = true; break;
                    case "[": note = 89; isNote = true; break;
                    case "=": note = 90; isNote = true; break;
                    case "]": note = 91; isNote = true; break;
                    default:
                        break;
                }

                if (isNote) {
                    event.preventDefault();

                    if (note < 0) note = 0;
                    if (note > 127) note = 127;

                    console.log(note);
                    if (down) {
                        currentBridge.controller.tracks[currentBridge.activeKeyboardTrackNum].sendMessage(true, MessageType.PlayNote, note, 127, 2000);
                        currentBridge.notesOnKeyboard[currentBridge.activeKeyboardTrackNum][note] = 1;
                    } else {
                        for (let entry of currentBridge.activeNoteData) {
                            if (entry.trackNum == currentBridge.activeKeyboardTrackNum && entry.midiNote == note) {
                                entry.adsrState = AdsrState.Release;
                                currentBridge.notesOnKeyboard[currentBridge.activeKeyboardTrackNum][note] = 0;
                            }
                        }
                    }
                }
            }
        }

        let downKeys = {};

        document.onkeydown = event => {
            if (!downKeys[event.key]) {
                keyboardPress(event.key, true);
            }
            downKeys[event.key] = true;
        };

        document.onkeyup = event => {
            keyboardPress(event.key, false);
            downKeys[event.key] = false;
        };

        /** @type {HTMLButtonElement} */
        let pauseButton = document.querySelector("#pause-button");
        let paused = false;
        pauseButton.onclick = () => {
            paused = !paused;
            if (currentBridge) currentBridge.controller.paused = paused;
            if (currentFsVisBridge) currentFsVisBridge.controller.paused = paused;
            if (paused) {
                pauseButton.innerText = "Unpause Sequence Player";
            } else {
                pauseButton.innerText = "Pause Sequence Player";
            }
        };

        /** @type {HTMLButtonElement} */
        let restartSequenceButton = document.querySelector("#restart-sequence-button");
        restartSequenceButton.onclick = () => {
            pauseButton.innerText = "Pause Sequence Player";
            playSeq(currentlyPlayingSdat, currentlyPlayingName);
        };
    });

    /** @type {HTMLCanvasElement} */
    let fsVisCanvas = document.querySelector("#fullscreen-vis-canvas");
    let fsVisCtx = fsVisCanvas.getContext("2d");
    (/** @type {HTMLButtonElement} */ (document.querySelector("#fullscreen-vis-button"))).onclick = e => {
        showFsVis();
        fsVisCanvas.requestFullscreen();
    };

    fsVisCanvas.onfullscreenchange = () => {
        if (!document.fullscreenElement) {
            hideFsVis();
        }
    };

    let fsVisVisible = false;

    function showFsVis() {
        fsVisVisible = true;
        fsVisCanvas.style.display = "block";
    }

    function hideFsVis() {
        fsVisVisible = false;
        fsVisCanvas.style.display = "none";
    }

    function fsVisFrame(time) {
        fsVisCanvas.width = window.innerWidth;
        fsVisCanvas.height = window.innerHeight;
        if (fsVisVisible) {
            drawFsVis(fsVisCtx, time, 1);
        }
        requestAnimationFrame(fsVisFrame);
    }
    requestAnimationFrame(fsVisFrame);

    (/** @type {HTMLButtonElement} */ (document.querySelector("#download-playing-button"))).onclick = e => {
        renderAndDownloadSeq(currentlyPlayingSdat, currentlyPlayingName);
    };

    registerCheckbox("#stereo-separation", true, checked => { g_enableStereoSeparation = checked; });
    registerCheckbox("#force-stereo-separation", true, checked => { g_enableForceStereoSeparation = checked; });
    registerCheckbox("#antialiasing", true, checked => { g_enableAntiAliasing = checked; });
    registerDropdown("#tuning-system", changed => {
        if (changed === "equal") {
            g_pureTuning = false;
        } else {
            g_pureTuning = true;
            g_pureTuningRootNote = parseInt(changed.split('-')[1]);
        }
    });
    // registerCheckbox("#soundgoodizer", true, c => { enableSoundgoodizer = c; });
    registerCheckbox("#enable-filter", true, c => { g_enableFilter = c; });
    registerCheckbox("#use-cubic-resampler", false, c => { g_useCubicResampler = c; });
};

/** @param {string} name */
function loadDemo(name) {
    downloadFileFromUrl("demos/" + name + ".sdat").then(data => {
        loadNdsRom(data);
    });
}

function registerCheckbox(selector, checked, callback) {
    let element = document.querySelector(selector);
    element.checked = checked;
    callback(checked);
    element.onchange = () => callback(element.checked);
}

function registerDropdown(selector, callback) {
    let element = document.querySelector(selector);
    element.onchange = () => callback(element.value);
}
