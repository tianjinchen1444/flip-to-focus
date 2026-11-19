# Flip to Focus (team app)

One iPhone web page that joins the team's pieces:

| File | Owner / origin | Role |
|---|---|---|
| `timer.js` | Team recorder API v2.1, **copied unchanged** | Focus/pause segments, stop, reset, feedback, localStorage |
| `sensor.js` | Built from the team's sensor test page | `accelerationIncludingGravity.z`, ±7 m/s² threshold, 300 ms stability |
| `app.js` | Glue | Calls `focusTimer.start()/pause()` from posture, keeps session history, accuracy trials |
| `index.html`, `styles.css`, `icon.svg` | UI | Teaser-deck colours (navy #183E50, mist #DCE5E9) |

## What it does (mapped to the teaser deck)

- **O2: posture controls the timer.** Face-down and still for 3 s starts or resumes; picking the phone up pauses it (about 0.3–0.5 s). Leaving the page or losing sensor data also pauses, as SENSOR_INTEGRATION.md asks. **End session** calls `stop()` and saves the session; **New session** calls `reset()`.
- **Session durations.** Focus count and minutes, pause count and minutes, and each segment in the Timeline.
- **Brief interruptions vs. longer breaks.** Pauses under 1 minute are "brief", longer ones "breaks" (`BRIEF_PAUSE_MS` in `app.js`). While paused, the user can tap *Still focusing / Taking a break / Sleeping / Other* (`focusTimer.addFeedback`).
- **Reflect on study patterns.** The Patterns tab lists past sessions and notes, e.g. how many pauses were brief and after how many minutes the first pause usually comes.
- **O1: real accuracy numbers.** Tools → Accuracy test: pick a surface, tap a test, place the phone. After 8 s it records expected vs. detected and beeps. It shows accuracy, a confusion matrix, and per-surface results. Export as CSV.
- **Exports:** sessions CSV/JSON (Patterns) and trials CSV (Tools), named with the participant ID.

## Change to the team's sensor logic

In testing, a phone held in the hand near the ±7 threshold flickered between "face-up" and "other". The 300 ms stability timer kept restarting, so the phone never stopped counting as face-down and the timer never paused. `sensor.js` now treats any run of non-face-down readings as one change when leaving face-down. Everything else matches the test page. On Android the z sign is flipped, because the team's measurements (face-up z ≈ -9.7) are iPhone-specific.

## Run it

1. Upload all files in this folder to a GitHub repository and turn on **Settings → Pages → Deploy from a branch → main / (root)**. Motion sensors only work over https.
2. Open the address in iPhone **Safari**. There is no Start button: the timer screen opens directly. On iPhone, the first tap anywhere asks for motion access (iOS only allows that prompt after a tap); tap **Allow**.
3. On a computer, add `?sim=1` to the address to get buttons that simulate face-up, face-down, and pick-up.

## Known limits

- The page must stay open; iOS pauses background pages. Set Auto-Lock to Never if the screen locks during a session.
- History, trials, and the current session live in this phone's localStorage. Export after each study day; Private Browsing erases them.
- Tested only in a desktop browser with simulated sensors; thresholds still need tuning on real phones (Tools → live readings).
