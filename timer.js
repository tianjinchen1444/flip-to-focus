/* Flip to Focus recorder, v2.1. No UI, DOM queries, or sensor code.
 * window.focusTimer: start(), pause(), resume(), stop(), reset(), getState(), addFeedback().
 * All durations use milliseconds; counts mean the number of recorded segments.
 */
(function (root) {
  'use strict';
  const feedbackLabels = ['focusing', 'sleeping', 'break', 'other'];

  class FocusTimer {
    constructor(now = () => Date.now()) {
      this.now = now;
      this.reset();
    }

    reset() {
      const changed = this.status !== 'idle';
      this.status = 'idle';
      this.startedAtMs = null;
      this.stoppedAtMs = null;
      this.segments = [];
      this.feedback = [];
      return changed;
    }

    time() {
      const value = this.now();
      if (!Number.isFinite(value)) throw new TypeError('Clock must return milliseconds.');
      const last = this.segments[this.segments.length - 1];
      return Math.max(value, last ? (last.endedAtMs ?? last.startedAtMs) : value);
    }

    close(at) {
      const last = this.segments[this.segments.length - 1];
      if (last && last.endedAtMs === null) last.endedAtMs = at;
    }

    open(type, at) {
      this.segments.push({ type, startedAtMs: at, endedAtMs: null });
    }

    start() {
      if (this.status !== 'idle' && this.status !== 'paused') return false;
      const at = this.time();
      if (this.status === 'idle') this.startedAtMs = at;
      else this.close(at);
      this.open('focus', at);
      this.status = 'running';
      return true;
    }

    resume() {
      return this.status === 'paused' ? this.start() : false;
    }

    pause() {
      if (this.status !== 'running') return false;
      const at = this.time();
      this.close(at);
      this.open('pause', at);
      this.status = 'paused';
      return true;
    }

    stop() {
      if (this.status !== 'running' && this.status !== 'paused') return false;
      const at = this.time();
      this.close(at);
      this.stoppedAtMs = at;
      this.status = 'stopped';
      return true;
    }

    addFeedback(label, note = '') {
      if (!feedbackLabels.includes(label)) throw new RangeError('Choose a valid activity label.');
      if (typeof note !== 'string') throw new TypeError('Feedback note must be text.');
      note = note.trim();
      if (note.length > 200) throw new RangeError('Keep the feedback note within 200 characters.');
      if (label === 'other' && !note) throw new RangeError('Describe the activity for Other.');
      if (this.status === 'idle') return false;
      const state = this.getState();
      this.feedback.push({
        id: this.feedback.length + 1,
        label,
        note,
        recordedAtMs: this.time(),
        timerStatus: this.status,
        segmentIndex: this.segments.length,
        elapsedMs: state.totalMs
      });
      return true;
    }

    getState() {
      const at = this.stoppedAtMs ?? this.time();
      let focusCount = 0, pauseCount = 0, focusMs = 0, pauseMs = 0;
      const segments = this.segments.map((segment, index) => {
        const durationMs = Math.max(0, (segment.endedAtMs ?? at) - segment.startedAtMs);
        const number = segment.type === 'focus' ? ++focusCount : ++pauseCount;
        if (segment.type === 'focus') focusMs += durationMs;
        else pauseMs += durationMs;
        return Object.freeze({
          index: index + 1,
          type: segment.type,
          number,
          startedAt: new Date(segment.startedAtMs).toISOString(),
          endedAt: segment.endedAtMs === null ? null : new Date(segment.endedAtMs).toISOString(),
          durationMs,
          minutes: durationMs / 60000,
          isActive: segment.endedAtMs === null
        });
      });
      return Object.freeze({
        status: this.status,
        focusCount,
        focusMs,
        focusMinutes: focusMs / 60000,
        pauseCount,
        pauseMs,
        pauseMinutes: pauseMs / 60000,
        totalMs: focusMs + pauseMs,
        startedAt: this.startedAtMs === null ? null : new Date(this.startedAtMs).toISOString(),
        stoppedAt: this.stoppedAtMs === null ? null : new Date(this.stoppedAtMs).toISOString(),
        segments: Object.freeze(segments),
        feedback: Object.freeze(this.feedback.map(item => Object.freeze({
          id: item.id,
          label: item.label,
          note: item.note,
          recordedAt: new Date(item.recordedAtMs).toISOString(),
          timerStatus: item.timerStatus,
          segmentIndex: item.segmentIndex,
          elapsedMs: item.elapsedMs
        })))
      });
    }

    snapshot() {
      return {
        version: 4,
        status: this.status,
        startedAtMs: this.startedAtMs,
        stoppedAtMs: this.stoppedAtMs,
        segments: this.segments.map(segment => ({ ...segment })),
        feedback: this.feedback.map(item => ({ ...item }))
      };
    }

    restore(saved) {
      if (!saved || ![3, 4].includes(saved.version) || !Array.isArray(saved.segments)
        || !['idle', 'running', 'paused', 'stopped'].includes(saved.status)) return false;
      const validTime = value => Number.isFinite(value)
        && Math.abs(value) <= 8640000000000000;
      if (saved.status === 'idle') {
        if (saved.segments.length || saved.startedAtMs !== null || saved.stoppedAtMs !== null
          || (saved.version === 4 && (!Array.isArray(saved.feedback) || saved.feedback.length))) return false;
        this.reset();
        return true;
      }
      if (!saved.segments.length || !validTime(saved.startedAtMs)
        || (saved.status === 'stopped' ? !validTime(saved.stoppedAtMs) : saved.stoppedAtMs !== null)) return false;
      let previousEnd = saved.startedAtMs;
      for (let index = 0; index < saved.segments.length; index += 1) {
        const segment = saved.segments[index];
        const active = index === saved.segments.length - 1 && saved.status !== 'stopped';
        if (!segment || segment.type !== (index % 2 === 0 ? 'focus' : 'pause')
          || !validTime(segment.startedAtMs) || segment.startedAtMs !== previousEnd
          || (active ? segment.endedAtMs !== null
            : !validTime(segment.endedAtMs) || segment.endedAtMs < segment.startedAtMs)) return false;
        previousEnd = segment.endedAtMs;
      }
      const last = saved.segments[saved.segments.length - 1];
      if ((saved.status === 'running' && last.type !== 'focus')
        || (saved.status === 'paused' && last.type !== 'pause')
        || (saved.status === 'stopped' && last.endedAtMs !== saved.stoppedAtMs)) return false;
      const feedback = saved.version === 3 ? [] : saved.feedback;
      if (!Array.isArray(feedback)) return false;
      for (let index = 0; index < feedback.length; index += 1) {
        const item = feedback[index];
        if (!item || item.id !== index + 1 || !feedbackLabels.includes(item.label)
          || typeof item.note !== 'string' || item.note.length > 200
          || (item.label === 'other' && !item.note.trim())
          || !validTime(item.recordedAtMs) || item.recordedAtMs < saved.startedAtMs
          || !['running', 'paused', 'stopped'].includes(item.timerStatus)
          || !Number.isInteger(item.segmentIndex) || item.segmentIndex < 1 || item.segmentIndex > saved.segments.length
          || !Number.isFinite(item.elapsedMs) || item.elapsedMs < 0) return false;
        const segment = saved.segments[item.segmentIndex - 1];
        if (item.recordedAtMs < segment.startedAtMs
          || (item.timerStatus === 'running' && segment.type !== 'focus')
          || (item.timerStatus === 'paused' && segment.type !== 'pause')
          || (item.timerStatus === 'stopped' && (saved.status !== 'stopped'
            || item.segmentIndex !== saved.segments.length || item.recordedAtMs < saved.stoppedAtMs))
          || (item.timerStatus !== 'stopped' && segment.endedAtMs !== null
            && item.recordedAtMs > segment.endedAtMs)) return false;
      }
      this.status = saved.status;
      this.startedAtMs = saved.startedAtMs;
      this.stoppedAtMs = saved.stoppedAtMs;
      this.segments = saved.segments.map(segment => ({
        type: segment.type, startedAtMs: segment.startedAtMs, endedAtMs: segment.endedAtMs
      }));
      this.feedback = feedback.map(item => ({
        id: item.id, label: item.label, note: item.note,
        recordedAtMs: item.recordedAtMs, timerStatus: item.timerStatus,
        segmentIndex: item.segmentIndex, elapsedMs: item.elapsedMs
      }));
      return true;
    }
  }

  if (typeof module === 'object' && module.exports) module.exports = { FocusTimer };
  // Headless in Node; automatic API and events in a browser, even without a page UI.
  if (!root || typeof root.dispatchEvent !== 'function' || root.focusTimer) return;
  const timer = new FocusTimer();
  const storageKey = root.FOCUS_TIMER_STORAGE_KEY || 'flip-to-focus.recorder.v1';
  try { timer.restore(JSON.parse(root.localStorage.getItem(storageKey))); } catch (_) {}
  const persist = () => {
    try { root.localStorage.setItem(storageKey, JSON.stringify(timer.snapshot())); } catch (_) {}
  };
  const emit = (name, detail) => root.dispatchEvent(new root.CustomEvent(name, { detail }));
  const command = (action, ...args) => {
    const changed = timer[action](...args);
    const state = timer.getState();
    if (changed) {
      persist();
      emit('focus-timer:change', { action: action === 'addFeedback' ? 'feedback' : action, state });
    }
    return state;
  };
  const api = Object.freeze({
    version: '2.1.0',
    start: () => command('start'),
    pause: () => command('pause'),
    resume: () => command('resume'),
    stop: () => command('stop'),
    reset: () => command('reset'),
    getState: () => timer.getState(),
    addFeedback: (label, note = '') => command('addFeedback', label, note)
  });
  root.focusTimer = api;
  let previousSecond = '';
  root.setInterval(() => {
    const state = timer.getState();
    const key = state.status + ':' + Math.floor(state.totalMs / 1000);
    if (key !== previousSecond) {
      previousSecond = key;
      emit('focus-timer:tick', { state });
    }
  }, 200);
  root.addEventListener('pagehide', persist);
  emit('focus-timer:ready', { state: api.getState() });
})(typeof window !== 'undefined' ? window : globalThis);
