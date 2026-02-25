import { FaceLandmarker, ObjectDetector, FilesetResolver } from "@mediapipe/tasks-vision";

const state = {
    smileIntensity: 0,
    smileCount: parseInt(localStorage.getItem('smileCount') || '0'),
    waterTotal: parseFloat(localStorage.getItem('waterTotal') || '0'),
    waterGoal: 2.5,
    lastSmileTime: Date.now(),
    lastWaterTime: Date.now(),
    lastBlinkTime: Date.now(),
    blinksThisMinute: 0,
    isSlouching: false,
    slouchStartTime: 0,
    isMonitoring: false,
    blinkCalibrationDone: false,
    calibrationSamples: [],
    customBlinkThreshold: 0.5, // Default fallback
    eyesCurrentlyClosed: false, // State edge detection
    babyLastPos: null,
    babyAnchor: null,
    babySafeMarginX: 15, // percent 
    babySafeMarginY: 15,
    babyOffsetX: 0, // percent
    babyOffsetY: 0, // percent
    babyRotation: 0, // degrees
    babyAnchor: null,
    lastCenterX: 0,
    lastCenterY: 0,
    babyCornerAlertTime: 0,
    babyWakeAlertTime: 0,
    babyMissingAlertTime: 0,
    babyLastSeenTime: Date.now(),
    babyAwakeUntil: 0,
    babyIsRolling: false
};

// Tracking Configuration
const config = {
    smile: false,
    blink: false,
    posture: false,
    water: false,
    baby: false,
    debug: false
};
let localSoundEnabled = false;
let localLightEnabled = false;
let isRemoteMonitor = false;
let socket = null;

// Start blink rate checker interval
setInterval(() => {
    if (state.isMonitoring && config.blink) {
        // Average person blinks 15-20 times per minute.
        // If they blink less than 5 times a minute, they are likely staring/straining
        if (state.blinksThisMinute >= 0 && state.blinksThisMinute < 5) {
            addNotification("Low blink rate detected. Please blink and rest your eyes!", "urgent");
        }
        state.blinksThisMinute = 0; // reset counter every minute
    }
}, 60000);

const videoWrapper = document.getElementById('video-wrapper');

const offCanvas = document.createElement("canvas");
const offCtx = offCanvas.getContext("2d");
const appDiv = document.getElementById('app');
const roleSelection = document.getElementById('role-selection');
const btnHost = document.getElementById('btn-host');
const btnRemote = document.getElementById('btn-remote');

const video = document.getElementById('video-preview');
const canvasElement = document.getElementById('output-canvas');
const canvasCtx = canvasElement.getContext('2d');
const smileValue = document.getElementById('smile-value');
const smileIntensityText = document.getElementById('smile-intensity');
const smileCountText = document.getElementById('smile-count');
const blinkCountText = document.getElementById('blink-count');
const posturePitchText = document.getElementById('posture-pitch');
const babyStatusText = document.getElementById('baby-status');
const resetAnchorBtn = document.getElementById('draw-bed-btn'); // reusing the button
const startBtn = document.getElementById('start-camera');
const stopBtn = document.getElementById('stop-camera');
const addWaterBtn = document.getElementById('add-water');

const radiusSlider = document.getElementById('radius-slider');
const offsetXSlider = document.getElementById('offset-x-slider');
const offsetYSlider = document.getElementById('offset-y-slider');
const offsetRSlider = document.getElementById('offset-r-slider');

function emitOffsets() {
    if (isRemoteMonitor && socket) {
        socket.emit('remote_command', { action: 'set_offsets', x: state.babyOffsetX, y: state.babyOffsetY, r: state.babyRotation });
    }
}

if (radiusSlider) {
    // Repurposing slider from "Radius" to "Edge Sensitivity Margin (%)"
    // Value 5 to 40 (percent of screen to treat as alarm zone)
    radiusSlider.min = 5;
    radiusSlider.max = 40;
    radiusSlider.value = 15;
    radiusSlider.addEventListener('input', (e) => {
        state.babySafeMarginX = parseInt(e.target.value, 10);
        state.babySafeMarginY = parseInt(e.target.value, 10);
        if (isRemoteMonitor && socket) socket.emit('remote_command', { action: 'set_radius', value: state.babySafeMarginX });
    });
}
if (offsetXSlider) {
    offsetXSlider.addEventListener('input', (e) => {
        state.babyOffsetX = parseInt(e.target.value, 10);
        emitOffsets();
    });
}
if (offsetYSlider) {
    offsetYSlider.addEventListener('input', (e) => {
        state.babyOffsetY = parseInt(e.target.value, 10);
        emitOffsets();
    });
}
if (offsetRSlider) {
    offsetRSlider.addEventListener('input', (e) => {
        state.babyRotation = parseInt(e.target.value, 10);
        emitOffsets();
    });
}
const resetWaterBtn = document.getElementById('reset-water');
const currentWaterText = document.getElementById('current-water');
const waterWheel = document.getElementById('water-progress-wheel');
const notificationList = document.getElementById('notification-list');

