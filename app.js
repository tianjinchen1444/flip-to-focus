/* Flip to Focus app layer: connects sensor.js to the team's timer.js (window.focusTimer),
 * keeps the session history, and runs the accuracy trials.
 * Policy from SENSOR_INTEGRATION.md: pause when posture, visibility, or the sensor is lost;
 * resume only after a fresh confirmed face-down reading.
 */
(() => {
  'use strict';

  const timer = window.focusTimer;
  const sensor = window.flipSensor;
  const $ = (id) => document.getElementById(id);

  const APP = {
    START_HOLD_MS: 3000,   // face-down and still this long before starting or resuming
    BRIEF_PAUSE_MS: 60000, // pauses shorter than this are "brief interruptions", longer ones "breaks"
    SENSOR_LOST_MS: 2000,  // no motion events for this long while focusing = pause
    TRIAL_MS: 8000,        // accuracy trial: wait this long, then record the detected state
    TICK_MS: 200,
  };

  const KEYS = {
    history: 'f2f.app.history.v1',
    causes: 'f2f.app.causes.v1',
    trials: 'f2f.app.trials.v1',
    settings: 'f2f.app.settings.v1',
  };

  const store = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage blocked: keep going */ }
    },
  };

  const settings = Object.assign({ participant: '', phone: '', surface: 'Desk', debug: false }, store.get(KEYS.settings, {}));
  let history = store.get(KEYS.history, []);
  let causes = store.get(KEYS.causes, {}); // pause segment index -> why it paused (current session)
  let trials = store.get(KEYS.trials, []);
  const saveSettings = () => store.set(KEYS.settings, settings);

  const SIM = new URLSearchParams(location.search).has('sim');
  let sensorsOn = false;
  let view = 'timer';
  let downSince = null;
  let trialRunning = false;
  let lastSensorChange = null;
  let feedbackForPause = 0; // pause segment index that already got feedback

  /* ---------------- formatting ---------------- */

  const pad = (n) => String(n).padStart(2, '0');
  function fmtClock(ms) {
    const t = Math.floor(ms / 1000);
    const h = Math.floor(t / 3600);
    return h ? `${h}:${pad(Math.floor((t % 3600) / 60))}:${pad(t % 60)}` : `${pad(Math.floor(t / 60))}:${pad(t % 60)}`;
  }
  const fmtShort = (ms) => `${Math.floor(ms / 60000)}:${pad(Math.floor(ms / 1000) % 60)}`;
  function fmtMin(ms) {
    const m = ms / 60000;
    if (m < 1) return `${Math.round(ms / 1000)}s`;
    if (m < 60) return `${Math.round(m)}m`;
    return `${Math.floor(m / 60)}h ${Math.round(m % 60)}m`;
  }
  const clockTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  const median = (v) => {
    const s = [...v].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const isBrief = (ms) => ms < APP.BRIEF_PAUSE_MS;

  const STATUS_LABEL = { idle: 'Not started', running: 'Focusing', paused: 'Paused', stopped: 'Ended' };
  const POSTURE_LABEL = { 'face-up': 'Face-up', 'face-down': 'Face-down', other: 'Picked up', unknown: 'Waiting for sensor' };
  const FEEDBACK_LABEL = { focusing: 'Still focusing', break: 'Taking a break', sleeping: 'Sleeping', other: 'Other' };

  /* ---------------- session metrics ---------------- */

  // Works for a live getState() and for a saved history entry's state.
  function metrics(state, pauseCauses = {}) {
    const focus = state.segments.filter((s) => s.type === 'focus');
    const pauses = state.segments.filter((s) => s.type === 'pause');
    const brief = pauses.filter((p) => isBrief(p.durationMs)).length;
    return {
      focusMs: state.focusMs,
      pauseMs: state.pauseMs,
      focusCount: state.focusCount,
      pauseCount: state.pauseCount,
      brief,
      breaks: pauses.length - brief,
      longestFocusMs: Math.max(0, ...focus.map((s) => s.durationMs)),
      firstFocusMs: focus.length ? focus[0].durationMs : 0,
      leftPage: Object.values(pauseCauses).filter((c) => c !== 'flip').length,
      feedback: state.feedback || [],
    };
  }

  /* ---------------- control loop ---------------- */

  function pauseWith(cause) {
    const state = timer.pause();
    if (state.status === 'paused') {
      causes[state.segments.length] = cause;
      store.set(KEYS.causes, causes);
    }
  }

  function control() {
    const now = Date.now();
    const r = sensor.getReading();
    if (r.state === 'face-down' && r.still) {
      if (downSince === null) downSince = now;
    } else {
      downSince = null;
    }
    const status = timer.getState().status;
    const sensorAlive = r.lastEventAt > 0 && now - r.lastEventAt < APP.SENSOR_LOST_MS;

    if (!sensorsOn || trialRunning) return;
    if (status === 'running') {
      if (!sensorAlive) pauseWith('sensor lost');
      else if (r.state !== 'face-down') pauseWith('flip');
      return;
    }
    // Only start or resume from the Timer screen, so accuracy trials never start a session.
    if (view !== 'timer') return;
    if ((status === 'idle' || status === 'paused') && sensorAlive && downSince !== null && now - downSince >= APP.START_HOLD_MS) {
      timer.start();
    }
  }

  /* ---------------- history ---------------- */

  function saveToHistory(state) {
    if (!state.startedAt || history.some((h) => h.id === state.startedAt)) return;
    const entry = {
      id: state.startedAt,
      participant: settings.participant,
      savedAt: new Date().toISOString(),
      causes: { ...causes },
      state: JSON.parse(JSON.stringify(state)),
    };
    history.unshift(entry);
    store.set(KEYS.history, history);
  }

  /* ---------------- rendering: timer ---------------- */

  function renderTimer(state) {
    const now = Date.now();
    const r = sensor.getReading();
    const countdown = downSince === null ? null : Math.max(1, Math.ceil((APP.START_HOLD_MS - (now - downSince)) / 1000));

    const pill = $('status-pill');
    pill.textContent = STATUS_LABEL[state.status];
    pill.className = `pill ${state.status}`;
    $('posture-pill').textContent = POSTURE_LABEL[r.state] || r.state;
    $('focus-clock').textContent = fmtClock(state.focusMs);
    document.body.classList.toggle('focusing', state.status === 'running');
    document.body.classList.toggle('is-paused', state.status === 'paused');

    // Live strip of this session's focus (blue) and pause (orange) stretches
    const strip = $('live-bar');
    strip.replaceChildren();
    if (state.status !== 'idle') {
      state.segments.forEach((seg) => {
        const part = el('span', seg.type === 'focus' ? 'f' : 'p');
        part.style.flexGrow = String(Math.max(seg.durationMs, 1));
        strip.appendChild(part);
      });
    }

    let hint;
    if (state.status === 'running') hint = 'Focusing. Pick up the phone to pause.';
    else if (state.status === 'stopped') hint = 'Session ended and saved.';
    else if (r.state === 'unknown') hint = 'Waiting for motion data…';
    else if (r.state === 'face-down') hint = countdown ? `${state.status === 'paused' ? 'Resuming' : 'Starting'} in ${countdown}…` : 'Hold still…';
    else if (state.status === 'paused') hint = 'Paused. Lay the phone face-down to resume, or end the session.';
    else hint = 'Lay the phone face-down to start.';
    $('hint').textContent = hint;

    // Current pause: live length, brief vs break, optional self-report
    const active = state.segments[state.segments.length - 1];
    const pausedNow = state.status === 'paused' && active && active.type === 'pause';
    $('pause-card').hidden = !pausedNow;
    if (pausedNow) {
      $('pause-clock').textContent = fmtShort(active.durationMs);
      $('pause-kind').textContent = isBrief(active.durationMs) ? 'Brief interruption' : 'Break';
      const answered = feedbackForPause === active.index;
      document.querySelectorAll('#feedback-chips .chip').forEach((c) => {
        if (!answered) c.classList.remove('done');
      });
    }

    const m = metrics(state);
    $('focus-count').textContent = m.focusCount;
    $('focus-min').textContent = `${state.focusMinutes.toFixed(2)} min`;
    $('pause-count').textContent = m.pauseCount;
    $('pause-min').textContent = `${state.pauseMinutes.toFixed(2)} min`;
    $('brief-breaks').textContent = `${m.brief} / ${m.breaks}`;

    $('stop-btn').hidden = !(state.status === 'running' || state.status === 'paused');
    $('summary-card').hidden = state.status !== 'stopped';
    if (state.status === 'stopped') {
      $('summary-text').textContent =
        `${fmtMin(m.focusMs)} of focus in ${m.focusCount} stretch${m.focusCount === 1 ? '' : 'es'}. `
        + `${m.pauseCount} pause${m.pauseCount === 1 ? '' : 's'} (${m.brief} brief, ${m.breaks} break${m.breaks === 1 ? '' : 's'}). `
        + `Longest stretch: ${fmtMin(m.longestFocusMs)}.`;
    }

    const body = $('timeline');
    body.replaceChildren();
    if (!state.segments.length) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td colspan="3" class="empty">No records yet.</td>';
      body.appendChild(tr);
    }
    state.segments.forEach((s) => {
      const tr = document.createElement('tr');
      tr.className = `${s.type === 'pause' ? 'is-pause' : ''} ${s.isActive ? 'is-active' : ''}`;
      const name = `${s.type === 'focus' ? 'Focus' : 'Pause'} ${s.number}`;
      const why = s.type === 'pause' && causes[s.index] && causes[s.index] !== 'flip' ? ` (${causes[s.index]})` : '';
      [name + why, clockTime(s.startedAt), s.minutes.toFixed(2)].forEach((v) => {
        const td = document.createElement('td');
        td.textContent = v;
        tr.appendChild(td);
      });
      body.appendChild(tr);
    });
  }

  /* ---------------- rendering: history ---------------- */

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // Stacked bars: focus minutes (bottom) and paused minutes (top) for each of the last 7 days.
  let chartSel = null;
  function renderWeekChart() {
    const card = $('h-chart-card');
    card.hidden = history.length === 0;
    if (card.hidden) return;
    const days = [];
    const today = new Date(); today.setHours(0, 0, 0, 0);
    for (let i = 6; i >= 0; i--) {
      const d = new Date(today); d.setDate(d.getDate() - i);
      days.push({ date: d, focus: 0, pause: 0, sessions: 0 });
    }
    for (const h of history) {
      const d = new Date(h.state.startedAt); d.setHours(0, 0, 0, 0);
      const slot = days.find((x) => x.date.getTime() === d.getTime());
      if (!slot) continue;
      const m = metrics(h.state, h.causes);
      slot.focus += m.focusMs / 60000; slot.pause += m.pauseMs / 60000; slot.sessions += 1;
    }
    const maxMin = Math.max(...days.map((d) => d.focus + d.pause), 1);
    const step = [1, 2, 5, 10, 15, 30, 60, 120].find((v) => maxMin / v <= 3) || 240;
    const top = Math.ceil(maxMin / step) * step;
    const W = 320, H = 150, L = 30, B = 20, T = 6, plotH = H - B - T, colW = (W - L) / 7, barW = Math.min(22, colW * 0.5);
    const y = (v) => T + plotH - (v / top) * plotH;
    const NS = 'http://www.w3.org/2000/svg';
    const node = (tag, attrs, text) => {
      const n = document.createElementNS(NS, tag);
      for (const k in attrs) n.setAttribute(k, attrs[k]);
      if (text != null) n.textContent = text;
      return n;
    };
    // Bar with only its outer end rounded (4px), square at the baseline or the segment below
    const bar = (x, y0, y1, fill, roundTop) => {
      const hgt = y0 - y1;
      if (hgt <= 0) return null;
      const r = roundTop ? Math.min(4, hgt, barW / 2) : 0;
      const d = `M${x},${y0} V${y1 + r} Q${x},${y1} ${x + r},${y1} H${x + barW - r} Q${x + barW},${y1} ${x + barW},${y1 + r} V${y0} Z`;
      return node('path', { d, fill });
    };
    const svg = node('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Focus and paused minutes for the last 7 days' });
    for (let v = 0; v <= top; v += step) {
      svg.appendChild(node('line', { class: 'grid', x1: L, x2: W, y1: y(v), y2: y(v) }));
      svg.appendChild(node('text', { class: 'axis', x: L - 6, y: y(v) + 4, 'text-anchor': 'end' }, `${v}m`));
    }
    const css = getComputedStyle(document.documentElement);
    const cf = css.getPropertyValue('--focus').trim(), cp = css.getPropertyValue('--pause').trim();
    const tip = $('h-chart-tip');
    const describe = (d) => `${d.date.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })}: `
      + (d.sessions ? `${Math.round(d.focus)} min focus, ${Math.round(d.pause)} min paused, ${d.sessions} session${d.sessions === 1 ? '' : 's'}` : 'no sessions');
    days.forEach((d, i) => {
      const g = node('g', { class: `day${chartSel === i ? ' sel' : ''}` });
      const x0 = L + i * colW;
      g.appendChild(node('rect', { class: 'hit', x: x0 + 2, y: T, width: colW - 4, height: plotH + B, rx: 6 }));
      const bx = x0 + (colW - barW) / 2;
      const yF = y(d.focus), yP = y(d.focus + d.pause);
      const hasPause = d.pause > 0 && yF - yP > 2.5;
      const fb = bar(bx, y(0), yF, cf, !hasPause);
      if (fb) g.appendChild(fb);
      if (hasPause) { const pb = bar(bx, yF - 2, yP, cp, true); if (pb) g.appendChild(pb); } // 2px gap between stacked parts
      g.appendChild(node('text', { class: 'axis', x: x0 + colW / 2, y: H - 5, 'text-anchor': 'middle' },
        i === 6 ? 'Today' : d.date.toLocaleDateString([], { weekday: 'short' })));
      g.appendChild(node('title', {}, describe(d)));
      const pick = () => { chartSel = i; tip.textContent = describe(d); svg.querySelectorAll('.day').forEach((n, j) => n.classList.toggle('sel', j === i)); };
      g.addEventListener('click', pick);
      g.addEventListener('mouseenter', pick);
      svg.appendChild(g);
    });
    $('h-chart').replaceChildren(svg);
    tip.textContent = chartSel != null ? describe(days[chartSel]) : 'Tap a day to see its minutes.';
  }

  function renderHistory() {
    const list = $('h-list');
    list.replaceChildren();
    $('h-empty').hidden = history.length > 0;

    const all = history.map((h) => ({ h, m: metrics(h.state, h.causes) }));
    const n = all.length;
    $('h-sessions').textContent = n;
    $('h-avg-focus').textContent = n ? fmtMin(all.reduce((s, x) => s + x.m.focusMs, 0) / n) : '0m';
    $('h-avg-pauses').textContent = n ? (all.reduce((s, x) => s + x.m.pauseCount, 0) / n).toFixed(1) : '0';

    renderWeekChart();

    // Reflection: brief interruptions vs breaks, and when the first pause tends to come
    const insights = $('h-insights');
    insights.replaceChildren();
    const brief = all.reduce((s, x) => s + x.m.brief, 0);
    const breaks = all.reduce((s, x) => s + x.m.breaks, 0);
    if (brief + breaks > 0) {
      insights.appendChild(el('p', '', brief >= breaks
        ? `${brief} of your ${brief + breaks} pauses were brief interruptions (under 1 min): mostly quick phone checks.`
        : `${breaks} of your ${brief + breaks} pauses were breaks of 1 min or more.`));
    }
    const firsts = all.filter((x) => x.m.pauseCount > 0).map((x) => x.m.firstFocusMs);
    if (firsts.length >= 2) {
      insights.appendChild(el('p', '', `Your first pause usually comes after about ${Math.max(1, Math.round(median(firsts) / 60000))} min of focus.`));
    }
    insights.hidden = !insights.childElementCount;

    for (const { h, m } of all) {
      const start = new Date(h.state.startedAt);
      const li = el('li', 'session');
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      const left = el('div');
      left.append(
        el('div', 's-when', `${start.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}, ${start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`),
        el('div', 's-focus', `${fmtMin(m.focusMs)} focus`),
      );
      const right = el('div', 's-right');
      right.append(el('div', '', `${m.pauseCount} pause${m.pauseCount === 1 ? '' : 's'}`), el('div', '', `${m.brief} brief · ${m.breaks} break${m.breaks === 1 ? '' : 's'}`));
      summary.append(left, right);

      const bar = el('div', 'bar');
      const total = m.focusMs + m.pauseMs || 1;
      const f = el('div', 'f');
      f.style.width = `${(m.focusMs / total) * 100}%`;
      const p = el('div', 'p');
      p.style.width = `${(m.pauseMs / total) * 100}%`;
      bar.append(f, p);

      const detail = el('div', 's-detail');
      detail.append(
        el('div', '', `Longest focus stretch: ${fmtMin(m.longestFocusMs)}`),
        el('div', '', `Time paused: ${fmtMin(m.pauseMs)}${m.leftPage ? ` (${m.leftPage} from leaving the page)` : ''}`),
      );
      if (m.feedback.length) {
        const ul = el('ul');
        m.feedback.forEach((fb) => ul.appendChild(el('li', '', `${clockTime(fb.recordedAt)}: ${FEEDBACK_LABEL[fb.label]}${fb.note ? ` (${fb.note})` : ''}`)));
        detail.append(el('div', '', 'Your notes:'), ul);
      }
      details.append(summary, bar, detail);
      li.appendChild(details);
      list.appendChild(li);
    }
  }

  /* ---------------- accuracy trials (O1) ---------------- */

  const TRIAL_STATES = ['face-down', 'face-up', 'other'];

  function renderTrials() {
    const box = $('trial-results');
    box.replaceChildren();
    if (!trials.length) {
      box.appendChild(el('p', 'fine', 'No trials yet.'));
      return;
    }
    const correct = trials.filter((t) => t.correct).length;
    box.appendChild(el('p', 'acc', `Accuracy: ${correct} / ${trials.length} = ${((correct / trials.length) * 100).toFixed(1)}%`));

    const cols = trials.some((t) => !TRIAL_STATES.includes(t.detected)) ? [...TRIAL_STATES, 'unknown'] : TRIAL_STATES;
    const table = el('table', 'matrix');
    const head = el('tr');
    head.appendChild(el('th', '', 'Actual ↓ / Detected →'));
    cols.forEach((c) => head.appendChild(el('th', '', POSTURE_LABEL[c])));
    table.appendChild(head);
    TRIAL_STATES.forEach((exp) => {
      const tr = el('tr');
      tr.appendChild(el('th', '', exp === 'other' ? 'Held in hand' : POSTURE_LABEL[exp]));
      cols.forEach((det) => {
        const count = trials.filter((t) => t.expected === exp && (cols.includes(t.detected) ? t.detected === det : det === 'unknown')).length;
        tr.appendChild(el('td', exp === det && count ? 'hit' : '', String(count)));
      });
      table.appendChild(tr);
    });
    box.appendChild(table);

    const bySurface = {};
    trials.forEach((t) => {
      bySurface[t.surface] = bySurface[t.surface] || { n: 0, ok: 0 };
      bySurface[t.surface].n++;
      if (t.correct) bySurface[t.surface].ok++;
    });
    box.appendChild(el('p', 'fine', Object.entries(bySurface).map(([s, v]) => `${s}: ${v.ok}/${v.n}`).join(' · ')));
  }

  function runTrial(expected) {
    if (trialRunning) return;
    trialRunning = true;
    const status = $('trial-status');
    document.querySelectorAll('.trial-buttons .btn').forEach((b) => { b.disabled = true; });
    const end = Date.now() + APP.TRIAL_MS;
    status.className = 'trial-status counting';
    const countdown = setInterval(() => {
      const left = end - Date.now();
      if (left > 0) {
        status.textContent = String(Math.ceil(left / 1000));
        return;
      }
      clearInterval(countdown);
      const r = sensor.getReading();
      const trial = {
        at: new Date().toISOString(),
        participant: settings.participant,
        phone: settings.phone,
        surface: settings.surface,
        expected,
        detected: r.state,
        correct: r.state === expected,
        stabilityLatencyMs: lastSensorChange ? lastSensorChange.latencyMs : null,
        z: r.z == null ? null : Number(r.z.toFixed(2)),
      };
      trials.push(trial);
      store.set(KEYS.trials, trials);
      beep(trial.correct);
      status.className = 'trial-status';
      status.textContent = `${trial.correct ? 'Correct' : 'Wrong'}: detected ${POSTURE_LABEL[trial.detected]}`;
      document.querySelectorAll('.trial-buttons .btn').forEach((b) => { b.disabled = false; });
      trialRunning = false;
      downSince = null;
      renderTrials();
    }, 100);
  }

  /* ---------------- export ---------------- */

  const csvCell = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const toCsv = (header, rows) => [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n');

  function sessionsCsv() {
    const header = ['session_start', 'session_stop', 'participant', 'focus_min', 'focus_count', 'pause_min', 'pause_count',
      'brief_pauses', 'breaks', 'longest_focus_min', 'first_pause_after_min', 'pauses_from_leaving_page', 'feedback'];
    const rows = history.map((h) => {
      const m = metrics(h.state, h.causes);
      return [h.state.startedAt, h.state.stoppedAt, h.participant, (m.focusMs / 60000).toFixed(2), m.focusCount,
        (m.pauseMs / 60000).toFixed(2), m.pauseCount, m.brief, m.breaks, (m.longestFocusMs / 60000).toFixed(2),
        m.pauseCount ? (m.firstFocusMs / 60000).toFixed(2) : '', m.leftPage,
        m.feedback.map((f) => f.label + (f.note ? `: ${f.note}` : '')).join('; ')];
    });
    return toCsv(header, rows);
  }

  function trialsCsv() {
    const header = ['time', 'participant', 'phone', 'surface', 'expected', 'detected', 'correct', 'stability_latency_ms', 'z'];
    return toCsv(header, trials.map((t) => [t.at, t.participant, t.phone, t.surface, t.expected, t.detected, t.correct, t.stabilityLatencyMs, t.z]));
  }

  async function saveFile(name, text, type) {
    const pid = settings.participant ? `${settings.participant.replace(/[^\w-]/g, '')}_` : '';
    const filename = `flip_to_focus_${pid}${new Date().toISOString().slice(0, 10)}_${name}`;
    const file = new File([text], filename, { type });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file] });
        return;
      } catch (err) {
        if (err && err.name === 'AbortError') return;
      }
    }
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  /* ---------------- audio, wake lock, toast ---------------- */

  let audioCtx = null;
  function unlockAudio() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      audioCtx = new Ctx();
      const src = audioCtx.createBufferSource();
      src.buffer = audioCtx.createBuffer(1, 1, 22050);
      src.connect(audioCtx.destination);
      src.start(0);
    } catch {
      audioCtx = null;
    }
  }
  function beep(ok) {
    if (!audioCtx) return;
    const t = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.frequency.value = ok ? 880 : 330;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.3, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t);
    osc.stop(t + 0.45);
  }

  let wakeState = 'off';
  async function requestWakeLock() {
    if (!('wakeLock' in navigator)) { wakeState = 'unsupported (set Auto-Lock to Never)'; return; }
    if (document.visibilityState !== 'visible') return;
    try {
      const lock = await navigator.wakeLock.request('screen');
      wakeState = 'on';
      lock.addEventListener('release', () => { wakeState = 'off'; });
    } catch {
      wakeState = 'failed (set Auto-Lock to Never)';
    }
  }

  let toastTimer = null;
  function toast(text) {
    const t = $('toast');
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2400);
  }

  function renderDebug() {
    const r = sensor.getReading();
    const f = (v) => (v == null ? '–' : v.toFixed(2));
    $('d-state').textContent = POSTURE_LABEL[r.state];
    $('d-raw').textContent = POSTURE_LABEL[r.raw];
    $('d-xyz').textContent = `${f(r.x)} / ${f(r.y)} / ${f(r.z)}`;
    $('d-motion').textContent = `${f(r.motion)} ${r.still ? '(still)' : '(moving)'}`;
    $('d-rate').textContent = r.eventsPerSecond;
    $('d-wake').textContent = wakeState;
  }

  /* ---------------- navigation and wiring ---------------- */

  function showView(name) {
    view = name;
    ['timer', 'history', 'tools'].forEach((v) => { $(`view-${v}`).hidden = v !== name; });
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === name));
    if (name === 'history') renderHistory();
    if (name === 'tools') renderTrials();
    window.scrollTo(0, 0);
  }

  function activate() {
    if (sensorsOn) return;
    sensorsOn = true;
    requestWakeLock();
  }

  function warn(text) {
    const w = $('sensor-warning');
    w.textContent = text;
    w.hidden = !text;
  }

  // No Start button: the page opens on the timer and turns sensors on by itself.
  // iOS only grants motion access inside a tap, so if no data arrives the first tap anywhere asks.
  function autoStart() {
    if (SIM) {
      activate();
      warn('Simulator mode: use the buttons at the bottom.');
      return;
    }
    sensor.enable().then(activate).catch(() => {});
    setTimeout(() => {
      if (sensor.getReading().lastEventAt === 0) warn('Tap anywhere to turn on motion sensing, then tap Allow.');
    }, 1000);
    const onFirstTap = () => {
      unlockAudio();
      if (sensor.getReading().lastEventAt > 0) return done();
      sensor.enable().then(() => { activate(); done(); }).catch((err) => {
        warn(`${err.message} If you tapped Don't Allow, close this tab and open the page again.`);
      });
    };
    const done = () => {
      document.removeEventListener('click', onFirstTap, true);
      document.removeEventListener('touchend', onFirstTap, true);
    };
    document.addEventListener('click', onFirstTap, true);
    document.addEventListener('touchend', onFirstTap, true);
  }

  function onFeedback(chip) {
    const label = chip.dataset.label;
    let note = '';
    if (label === 'other') {
      note = window.prompt('What are you doing?') || '';
      if (!note.trim()) return;
    }
    try {
      const state = timer.addFeedback(label, note);
      const active = state.segments[state.segments.length - 1];
      feedbackForPause = active ? active.index : 0;
      document.querySelectorAll('#feedback-chips .chip').forEach((c) => c.classList.toggle('done', c === chip));
      toast(`Noted: ${FEEDBACK_LABEL[label]}`);
    } catch (err) {
      toast(err.message);
    }
  }

  function init() {
    // A session restored while "running" has no sensor yet: pause it until the phone is face-down again.
    if (timer.getState().status === 'running') pauseWith('page closed');

    $('stop-btn').addEventListener('click', () => timer.stop());
    $('new-btn').addEventListener('click', () => timer.reset());
    document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => showView(t.dataset.view)));
    document.querySelectorAll('#feedback-chips .chip').forEach((c) => c.addEventListener('click', () => onFeedback(c)));

    window.addEventListener('focus-timer:change', (e) => {
      const { action, state } = e.detail;
      if (action === 'stop') {
        saveToHistory(state);
        toast('Session saved');
      } else if (action === 'reset') {
        causes = {};
        store.set(KEYS.causes, causes);
        feedbackForPause = 0;
      } else if (action === 'start' && state.focusCount === 1) {
        toast('Focus session started');
      }
      if (view === 'timer') renderTimer(state);
    });
    window.addEventListener('flip-sensor:change', (e) => { lastSensorChange = e.detail; });

    // Participant / trial settings
    const bind = (id, key) => {
      const input = $(id);
      input.value = settings[key];
      input.addEventListener('change', () => { settings[key] = input.value.trim(); saveSettings(); });
      input.addEventListener('input', () => { settings[key] = input.value.trim(); saveSettings(); });
    };
    bind('participant', 'participant');
    bind('trial-phone', 'phone');
    bind('trial-surface', 'surface');

    const debugToggle = $('debug-toggle');
    debugToggle.checked = settings.debug;
    $('debug').hidden = !settings.debug;
    debugToggle.addEventListener('change', () => {
      settings.debug = debugToggle.checked;
      $('debug').hidden = !settings.debug;
      saveSettings();
    });

    document.querySelectorAll('.trial-buttons .btn').forEach((b) => b.addEventListener('click', () => runTrial(b.dataset.expected)));
    $('trial-export').addEventListener('click', () => (trials.length ? saveFile('trials.csv', trialsCsv(), 'text/csv') : toast('No trials yet')));
    $('trial-clear').addEventListener('click', () => {
      if (trials.length && confirm('Delete all accuracy trials on this phone? Export first if you need them.')) {
        trials = [];
        store.set(KEYS.trials, trials);
        renderTrials();
      }
    });

    $('export-csv').addEventListener('click', () => (history.length ? saveFile('sessions.csv', sessionsCsv(), 'text/csv') : toast('No sessions yet')));
    $('export-json').addEventListener('click', () => {
      if (!history.length) return toast('No sessions yet');
      const data = { schemaVersion: 'app-1', exportedAt: new Date().toISOString(), timerVersion: timer.version,
        config: { sensor: sensor.CONFIG, app: APP }, sessions: history };
      return saveFile('sessions.json', JSON.stringify(data, null, 2), 'application/json');
    });
    $('clear-history').addEventListener('click', () => {
      if (history.length && confirm('Delete all saved sessions on this phone? Export first if you need them.')) {
        history = [];
        store.set(KEYS.history, history);
        renderHistory();
      }
    });

    if (SIM) {
      const panel = $('sim');
      panel.hidden = false;
      document.body.classList.add('sim-on');
      panel.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
        sensor.simulate(b.dataset.pose);
        $('sensor-warning').hidden = true;
        panel.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
      }));
    }

    // Leaving the page counts as a pause; coming back needs a fresh face-down to resume.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        if (timer.getState().status === 'running') pauseWith('left page');
      } else if (sensorsOn) {
        requestWakeLock();
      }
    });

    setInterval(() => {
      control();
      if (!SIM && sensor.getReading().lastEventAt > 0 && /^Tap anywhere/.test($('sensor-warning').textContent)) warn('');
      if (view === 'timer') renderTimer(timer.getState());
      if (view === 'tools' && settings.debug) renderDebug();
    }, APP.TICK_MS);
  }

  init();
  showView('timer');
  autoStart();
})();
