/* Flip to Focus posture sensor. No timer logic, no page UI.
 * Based on the team's sensor test page: accelerationIncludingGravity.z with a
 * ±7 m/s² threshold and a 300 ms stability check.
 * window.flipSensor: enable(), simulate(pose), getReading(), CONFIG.
 * Emits 'flip-sensor:change' when the confirmed state changes:
 *   detail = { state, previous, rawChangedAt, confirmedAt, latencyMs }
 * States: 'face-up' | 'face-down' | 'other' | 'unknown'
 */
(function (root) {
  'use strict';

  const CONFIG = {
    THRESHOLD: 7,          // m/s²; |z| above this counts as flat face-up or face-down
    STABILITY_DELAY: 300,  // ms the raw state must hold before it is confirmed
    MOTION_SMOOTH: 0.25,   // smoothing for the movement estimate
    STILL_LIMIT: 0.8,      // m/s²; smoothed deviation of |g| from 9.81 below this = still
  };

  // The team measured face-up z ≈ -9.7 and face-down z ≈ +9.8 on iPhone.
  // Android browsers report the opposite sign, so flip it there.
  const ua = root.navigator ? root.navigator.userAgent : '';
  const isIOS = /iPad|iPhone|iPod/.test(ua)
    || (root.navigator && root.navigator.platform === 'MacIntel' && root.navigator.maxTouchPoints > 1);
  const SIGN = isIOS ? 1 : -1;

  const reading = {
    x: null, y: null, z: null,  // z in the iPhone convention above
    motion: 0,
    raw: 'unknown',
    candidate: 'unknown',
    candidateSince: 0,
    notDownSince: null,
    confirmed: 'unknown',
    confirmedAt: 0,
    lastEventAt: 0,
    events: [],                 // event timestamps in the last second, for a rate readout
  };

  let simulatedPose = null;

  function emit(detail) {
    root.dispatchEvent(new root.CustomEvent('flip-sensor:change', { detail }));
  }

  function ingest(x, y, z) {
    const now = Date.now();
    reading.x = x;
    reading.y = y;
    reading.z = z;
    reading.lastEventAt = now;
    reading.events.push(now);
    while (reading.events.length && now - reading.events[0] > 1000) reading.events.shift();

    const deviation = Math.abs(Math.hypot(x, y, z) - 9.81);
    reading.motion += CONFIG.MOTION_SMOOTH * (deviation - reading.motion);

    let detected = 'other';
    if (z < -CONFIG.THRESHOLD) detected = 'face-up';
    else if (z > CONFIG.THRESHOLD) detected = 'face-down';
    reading.raw = detected;

    // Stability check to reduce false triggers
    if (detected !== reading.candidate) {
      reading.candidate = detected;
      reading.candidateSince = now;
    }
    // A phone held in the hand can flicker between face-up and other near the threshold,
    // so leaving face-down counts any non-face-down reading as one continuous change.
    if (detected === 'face-down') reading.notDownSince = null;
    else if (reading.notDownSince == null) reading.notDownSince = now;
    const leavingDown = reading.confirmed === 'face-down' && detected !== 'face-down';
    const changedAt = leavingDown ? reading.notDownSince : reading.candidateSince;
    if (detected !== reading.confirmed && now - changedAt >= CONFIG.STABILITY_DELAY) {
      const previous = reading.confirmed;
      reading.confirmed = detected;
      reading.confirmedAt = now;
      emit({
        state: detected,
        previous,
        rawChangedAt: changedAt,
        confirmedAt: now,
        latencyMs: now - changedAt,
      });
    }
  }

  function handleMotion(event) {
    if (simulatedPose) return;
    const a = event.accelerationIncludingGravity;
    if (!a || ![a.x, a.y, a.z].every(Number.isFinite)) return;
    ingest(SIGN * a.x, SIGN * a.y, SIGN * a.z);
  }

  // Must be called directly from a tap: iOS refuses the permission prompt after an await.
  function enable() {
    if (!root.isSecureContext) return Promise.reject(new Error('HTTPS is required for motion sensors.'));
    if (!('DeviceMotionEvent' in root)) return Promise.reject(new Error('This browser has no motion sensor support.'));
    const listen = () => { root.addEventListener('devicemotion', handleMotion); return 'granted'; };
    if (typeof root.DeviceMotionEvent.requestPermission === 'function' && isIOS) {
      return root.DeviceMotionEvent.requestPermission().then((permission) => {
        if (permission !== 'granted') throw new Error('Motion access was not allowed.');
        return listen();
      });
    }
    return Promise.resolve(listen());
  }

  // Simulator for computers and demo recordings.
  const POSES = {
    'face-up': [0.1, 0.2, -9.7],
    'face-down': [0.1, -0.2, 9.8],
    other: [0.5, 6.5, -6.8],
  };
  let simTimer = null;
  function simulate(pose) {
    simulatedPose = pose;
    if (simTimer) return;
    simTimer = root.setInterval(() => {
      if (!simulatedPose) return;
      const [x, y, z] = POSES[simulatedPose];
      const jitter = () => (Math.random() - 0.5) * 0.2;
      const shake = simulatedPose === 'other' ? 1.5 : 0;
      ingest(x + jitter() * (1 + shake), y + jitter() * (1 + shake), z + jitter() + shake * (Math.random() - 0.5));
    }, 50);
  }

  function getReading() {
    return Object.freeze({
      x: reading.x, y: reading.y, z: reading.z,
      raw: reading.raw,
      state: reading.confirmed,
      confirmedAt: reading.confirmedAt,
      still: reading.motion < CONFIG.STILL_LIMIT,
      motion: reading.motion,
      lastEventAt: reading.lastEventAt,
      eventsPerSecond: reading.events.length,
      platformSign: SIGN,
    });
  }

  root.flipSensor = Object.freeze({ enable, simulate, getReading, CONFIG, isIOS });
})(window);