// Toggles
const toggleSmile = document.getElementById('toggle-smile');
const toggleBlink = document.getElementById('toggle-blink');
const togglePosture = document.getElementById('toggle-posture');
const toggleWater = document.getElementById('toggle-water');
const toggleBaby = document.getElementById('toggle-baby');
const toggleDebug = document.getElementById('toggle-debug');
const toggleSound = document.getElementById('toggle-sound');
const toggleLight = document.getElementById('toggle-light');

function emitConfig() {
    if (isRemoteMonitor && socket) socket.emit('remote_command', { action: 'set_config', config });
}

toggleSmile.addEventListener('change', e => { config.smile = e.target.checked; emitConfig(); });
toggleBlink.addEventListener('change', e => { config.blink = e.target.checked; emitConfig(); });
togglePosture.addEventListener('change', e => { config.posture = e.target.checked; emitConfig(); });
toggleWater.addEventListener('change', e => { config.water = e.target.checked; emitConfig(); });
toggleBaby.addEventListener('change', e => { config.baby = e.target.checked; emitConfig(); });
toggleDebug.addEventListener('change', e => { config.debug = e.target.checked; emitConfig(); });
if (toggleSound) toggleSound.addEventListener('change', e => { localSoundEnabled = e.target.checked; });
if (toggleLight) toggleLight.addEventListener('change', e => { localLightEnabled = e.target.checked; });

let faceLandmarker;
let objectDetector;
let lastVideoTime = -1;

// Drawing Event Listeners
btnHost.addEventListener('click', () => {
    roleSelection.style.display = 'none';
    appDiv.style.display = 'flex';
    if (typeof io !== 'undefined') {
        socket = io({
            reconnection: true,
            reconnectionAttempts: Infinity,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000,
            timeout: 20000
        });

        const doAuth = () => { socket.emit('authenticate', 'host_local', () => { }); };
        doAuth();

        socket.on('connect', () => { doAuth(); }); // Re-auth on disconnect/reconnect

        // Listen for Remote Controls on the Host Setup
        socket.on('host_command', (cmd) => {
            if (cmd.action === 'start') {
                if (!state.isMonitoring) startBtn.click();
            } else if (cmd.action === 'stop') {
                if (state.isMonitoring) stopBtn.click();
            } else if (cmd.action === 'reset_anchor') {
                state.babyAnchor = null;
                addNotification("Baby Tracking Resynced!", "success");
            } else if (cmd.action === 'set_radius') {
                state.babySafeMarginX = cmd.value;
                state.babySafeMarginY = cmd.value;
                if (radiusSlider) radiusSlider.value = cmd.value;
            } else if (cmd.action === 'set_config') {
                Object.assign(config, cmd.config);
                toggleSmile.checked = config.smile;
                toggleBlink.checked = config.blink;
                togglePosture.checked = config.posture;
                toggleWater.checked = config.water;
                toggleBaby.checked = config.baby;
                toggleDebug.checked = config.debug;
            } else if (cmd.action === 'set_offsets') {
                state.babyOffsetX = cmd.x;
                state.babyOffsetY = cmd.y;
                if (cmd.r !== undefined) state.babyRotation = cmd.r;
                const ox = document.getElementById('offset-x-slider');
                const oy = document.getElementById('offset-y-slider');
                const or = document.getElementById('offset-r-slider');
                if (ox) ox.value = cmd.x;
                if (oy) oy.value = cmd.y;
                if (or && cmd.r !== undefined) or.value = cmd.r;
            }
        });
    }
});

btnRemote.addEventListener('click', () => {
    const codeInput = document.getElementById('remote-passcode');
    const code = codeInput ? codeInput.value.trim() : "";
    if (!code) {
        alert("Please enter a PIN code first.");
        return;
    }
    if (typeof io !== 'undefined') {
        socket = io({
            reconnection: true,
            reconnectionAttempts: Infinity,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000,
            timeout: 20000
        });

        const attemptAuth = () => {
            socket.emit('authenticate', code, (res) => {
                if (res.success) {
                    if (!isRemoteMonitor) {
                        isRemoteMonitor = true;
                        roleSelection.style.display = 'none';
                        appDiv.style.display = 'flex';
                        video.style.opacity = 0;
                        addNotification("Connected to Secure Remote Feed.", "success");
                    }
                } else {
                    addNotification("Wrong passcode!", "urgent");
                    socket.disconnect();
                }
            });
        };

        attemptAuth();
        socket.on('connect', attemptAuth); // auto re-auth on drop

        socket.on('disconnect', () => {
            addNotification("Connection to Host lost. Reconnecting...", "neutral");
        });

        // Stream Ingest Loop
        socket.on("remote_update", (data) => {
            if (data.notification) {
                addNotification(data.notification.message, data.notification.type, true);
                return;
            }

            const img = new Image();
            img.onload = () => {
                canvasElement.width = data.stats.w || 1280;
                canvasElement.height = data.stats.h || 720;
                canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
                // Draw the incoming frame + boxes to our viewer canvas
                canvasCtx.drawImage(img, 0, 0, canvasElement.width, canvasElement.height);
            };
            img.src = data.frame;

            smileIntensityText.textContent = data.stats.smileIntensity;
            smileCountText.textContent = data.stats.smileCount;
            blinkCountText.textContent = data.stats.blinks;
            posturePitchText.textContent = data.stats.posture;
            babyStatusText.textContent = data.stats.baby;
            currentWaterText.textContent = data.stats.water;
            smileValue.style.width = data.stats.smileWidth;
            waterWheel.style.background = data.stats.waterWheel;
        });
    }
});

