import { PitchDetector } from 'pitchy';
import './style.css';

// --- Note utilities ---
const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const A4 = 440;
const CLARITY_THRESHOLD = 0.80;
const SMOOTHING_FRAMES = 3;
const GAP_BRIDGE_MAX = 5;     // bridge gaps up to N frames
const MAX_JUMP_SEMITONES = 3; // break line if pitch jumps more than this

function freqToNote(freq) {
  const semitones = 12 * Math.log2(freq / A4);
  const rounded = Math.round(semitones);
  const cents = Math.round((semitones - rounded) * 100);
  const midi = rounded + 69;
  const octave = Math.floor(midi / 12) - 1;
  const name = NOTE_NAMES[((midi % 12) + 12) % 12];
  return { name, octave, cents, midi };
}

// --- App state ---
let audioCtx, analyser, source, stream;
let isRecording = false;
let pitchHistory = [];
let recentNotes = [];
let lastFreq = null;
let silenceCount = 0;
const HISTORY_SECONDS = 5;
const FPS = 30;
let animFrame;

// Graph range (in MIDI note numbers)
let graphLow = 48;  // C3
let graphHigh = 72; // C5

// DOM
const startBtn = document.getElementById('startBtn');
const canvas = document.getElementById('pitchGraph');
const ctx = canvas.getContext('2d');
const graphLabels = document.getElementById('graphLabels');
const idleHint = document.getElementById('idleHint');

// Current note display state (rendered on canvas)
let currentNote = { name: '--', freq: 0, cents: 0, state: '' };

// --- Graph labels ---
function buildLabels() {
  graphLabels.innerHTML = '';
  const naturals = [0,2,4,5,7,9,11]; // C,D,E,F,G,A,B
  for (let midi = graphHigh; midi >= graphLow; midi--) {
    if (!naturals.includes(midi % 12)) continue;
    const oct = Math.floor(midi / 12) - 1;
    const name = NOTE_NAMES[midi % 12];
    const el = document.createElement('div');
    el.className = 'graph-label';
    el.textContent = name + oct;
    el.dataset.midi = midi;
    graphLabels.appendChild(el);
  }
}
buildLabels();