resetAnchorBtn.addEventListener('click', () => {
    if (isRemoteMonitor && socket) {
        socket.emit('remote_command', { action: 'reset_anchor' });
        return;
    }
    state.babyAnchor = null;
    addNotification("Baby Tracking Resynced!", "success");
});

// Initialize MediaPipe
async function initMediaPipe() {
    startBtn.textContent = "Loading Models...";
    const vision = await FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm"
    );

    faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
        baseOptions: {
            modelAssetPath: `https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task`,
            delegate: "GPU"
        },
        outputFaceBlendshapes: true,
        outputFacialTransformationMatrixes: true,
        runningMode: "VIDEO",
        numFaces: 1
    });

    objectDetector = await ObjectDetector.createFromOptions(vision, {
        baseOptions: {
            modelAssetPath: `https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite`,
            delegate: "GPU"
        },
        runningMode: "VIDEO",
        scoreThreshold: 0.25
    });

    console.log("MediaPipe Models initialized");
}

// Camera Setup
async function setupCamera() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 1280 }, height: { ideal: 720 } },
            audio: false
        });
        video.srcObject = stream;

        // Wait for the video to be ready before starting inference
        video.addEventListener("loadeddata", () => {
            video.play();
            state.isMonitoring = true;

            startBtn.style.display = "none";
            stopBtn.style.display = "block";
            resetAnchorBtn.style.display = "block";
            resetAnchorBtn.textContent = "Resync Baby Tracker";
            const rc = document.getElementById('radius-container');
            if (rc) {
                rc.style.display = 'flex';
                rc.querySelector('label').textContent = "Edge Sensitivity Margin (%)";
            }

            console.log("Video started, beginning predictions.");
            window.requestAnimationFrame(predictWebcam);
        }, { once: true }); // make sure event listener runs only once per start
    } catch (err) {
        console.error("Camera access denied or error:", err);
        startBtn.textContent = "Camera Error";
        addNotification("Camera access denied or unavailable. Please check permissions.", "urgent");
        startBtn.disabled = false;
    }
}

function stopCamera() {
    state.isMonitoring = false;

    // Stop webcam tracks
    if (video.srcObject) {
        video.srcObject.getTracks().forEach(track => track.stop());
        video.srcObject = null;
    }

    // Clear canvas
    canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);

    // Reset button states
    stopBtn.style.display = "none";
    resetAnchorBtn.style.display = "none";
    const rc = document.getElementById('radius-container');
    if (rc) rc.style.display = 'none';
    startBtn.style.display = "block";
    startBtn.disabled = false;
    startBtn.textContent = "Start Monitoring";

    // Reset tracker states
    state.blinkCalibrationDone = false;
    state.calibrationSamples = [];
    state.eyesCurrentlyClosed = false;
    state.babyCenterEMA = null;
    state.babySizeEMA = null;
    state.babyMovementScore = 0;
    state.babyAnchor = null;

    // Reset text readouts
    smileIntensityText.textContent = "0%";
    smileValue.style.width = "0%";
    posturePitchText.textContent = "0°";
    blinkCountText.textContent = state.blinksThisMinute;
    babyStatusText.textContent = "Monitoring...";

    addNotification("Monitoring paused.", "neutral");
}

// Prediction Loop
async function predictWebcam() {
    // Ensure video dimensions are ready
    if (video.videoWidth === 0 || video.videoHeight === 0) {
        window.requestAnimationFrame(predictWebcam);
        return;
    }

    if (video.currentTime !== lastVideoTime) {
        lastVideoTime = video.currentTime;
        try {
            if (canvasElement.width !== video.videoWidth) {
                canvasElement.width = video.videoWidth;
                canvasElement.height = video.videoHeight;
            }

            // Clear previous AI renderings for a perfectly transparent overlay covering the HD video
            canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);

            const startTimeMs = performance.now();
            const results = faceLandmarker.detectForVideo(video, startTimeMs);

            let jawOpen = 0;
            if (results.faceBlendshapes && results.faceBlendshapes.length > 0) {
                const blendshapes = results.faceBlendshapes[0].categories;

                // mouthSmileLeft (category 44) and mouthSmileRight (category 45)
                const smileLeft = blendshapes.find(b => b.categoryName === "mouthSmileLeft")?.score || 0;
                const smileRight = blendshapes.find(b => b.categoryName === "mouthSmileRight")?.score || 0;
                jawOpen = blendshapes.find(b => b.categoryName === "jawOpen")?.score || 0;

                // eyeBlinkLeft (category 9) and eyeBlinkRight (category 10)
                const blinkLeft = blendshapes.find(b => b.categoryName === "eyeBlinkLeft")?.score || 0;
                const blinkRight = blendshapes.find(b => b.categoryName === "eyeBlinkRight")?.score || 0;
                const tempBlinkAverage = (blinkLeft + blinkRight) / 2;

                // Calibrate Blink Threshold
                if (config.blink) {
                    // Takes the first 30 frames of monitoring as the baseline "eyes open" state
                    if (!state.blinkCalibrationDone) {
                        state.calibrationSamples.push(tempBlinkAverage);
                        if (state.calibrationSamples.length > 30) {
                            const baselineSum = state.calibrationSamples.reduce((a, b) => a + b, 0);
                            const baselineAvg = baselineSum / state.calibrationSamples.length;

                            // Use a very tight threshold offset (+0.05) to catch quick, light blinks
                            state.customBlinkThreshold = baselineAvg + 0.05;
                            // Ensure it doesn't go over 0.85 just in case
                            if (state.customBlinkThreshold > 0.85) state.customBlinkThreshold = 0.85;

                            state.blinkCalibrationDone = true;
                            console.log("Custom Blink Threshold Calibrated at: ", state.customBlinkThreshold);
                            addNotification("Personalized Eye Tracking limits calibrated!", "neutral");
                        }
                    }

                    // If eyes cross the *personally calibrated* threshold going DOWN (closing)
                    if (state.blinkCalibrationDone) {
                        const isClosed = tempBlinkAverage > state.customBlinkThreshold;

                        if (isClosed && !state.eyesCurrentlyClosed) {
                            // Edge triggered: They just closed their eyes (a blink initiated)
                            state.eyesCurrentlyClosed = true;

                            const now = Date.now();
                            // Extremely short debounce (25ms) to just prevent same-frame double-counts
                            if (now - state.lastBlinkTime > 25) {
                                state.blinksThisMinute++;
                                state.lastBlinkTime = now;
                                // update UI immediately
                                blinkCountText.textContent = state.blinksThisMinute;
                            }
                        }
                        else if (!isClosed && state.eyesCurrentlyClosed) {
                            // Edge triggered: They OPENED their eyes, ready for next blink
                            state.eyesCurrentlyClosed = false;
                        }
                    }

                    // Also update UI for when the minute resets it to 0
                    if (blinkCountText.textContent !== state.blinksThisMinute.toString()) {
                        blinkCountText.textContent = state.blinksThisMinute;
                    }
                } else {
                    blinkCountText.textContent = "Off";
                }

                // Posture / Slouch Detection (using 3D transformation matrix of the head)
                if (config.posture) {
                    if (results.facialTransformationMatrixes && results.facialTransformationMatrixes.length > 0) {
                        const matrix = results.facialTransformationMatrixes[0].data;
                        // Extract pitch from the rotation matrix elements
                        const pitch = Math.atan2(matrix[6], matrix[5]);
                        // Convert to approximate degrees (0 is straight ahead, negative is looking down)
                        const pitchDeg = pitch * (180 / Math.PI);

                        // Output to the dashboard!
                        posturePitchText.textContent = `${Math.round(pitchDeg)}°`;

                        if (pitchDeg < -15) {
                            if (!state.isSlouching) {
                                state.isSlouching = true;
                                state.slouchStartTime = Date.now();
                            } else {
                                // If slouching for more than 10 seconds straight
                                if (Date.now() - state.slouchStartTime > 10000) {
                                    addNotification("Slouch detected! Sit up straight and protect your neck.", "urgent");
                                    state.slouchStartTime = Date.now(); // Reset to avoid spam
                                }
                            }
                        } else {
                            state.isSlouching = false;
                        }
                    }
                } else {
                    posturePitchText.textContent = "Off";
                }

                if (config.smile) {
                    const intensity = (smileLeft + smileRight) / 2;
                    updateSmileStats(intensity);
                } else {
                    smileIntensityText.textContent = "Off";
                }
            }

            // Object Detection for Water Tracking and Baby Monitor
            if (objectDetector && (config.water || config.baby)) {
                const objResults = objectDetector.detectForVideo(video, startTimeMs);
                let sawWaterContainer = false;
                let sawBaby = false;

                if (objResults.detections) {
                    for (const detection of objResults.detections) {
                        const category = detection.categories[0].categoryName;
                        const score = detection.categories[0].score;
                        const box = detection.boundingBox;

                        // Water Tracking Logic
                        if (config.water) {
                            const isContainer = (category === "cup" || category === "bottle" || category === "wine glass" || category === "vase");
                            if (isContainer) {
                                sawWaterContainer = true;
                                if (config.debug) {
                                    // Draw bounding box
                                    canvasCtx.beginPath();
                                    canvasCtx.lineWidth = 3;
                                    canvasCtx.strokeStyle = "#00ffff";
                                    canvasCtx.rect(box.originX, box.originY, box.width, box.height);
                                    canvasCtx.stroke();

                                    // Draw label
                                    canvasCtx.fillStyle = "#00ffff";
                                    canvasCtx.font = "16px var(--font-main, Arial)";
                                    canvasCtx.fillText(`${category} - ${Math.round(score * 100)}%`, box.originX, box.originY > 20 ? box.originY - 5 : box.originY + 20);
                                }
                            }
                        }

                        // Baby Monitor Logic (detect "person" or "teddy bear" as fallback for dolls/baby)
                        if (config.baby && (category === "person" || category === "teddy bear")) {
                            sawBaby = true;
                            state.babyLastSeenTime = Date.now();

                            if (config.debug) {
                                // Draw bounding box
                                canvasCtx.beginPath();
                                canvasCtx.lineWidth = 3;
                                canvasCtx.strokeStyle = "#ffeb3b";
                                canvasCtx.rect(box.originX, box.originY, box.width, box.height);
                                canvasCtx.stroke();
                                canvasCtx.fillStyle = "#ffeb3b";
                                canvasCtx.font = "16px var(--font-main, Arial)";
                                canvasCtx.fillText(`Baby - ${Math.round(score * 100)}%`, box.originX, box.originY > 20 ? box.originY - 5 : box.originY + 20);
                            }

                            const centerX = box.originX + box.width / 2;
                            const centerY = box.originY + box.height / 2;
                            const size = box.width * box.height;

                            // Edge detection (Rectangular Margin relative to video frame, with user offsets)
                            const marginXPx = video.videoWidth * (state.babySafeMarginX / 100);
                            const marginYPx = video.videoHeight * (state.babySafeMarginY / 100);
                            const offsetXPx = video.videoWidth * (state.babyOffsetX / 100);
                            const offsetYPx = video.videoHeight * (state.babyOffsetY / 100);

                            const rectWidth = video.videoWidth - (marginXPx * 2);
                            const rectHeight = video.videoHeight - (marginYPx * 2);
                            const rectCenterX = marginXPx + offsetXPx + rectWidth / 2;
                            const rectCenterY = marginYPx + offsetYPx + rectHeight / 2;

                            // Rotate baby center backwards around the rect center to simulate rotated box collision
                            const angle = -(state.babyRotation || 0) * (Math.PI / 180);
                            const rotatedCenterX = Math.cos(angle) * (centerX - rectCenterX) - Math.sin(angle) * (centerY - rectCenterY) + rectCenterX;
                            const rotatedCenterY = Math.sin(angle) * (centerX - rectCenterX) + Math.cos(angle) * (centerY - rectCenterY) + rectCenterY;

                            const boxLeft = marginXPx + offsetXPx;
                            const boxTop = marginYPx + offsetYPx;
                            const boxRight = boxLeft + rectWidth;
                            const boxBottom = boxTop + rectHeight;

                            const babyHalfW = box.width / 2;
                            const babyHalfH = box.height / 2;

                            // Treat the baby's OUTER edges crossing the boundaries as an edge alert (not just their center of mass)
                            const nearEdge = (
                                (rotatedCenterX - babyHalfW) < boxLeft ||
                                (rotatedCenterY - babyHalfH) < boxTop ||
                                (rotatedCenterX + babyHalfW) > boxRight ||
                                (rotatedCenterY + babyHalfH) > boxBottom
                            );

                            if (nearEdge) {
                                babyStatusText.textContent = "Near Edge!";
                                if (Date.now() - state.babyCornerAlertTime > 15000) {
                                    addNotification("Alert! Baby is near the edge of the bed/camera.", "urgent");
                                    state.babyCornerAlertTime = Date.now();
                                }
                            }

                            // Movement/Wake detection (Anchor-based Object Flow mechanics)
                            if (!state.babyAnchor) {
                                state.babyAnchor = { x: centerX, y: centerY, w: box.width, h: box.height };
                                state.lastCenterX = centerX;
                                state.lastCenterY = centerY;
                                state.babyMovementScore = 0;
                            } else {
                                const distToAnchor = Math.hypot(centerX - state.babyAnchor.x, centerY - state.babyAnchor.y);
                                const heightRatio = box.height / state.babyAnchor.h;
                                const instDist = Math.hypot(centerX - (state.lastCenterX || centerX), centerY - (state.lastCenterY || centerY));

                                // Wake up heuristics! 
                                // 1. Sitting/standing up drastically morphs the object height compared to laying down
                                const sittingUp = heightRatio > 1.3;
                                // 2. Crawling/rolling completely out of their previous sleep position hotspot
                                const crawledAway = distToAnchor > (video.videoWidth * 0.15);
                                // 3. Thrashing/Active frame-to-frame jitter
                                const trueMovement = instDist > 5;

                                if (sittingUp || crawledAway || trueMovement) {
                                    state.babyMovementScore += 5;
                                    if (sittingUp) state.babyIsRolling = true;
                                } else {
                                    state.babyMovementScore = Math.max(0, state.babyMovementScore - 1);
                                }

                                state.lastCenterX = centerX;
                                state.lastCenterY = centerY;

                                // If the momentum builds up immediately trigger awake
                                if (state.babyMovementScore > 10) {
                                    state.babyAwakeUntil = Date.now() + 30000; // Stay strictly Awake for 30 seconds
                                    state.babyMovementScore = Math.min(state.babyMovementScore, 20); // Cap
                                }

                                if (Date.now() < state.babyAwakeUntil) {
                                    const moveText = (state.babyIsRolling && heightRatio > 1.25) ? "Sat/Stood Up" : "Moving / Awake";
                                    babyStatusText.textContent = nearEdge ? `Near Edge & ${moveText}!` : `${moveText}!`;

                                    if (Date.now() - state.babyWakeAlertTime > 25000) {
                                        addNotification(`Alert! Baby Woke Up (${moveText}).`, "urgent");
                                        state.babyWakeAlertTime = Date.now();
                                    }
                                } else {
                                    state.babyIsRolling = false;
                                    babyStatusText.textContent = nearEdge ? "Near Edge!" : "Sleeping / Still";
                                }

                                // If actively "Sleeping" (no movements for a whole cycle) we slowly pull the anchor to wrap to them 
                                // so it adjusts safely to them falling back asleep in a new posture.
                                if (Date.now() > state.babyAwakeUntil && state.babyMovementScore === 0) {
                                    state.babyAnchor.x += (centerX - state.babyAnchor.x) * 0.05;
                                    state.babyAnchor.y += (centerY - state.babyAnchor.y) * 0.05;
                                    state.babyAnchor.w += (box.width - state.babyAnchor.w) * 0.05;
                                    state.babyAnchor.h += (box.height - state.babyAnchor.h) * 0.05;
                                }
                            }
                        }
                    }
                }

                if (config.baby && !sawBaby) {
                    // Grace period: Wait 4 seconds before deciding the baby is totally gone
                    if (Date.now() - state.babyLastSeenTime > 4000) {
                        babyStatusText.textContent = "Not found / out of frame";
                        state.babyMovementScore = Math.max(0, state.babyMovementScore - 1);
                        if (Date.now() - state.babyMissingAlertTime > 20000) { // Notify only every 20 sec so it doesn't spam
                            addNotification("Alert! Baby not detected in tracking feed.", "urgent");
                            state.babyMissingAlertTime = Date.now();
                        }
                    } else if (Date.now() < state.babyAwakeUntil || state.babyMovementScore > 5) {
                        // Inherit the awake string temporarily so it doesn't flip flop
                        babyStatusText.textContent = "Moving / Awake!";
                    } else {
                        babyStatusText.textContent = "Sleeping / Still";
                    }
                } else if (!config.baby) {
                    babyStatusText.textContent = "Off";
                }

                // Render Safe Margin Overlay Box
                if (config.baby && config.debug) {
                    const mXPx = canvasElement.width * (state.babySafeMarginX / 100);
                    const mYPx = canvasElement.height * (state.babySafeMarginY / 100);
                    const oXPx = canvasElement.width * (state.babyOffsetX / 100);
                    const oYPx = canvasElement.height * (state.babyOffsetY / 100);

                    const rectWidth = canvasElement.width - (mXPx * 2);
                    const rectHeight = canvasElement.height - (mYPx * 2);
                    const rectCenterX = mXPx + oXPx + rectWidth / 2;
                    const rectCenterY = mYPx + oYPx + rectHeight / 2;

                    canvasCtx.save();
                    canvasCtx.translate(rectCenterX, rectCenterY);
                    canvasCtx.rotate((state.babyRotation || 0) * (Math.PI / 180));

                    canvasCtx.beginPath();
                    canvasCtx.lineWidth = 2;
                    canvasCtx.strokeStyle = "rgba(255, 0, 0, 0.5)";
                    canvasCtx.setLineDash([10, 5]);
                    canvasCtx.rect(-rectWidth / 2, -rectHeight / 2, rectWidth, rectHeight);
                    canvasCtx.stroke();
                    canvasCtx.setLineDash([]);
                    canvasCtx.restore();

                    // Render EMA Center tracker point
                    if (state.babyCenterEMA) {
                        canvasCtx.beginPath();
                        canvasCtx.arc(state.babyCenterEMA.x, state.babyCenterEMA.y, 6, 0, 2 * Math.PI);
                        canvasCtx.fillStyle = "rgba(0, 255, 255, 0.8)";
                        canvasCtx.fill();
                    }
                }

                // If container is detected and mouth is slightly open, count as drinking
                if (config.water && sawWaterContainer && jawOpen > 0.05) {
                    const now = Date.now();
                    // 10 second cooldown so it doesn't add multiple times per single sip action
                    if (now - state.lastWaterTime > 10000) {
                        addWater(0.25);
                        // Using a manual notification wrapper here so we don't spam if addWater logs already
                        // addWater triggers its own success notification
                    }
                }
            }

            // Stream Outgest: Send composite canvas to remote viewer securely
            if (socket && state.isMonitoring && !isRemoteMonitor) {
                const now = Date.now();
                if (now - (state.lastFrameSendTime || 0) > 100) { // Throttle ~10fps
                    state.lastFrameSendTime = now;

                    // Downscale the transmitted broadcast frame to eliminate network lag
                    const targetWidth = Math.floor(canvasElement.width / 2);
                    const targetHeight = Math.floor(canvasElement.height / 2);

                    if (offCanvas.width !== targetWidth) {
                        offCanvas.width = targetWidth;
                        offCanvas.height = targetHeight;
                    }

                    // Stitch the native hardware video frame and the AI bounding box layer together
                    offCtx.drawImage(video, 0, 0, offCanvas.width, offCanvas.height);
                    offCtx.drawImage(canvasElement, 0, 0, offCanvas.width, offCanvas.height);

                    // Aggressive compression for instant sub-second transmission
                    const frameData = offCanvas.toDataURL("image/jpeg", 0.5);
                    socket.emit('host_broadcast', {
                        frame: frameData,
                        stats: {
                            smileIntensity: smileIntensityText.textContent,
                            smileCount: smileCountText.textContent,
                            blinks: blinkCountText.textContent,
                            posture: posturePitchText.textContent,
                            baby: babyStatusText.textContent,
                            water: currentWaterText.textContent,
                            smileWidth: smileValue.style.width,
                            waterWheel: waterWheel.style.background,
                            w: canvasElement.width,
                            h: canvasElement.height
                        }
                    });
                }
            }
        } catch (error) {
            console.error("Error during prediction:", error);
        }
    }

    if (state.isMonitoring) {
        window.requestAnimationFrame(predictWebcam);
    }
}