// --- Canvas resize ---
function resizeCanvas() {
  const rect = canvas.parentElement.getBoundingClientRect();
  const w = rect.width - 36;
  const h = rect.height;
  canvas.width = w * devicePixelRatio;
  canvas.height = h * devicePixelRatio;
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// --- Draw ---
function draw() {
  const w = canvas.width / devicePixelRatio;
  const h = canvas.height / devicePixelRatio;
  ctx.clearRect(0, 0, w, h);

  const range = graphHigh - graphLow;
  const pad = 12;
  const plotH = h - pad * 2;
  const plotW = w - 8;

  // Grid lines (all semitones)
  const naturals = [0,2,4,5,7,9,11];
  for (let midi = graphLow; midi <= graphHigh; midi++) {
    const y = pad + plotH * (1 - (midi - graphLow) / range);
    const isC = midi % 12 === 0;
    const isNatural = naturals.includes(midi % 12);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.strokeStyle = isC ? 'rgba(45,27,20,0.10)' : isNatural ? 'rgba(45,27,20,0.05)' : 'rgba(45,27,20,0.02)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  if (pitchHistory.length < 2) return;

  const maxPoints = HISTORY_SECONDS * FPS;
  const points = pitchHistory.slice(-maxPoints);
  const step = plotW / maxPoints;

  // Draw line segments, breaking on nulls or large pitch jumps
  ctx.beginPath();
  let prevMidi = null;
  let started = false;
  points.forEach((p, i) => {
    if (p === null) { prevMidi = null; started = false; return; }
    const x = 4 + i * step;
    const midiVal = 69 + 12 * Math.log2(p / A4);
    const y = pad + plotH * (1 - (midiVal - graphLow) / range);
    if (!started || prevMidi === null || Math.abs(midiVal - prevMidi) > MAX_JUMP_SEMITONES) {
      ctx.moveTo(x, y);
      started = true;
    } else {
      ctx.lineTo(x, y);
    }
    prevMidi = midiVal;
  });
  ctx.strokeStyle = 'rgba(255,155,123,0.8)';
  ctx.lineWidth = 2.5;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.stroke();

  // Glow
  ctx.strokeStyle = 'rgba(255,155,123,0.15)';
  ctx.lineWidth = 8;
  ctx.stroke();

  // Current dot (larger)
  const last = points[points.length - 1];
  if (last !== null) {
    const x = 4 + (points.length - 1) * step;
    const midiVal = 69 + 12 * Math.log2(last / A4);
    const y = pad + plotH * (1 - (midiVal - graphLow) / range);
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fillStyle = '#FF9B7B';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y, 8, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,155,123,0.2)';
    ctx.fill();
  }

  // Note overlay on canvas (top-right)
  if (currentNote.name !== '--') {
    const colors = { 'in-tune': '#7BCF8E', 'flat': '#FF7B7B', 'sharp': '#7BB8FF' };
    const color = colors[currentNote.state] || 'rgba(45,27,20,0.6)';
    ctx.fillStyle = color;
    ctx.font = 'bold 28px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(currentNote.name, w - 8, 30);
    ctx.font = '12px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.fillStyle = 'rgba(45,27,20,0.4)';
    const sign = currentNote.cents > 0 ? '+' : '';
    ctx.fillText(currentNote.freq.toFixed(0) + 'Hz  ' + sign + currentNote.cents + '¢', w - 8, 46);
  }
}

// --- Update loop ---
let detector;
let inputBuffer;

function update() {
  if (!isRecording) return;

  analyser.getFloatTimeDomainData(inputBuffer);
  const [pitch, clarity] = detector.findPitch(inputBuffer, audioCtx.sampleRate);

  const rawFreq = (clarity >= CLARITY_THRESHOLD && pitch > 50 && pitch < 2000) ? pitch : null;

  // Octave jump rejection + gap bridging (no EMA)
  let freq;
  if (rawFreq) {
    if (lastFreq) {
      const ratio = rawFreq / lastFreq;
      if (ratio > 1.8 && ratio < 2.2) freq = rawFreq / 2;
      else if (ratio > 0.45 && ratio < 0.55) freq = rawFreq * 2;
      else freq = rawFreq;
    } else {
      freq = rawFreq;
    }
    lastFreq = freq;
    silenceCount = 0;
  } else {
    silenceCount++;
    if (silenceCount > GAP_BRIDGE_MAX) lastFreq = null;
    freq = null;
  }

  // Push raw value, bridge short gaps with last known
  pitchHistory.push(freq || (silenceCount <= GAP_BRIDGE_MAX ? lastFreq : null));
  const maxPoints = HISTORY_SECONDS * FPS;
  if (pitchHistory.length > maxPoints) {
    pitchHistory = pitchHistory.slice(-maxPoints);
  }

  if (freq) {
    const note = freqToNote(freq);

    // Smoothing: only update display if note is stable
    recentNotes.push(note.name + note.octave);
    if (recentNotes.length > SMOOTHING_FRAMES) recentNotes.shift();

    const stableNote = recentNotes.length >= SMOOTHING_FRAMES &&
      recentNotes.every(n => n === recentNotes[0]);

    if (stableNote) {
      let state = '';
      if (Math.abs(note.cents) <= 5) state = 'in-tune';
      else if (note.cents < 0) state = 'flat';
      else state = 'sharp';
      currentNote = { name: note.name + note.octave, freq, cents: note.cents, state };
    }

    // Auto-adjust graph range (smoothly)
    const midi = note.midi;
    if (midi < graphLow + 4 || midi > graphHigh - 4) {
      const targetLow = Math.max(24, midi - 12);
      graphLow = Math.round(graphLow + (targetLow - graphLow) * 0.3);
      graphHigh = graphLow + 24;
      buildLabels();
    }
  } else if (silenceCount > GAP_BRIDGE_MAX) {
    recentNotes = [];
  }

  draw();
  animFrame = requestAnimationFrame(() => setTimeout(update, 1000 / FPS));
}

// --- Start / Stop ---
async function startRecording() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioCtx = new AudioContext();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 4096;
    source = audioCtx.createMediaStreamSource(stream);
    source.connect(analyser);

    // Initialize pitchy detector
    detector = PitchDetector.forFloat32Array(analyser.fftSize);
    inputBuffer = new Float32Array(analyser.fftSize);

    isRecording = true;
    pitchHistory = [];
    recentNotes = [];
    startBtn.textContent = 'STOP';
    startBtn.classList.add('recording');
    idleHint.style.display = 'none';
    update();
  } catch (e) {
    alert('마이크 접근이 필요합니다.');
  }
}

function stopRecording() {
  isRecording = false;
  cancelAnimationFrame(animFrame);
  if (source) source.disconnect();
  if (stream) stream.getTracks().forEach(t => t.stop());
  if (audioCtx) audioCtx.close();

  startBtn.textContent = 'START';
  startBtn.classList.remove('recording');
  currentNote = { name: '--', freq: 0, cents: 0, state: '' };
}

startBtn.addEventListener('click', () => {
  if (isRecording) stopRecording();
  else startRecording();
});

// Initial draw
draw();