function updateSmileStats(intensity) {
    state.smileIntensity = intensity;
    const percent = Math.round(intensity * 100);

    smileValue.style.width = `${percent}%`;
    smileIntensityText.textContent = `${percent}%`;

    // High intensity smile threshold
    if (intensity > 0.6) {
        const now = Date.now();
        // Only count as a new smile if 3 seconds have passed since last one
        if (now - state.lastSmileTime > 3000) {
            state.smileCount++;
            state.lastSmileTime = now;
            smileCountText.textContent = state.smileCount;
            localStorage.setItem('smileCount', state.smileCount);
            addNotification("Great smile! Keep it up!", "success");
        }
    }

    // Wellness Alert: If no smile for 15 minutes (using 30s for demo/testing if needed, but 15m for production)
    // Let's use 10 minutes for the prompt logic
    if (Date.now() - state.lastSmileTime > 600000) { // 10 minutes
        addNotification("It's been a while since you smiled. How about a quick break?", "urgent");
        state.lastSmileTime = Date.now(); // Reset timer to avoid spamming
    }
}

// Water Tracker Logic
function updateWaterUI() {
    currentWaterText.textContent = state.waterTotal.toFixed(2);
    const progress = (state.waterTotal / state.waterGoal) * 100;
    waterWheel.style.background = `conic-gradient(var(--primary) ${progress}%, transparent ${progress}%)`;
    localStorage.setItem('waterTotal', state.waterTotal);
}

function addWater(amount) {
    state.waterTotal += amount;
    state.lastWaterTime = Date.now();
    updateWaterUI();
    addNotification(`Drank ${amount * 1000}ml of water. Stay hydrated!`, "success");
}

function resetWater() {
    state.waterTotal = 0;
    updateWaterUI();
    addNotification("Water tracker reset.", "neutral");
}

// Notifications
function addNotification(message, type = "neutral", fromRemoteSync = false) {
    const item = document.createElement('div');
    item.className = `notification-item ${type === 'urgent' ? 'urgent' : ''}`;
    const now = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    item.innerHTML = `<span>[${now}] ${message}</span>`;

    notificationList.prepend(item);

    // Limit to 5 items
    if (notificationList.children.length > 5) {
        notificationList.removeChild(notificationList.lastChild);
    }

    // Broadcast notification string to remote viewer so activity feeds are identical
    if (socket && state.isMonitoring && !isRemoteMonitor && !fromRemoteSync) {
        socket.emit('host_broadcast', { notification: { message, type } });
    }

    // Audio Alert
    if (localSoundEnabled && type === "urgent") {
        const msg = message.toLowerCase();
        if (msg.includes('edge')) playSoundAlert('edge');
        else if (msg.includes('woke') || msg.includes('moving')) playSoundAlert('awake');
        else if (msg.includes('not detected')) playSoundAlert('missing');
    }

    // Light Notification Integration (LumaSense)
    if (localLightEnabled && type === "urgent") {
        const msg = message.toLowerCase();
        if (msg.includes('not detected')) triggerLumaSense('pulse', 'red');
        else if (msg.includes('edge')) triggerLumaSense('pulse', 'yellow');
        else triggerLumaSense('pulse', 'blue');
    }

    // Browser Notification
    if (Notification.permission === "granted" && type === "urgent") {
        new Notification("VisionPulse Alert", { body: message });
    }
}

let audioCtx;
async function playSoundAlert(type) {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') await audioCtx.resume();

    // Ensure state is active before creating nodes
    if (audioCtx.state !== 'running') return;

    const now = audioCtx.currentTime;

    if (type === 'edge') {
        // Quick double-beep (Warning)
        for (let i = 0; i < 2; i++) {
            const osc = audioCtx.createOscillator();
            const gainNode = audioCtx.createGain();
            osc.connect(gainNode);
            gainNode.connect(audioCtx.destination);

            osc.type = 'sine';
            osc.frequency.setValueAtTime(800, now + i * 0.2); // high pitch warning beep

            gainNode.gain.setValueAtTime(0, now + i * 0.2);
            gainNode.gain.linearRampToValueAtTime(0.5, now + i * 0.2 + 0.02);
            gainNode.gain.linearRampToValueAtTime(0, now + i * 0.2 + 0.15);

            osc.start(now + i * 0.2);
            osc.stop(now + i * 0.2 + 0.15);
        }
    } else if (type === 'awake') {
        // Soft rising chime / arpeggio (Wake up)
        const notes = [261.63, 329.63, 392.00, 523.25]; // C4, E4, G4, C5
        notes.forEach((freq, i) => {
            const osc = audioCtx.createOscillator();
            const gainNode = audioCtx.createGain();
            osc.connect(gainNode);
            gainNode.connect(audioCtx.destination);

            osc.type = 'sine';
            const startTime = now + i * 0.15;
            osc.frequency.setValueAtTime(freq, startTime);

            gainNode.gain.setValueAtTime(0, startTime);
            gainNode.gain.linearRampToValueAtTime(0.4, startTime + 0.05);
            gainNode.gain.exponentialRampToValueAtTime(0.01, startTime + 0.6);

            osc.start(startTime);
            osc.stop(startTime + 0.6);
        });
    } else if (type === 'missing') {
        const osc = audioCtx.createOscillator();
        const gainNode = audioCtx.createGain();
        osc.connect(gainNode);
        gainNode.connect(audioCtx.destination);

        // Deep buzzy square wave for missing
        osc.type = 'square';
        osc.frequency.setValueAtTime(300, now);
        osc.frequency.linearRampToValueAtTime(200, now + 0.5);

        gainNode.gain.setValueAtTime(0.2, now);
        gainNode.gain.linearRampToValueAtTime(0, now + 0.5);

        osc.start(now);
        osc.stop(now + 0.5);
    }
}

// LumaSense API Integration
function triggerLumaSense(mode, color, pattern = null) {
    let url = `http://localhost:18080/trigger?mode=${mode}&color=${color}`;
    if (pattern) {
        url = `http://localhost:18080/trigger?pattern=${pattern}`;
    }
    fetch(url, { method: 'GET', mode: 'no-cors' }) // no-cors for blind firing
        .catch(err => console.log('LumaSense unreachable', err));
}

// Event Listeners
startBtn.addEventListener('click', async () => {
    if (isRemoteMonitor && socket) {
        socket.emit('remote_command', { action: 'start' });

        // Remote UI specific
        startBtn.style.display = "none";
        stopBtn.style.display = "block";
        resetAnchorBtn.style.display = "block";
        resetAnchorBtn.textContent = "Reset Baby Center";
        const rc = document.getElementById('radius-container');
        if (rc) rc.style.display = 'flex';
        return;
    }

    startBtn.disabled = true;
    startBtn.textContent = "Loading Models...";

    try {
        if (Notification.permission === "default") {
            await Notification.requestPermission();
        }
        await initMediaPipe();
        await setupCamera();
    } catch (error) {
        console.error("Initialization error:", error);
        startBtn.textContent = "Error Loading";
        addNotification("Failed to load models or access camera. Check console.", "urgent");
        startBtn.disabled = false;
    }
});

stopBtn.addEventListener('click', () => {
    if (isRemoteMonitor && socket) {
        socket.emit('remote_command', { action: 'stop' });

        // Remote UI specific
        stopBtn.style.display = "none";
        resetAnchorBtn.style.display = "none";
        const rc = document.getElementById('radius-container');
        if (rc) rc.style.display = 'none';
        startBtn.style.display = "block";
        startBtn.textContent = "Start Monitoring";
        return;
    }
    stopCamera();
});

addWaterBtn.addEventListener('click', () => addWater(0.25));
resetWaterBtn.addEventListener('click', resetWater);

// Tab logic removed for single pane layout

// Init UI
updateWaterUI();
smileCountText.textContent = state.smileCount;

// Hydration Reminder (Check every minute)
setInterval(() => {
    const now = Date.now();
    // Reminder every 1 hour (3600000 ms)
    if (config.water && (now - state.lastWaterTime > 3600000)) {
        addNotification("Time to drink some water! Your body will thank you.", "urgent");
        state.lastWaterTime = now;
    }
}, 60000);

// Fullscreen code removed per user request
