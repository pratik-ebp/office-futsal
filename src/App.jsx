import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  arrayUnion,
  collection,
  deleteDoc,
  deleteField,
  doc,
  getDoc,
  increment,
  getDocs,
  onSnapshot,
  serverTimestamp,
  setDoc,
  writeBatch,
} from 'firebase/firestore'
import { onAuthStateChanged, signInWithEmailAndPassword, signOut } from 'firebase/auth'
import { auth, db } from './firebase'
import { ROSTER } from './data/roster'
import './App.css'

const REMEMBERED_CODE_PREFIX = 'thursday-players:code:'
const rememberedCodeKey = (id) => `${REMEMBERED_CODE_PREFIX}${id}`
// Admin identity is enforced server-side by firestore.rules (same email).
// The client uses it only to decide whether to show admin UI.
const ADMIN_EMAIL = 'admin@officefutsal.com'

// Safari (private browsing, or "Prevent Cross-Site Tracking" in some
// configurations) can throw on localStorage access instead of just being
// unavailable. Remembering a code is a nice-to-have — it must never block
// the actual move if storage isn't writable.
function safeStorageGet(key) {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
function safeStorageSet(key, value) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // ignore — code just won't be remembered on this browser
  }
}
function safeStorageRemove(key) {
  try {
    localStorage.removeItem(key)
  } catch {
    // ignore
  }
}
const PLAYERS_COLLECTION = 'players'
const CODES_COLLECTION = 'playerCodes'
const RESPONSES_COLLECTION = 'responses'
const PAID_COLLECTION = 'paid'
const COSTS_COLLECTION = 'costs'
const STATUS_COLLECTION = 'matchStatus'
const MATCH_COLLECTION = 'matchInfo'
const LAST_PLAYED_ROSTER_COLLECTION = 'lastPlayedRoster'
// One doc per admin-deleted player id, so the seed roster never brings them
// back (the roster file itself can't be edited from the browser).
const REMOVED_PLAYERS_COLLECTION = 'removedPlayers'
// Per-player list of column moves for the current cycle ({from, to, at}),
// one doc keyed by cycle id. Wiped on reset, never archived to Last played.
const MOVEMENTS_COLLECTION = 'movements'
// Admin "are you joining?" nudges for Pending players this cycle: one doc,
// {playerId: nudgedAtMs}. Cleared when the player responds and on reset.
const NUDGES_COLLECTION = 'nudges'
// All-time per-player Present/Absent/Pending tally, set entirely by hand
// by the admin — no automatic tracking, no reset, one permanent doc.
const ATTENDANCE_COLLECTION = 'attendanceTally'
const ATTENDANCE_DOC_ID = 'all-time'
// Admin now controls resets manually (no more auto-rollover on a computed
// Thursday date), so every cycle-scoped collection lives under one fixed
// doc id instead of a date-derived key. "Last played" is a second fixed doc
// id in those same collections — an admin reset copies "current" into it
// before clearing "current", so the two tabs are just two doc ids and never
// touch each other outside that one archive step.
const CURRENT_DOC_ID = 'current'
const LAST_PLAYED_DOC_ID = 'lastPlayed'
const STATUS_LABELS = {
  counting: 'Counting players',
  booked: 'Booked',
  played: 'Played',
  collecting: 'Collecting payments',
  cancelled: 'Cancelled',
}
// Firestore docs cap out at 1 MiB; leave headroom for the other fields on
// the doc and base64's ~33% size overhead over the raw image bytes.
const MAX_IMAGE_DATA_URL_LENGTH = 700_000
// A player who hasn't made a single In/Out/Undo/Pay move in this many days
// gets a warning on their card; at 4x that, the warning explains they'd be
// removed (removal itself stays a manual admin action, this just tells them).
const INACTIVITY_WARNING_DAYS = 14
const INACTIVITY_REMOVAL_DAYS = 28

// A drawn classic black/white soccer-ball pattern (center pentagon + 5
// wedges) rather than relying on the ⚽ emoji, which rendered inconsistently
// (some platforms draw it flat/photorealistic, not the plain graphic look)
// and, combined with the old non-square scaling approach, ended up looking
// stretched like a rugby ball.
const FOOTBALL_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <circle cx="50" cy="50" r="48" fill="#f5f5f5" stroke="#1a1a1a" stroke-width="2"/>
  <polygon points="50,35 64.27,45.37 58.82,62.13 41.18,62.13 35.73,45.37" fill="#1a1a1a"/>
  <polygon points="71.2,11.9 79.76,18.12 76.49,28.18 65.91,28.18 62.64,18.12" fill="#1a1a1a"/>
  <polygon points="84.2,52.1 92.76,58.32 89.49,68.38 78.91,68.38 75.64,58.32" fill="#1a1a1a"/>
  <polygon points="50,77 58.56,83.22 55.29,93.28 44.71,93.28 41.44,83.22" fill="#1a1a1a"/>
  <polygon points="15.8,52.1 24.36,58.32 21.09,68.38 10.51,68.38 7.24,58.32" fill="#1a1a1a"/>
  <polygon points="28.8,11.9 37.36,18.12 34.09,28.18 23.51,28.18 20.24,18.12" fill="#1a1a1a"/>
</svg>
`.trim()
const FOOTBALL_DATA_URL = `data:image/svg+xml,${encodeURIComponent(FOOTBALL_SVG)}`

function formatMoney(n) {
  return `Rs. ${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

// Downscale + re-encode the picked file as JPEG, retrying smaller until it
// fits under MAX_IMAGE_DATA_URL_LENGTH. Returns null if even the smallest
// attempt is still too big (e.g. someone picks an absurdly detailed photo).
async function compressImage(file) {
  const bitmap = await createImageBitmap(file)
  const attempts = [
    { maxDim: 1000, quality: 0.75 },
    { maxDim: 800, quality: 0.6 },
    { maxDim: 600, quality: 0.5 },
  ]
  for (const { maxDim, quality } of attempts) {
    const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    const dataUrl = canvas.toDataURL('image/jpeg', quality)
    if (dataUrl.length < MAX_IMAGE_DATA_URL_LENGTH) return dataUrl
  }
  return null
}

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

// SHA-256 hex digest via the browser's built-in Web Crypto API — no library
// needed. Keeps the admin password and player codes out of the JS bundle
// and Firestore as plaintext (see firestore.rules for what this does and
// doesn't protect against).
async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text)
  const hashBuffer = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function isoDate(date) {
  return date.toISOString().slice(0, 10)
}

// A native <input type="date"> gives back "YYYY-MM-DD". Appending a local
// midnight time (rather than parsing the bare date string, which Date
// treats as UTC) avoids the day shifting backward one in timezones behind
// UTC. Returns the weekday and "Month Day" pair the rest of the app stores
// and displays (e.g. "Thursday" / "September 3").
function formatDayAndDate(isoDateStr) {
  const d = new Date(`${isoDateStr}T00:00:00`)
  return {
    day: d.toLocaleDateString('en-US', { weekday: 'long' }),
    date: d.toLocaleDateString('en-US', { month: 'long', day: 'numeric' }),
  }
}

// One-time (per empty database) seed from the roster file. Safe to call on
// every load — it's a no-op once any player doc exists. Seeded players get
// no code; run scripts/assign-codes.mjs afterward to assign them (writes to
// the separate playerCodes collection, never to /players itself).
async function ensureSeeded() {
  const snap = await getDocs(collection(db, PLAYERS_COLLECTION))
  if (!snap.empty) return
  const removedSnap = await getDocs(collection(db, REMOVED_PLAYERS_COLLECTION))
  const removedIds = new Set(removedSnap.docs.map((d) => d.id))
  const batch = writeBatch(db)
  for (const name of ROSTER) {
    if (removedIds.has(slugify(name))) continue
    batch.set(doc(db, PLAYERS_COLLECTION, slugify(name)), { name, lastMovedAt: serverTimestamp() })
  }
  await batch.commit()
}

// Players created before movement tracking existed have no lastMovedAt.
// Give them one (now) the first time anyone loads the app post-deploy, so
// the 14/28-day inactivity clock starts from today instead of either
// silently never firing or firing for everyone at once. Safe to call every
// load — a no-op once every player doc has the field.
async function backfillLastMovedAt() {
  const snap = await getDocs(collection(db, PLAYERS_COLLECTION))
  const missing = snap.docs.filter((d) => !d.data().lastMovedAt)
  if (missing.length === 0) return
  const batch = writeBatch(db)
  for (const d of missing) {
    batch.set(doc(db, PLAYERS_COLLECTION, d.id), { lastMovedAt: serverTimestamp() }, { merge: true })
  }
  await batch.commit()
}

// Firestore Timestamp (server-confirmed) or Date (rare local fallback) → whole
// days elapsed. Null while a brand-new player's serverTimestamp() write
// hasn't round-tripped yet, or for rows (e.g. Last played) that don't carry
// this field at all.
function daysSinceMoved(p) {
  if (!p.lastMovedAt) return null
  const moved = typeof p.lastMovedAt.toDate === 'function' ? p.lastMovedAt.toDate() : new Date(p.lastMovedAt)
  return Math.floor((Date.now() - moved.getTime()) / (24 * 60 * 60 * 1000))
}

function App() {
  const responsesDocId = CURRENT_DOC_ID

  const [activeTab, setActiveTab] = useState('current')

  const [players, setPlayers] = useState([])
  const [responses, setResponses] = useState({})
  const [paid, setPaid] = useState({})
  const [cost, setCost] = useState(null)
  const [matchStatus, setMatchStatus] = useState('counting')
  const [matchInfo, setMatchInfo] = useState(null)
  const [matchDateISO, setMatchDateISO] = useState('')
  const [matchInfoSaving, setMatchInfoSaving] = useState(false)
  const [loading, setLoading] = useState(true)

  // Last played: a frozen-at-archive-time mirror of the same shape, kept
  // live-subscribed (not just loaded on tab switch) so payment moves made
  // here while viewing this tab update immediately, same as Current.
  const [movements, setMovements] = useState({})
  const [nudges, setNudges] = useState({})
  const [expandedIds, setExpandedIds] = useState(() => new Set())
  const [attendanceTally, setAttendanceTally] = useState({})
  const [lastPlayedRoster, setLastPlayedRoster] = useState([])
  const [lastPlayedResponses, setLastPlayedResponses] = useState({})
  const [lastPlayedPaid, setLastPlayedPaid] = useState({})
  const [lastPlayedCost, setLastPlayedCost] = useState(null)
  const [lastPlayedMatchInfo, setLastPlayedMatchInfo] = useState(null)
  const [lastPlayedStatus, setLastPlayedStatus] = useState(null)
  const [newName, setNewName] = useState('')
  const [newCode, setNewCode] = useState('')
  const [addError, setAddError] = useState('')
  const [guestName, setGuestName] = useState('')
  const [guestError, setGuestError] = useState('')
  const [search, setSearch] = useState('')

  const costImageRef = useRef(null)
  const [costTotalInput, setCostTotalInput] = useState('')
  const [costPlayerCountInput, setCostPlayerCountInput] = useState('')
  const [costDateISO, setCostDateISO] = useState('')
  const [costError, setCostError] = useState('')
  const [costSaving, setCostSaving] = useState(false)
  const [imageExpanded, setImageExpanded] = useState(false)
  const [showResetConfirm, setShowResetConfirm] = useState(false)

  // UI flag only — derived from the real Firebase Auth session. Firestore
  // rules are what actually block non-admin writes.
  const [isAdmin, setIsAdmin] = useState(false)
  const [showLogin, setShowLogin] = useState(false)
  const [emailInput, setEmailInput] = useState('')
  const [passwordInput, setPasswordInput] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [loginError, setLoginError] = useState('')

  // Code-gate for column moves (In/Out/Undo/Pay/Unpay): one player row at a
  // time shows an inline 4-digit code prompt instead of performing the move.
  const [verifyingId, setVerifyingId] = useState(null)
  const [verifyAction, setVerifyAction] = useState(null)
  const [codeInput, setCodeInput] = useState('')
  const [codeError, setCodeError] = useState('')
  // Checking a remembered code against Firestore before deciding whether to
  // show the prompt is a network round trip — on a slow connection that's
  // silent time with no prompt and no move yet. Track it so the row can
  // show something instead of looking hung.
  const [checkingId, setCheckingId] = useState(null)
  // Admin editing a player's name/code inline on their card — one row at a
  // time, same pattern as the verify prompt above.
  const [editingId, setEditingId] = useState(null)
  const [editName, setEditName] = useState('')
  const [editCode, setEditCode] = useState('')
  const [editError, setEditError] = useState('')
  // Admin editing a player's all-time Present/Absent/Pending tally by
  // hand — same one-row-at-a-time pattern as the name/code edit above.
  // Overwrites all three counts outright, permanently (no reset, ever).
  const [editingTallyId, setEditingTallyId] = useState(null)
  const [tallyPresentInput, setTallyPresentInput] = useState('0')
  const [tallyAbsentInput, setTallyAbsentInput] = useState('0')
  const [tallyPendingInput, setTallyPendingInput] = useState('0')

  // Ball-arc move animation: rowRefs tracks every currently-mounted row DOM
  // node by player id (across all four columns) so we can grab its rect
  // right before a move and again right after it lands in a new column.
  // flightsRef holds "captured but not yet animated" start rects between
  // the click and the next responses/paid update — a plain ref (not state)
  // since it's imperative bookkeeping, not something that should re-render.
  const rowRefs = useRef(new Map())
  const flightsRef = useRef(new Map())
  const ballLayerRef = useRef(null)

  function setRowRef(id) {
    return (el) => {
      if (el) rowRefs.current.set(id, el)
      else rowRefs.current.delete(id)
    }
  }

  useEffect(() => {
    return onAuthStateChanged(auth, (user) => {
      setIsAdmin(!!user && user.email?.toLowerCase() === ADMIN_EMAIL)
    })
  }, [])

  useEffect(() => {
    ensureSeeded().then(backfillLastMovedAt)
    const unsubscribe = onSnapshot(collection(db, PLAYERS_COLLECTION), (snap) => {
      const list = snap.docs.map((d) => ({ id: d.id, name: d.data().name, lastMovedAt: d.data().lastMovedAt ?? null, flagged: !!d.data().flagged }))
      list.sort((a, b) => a.name.localeCompare(b.name))
      setPlayers(list)
      setLoading(false)
    })
    return unsubscribe
  }, [])

  useEffect(() => {
    const unsubscribe = onSnapshot(doc(db, RESPONSES_COLLECTION, responsesDocId), (snap) => {
      setResponses(snap.exists() ? snap.data() : {})
    })
    return unsubscribe
  }, [responsesDocId])

  useEffect(() => {
    const unsubscribe = onSnapshot(doc(db, ATTENDANCE_COLLECTION, ATTENDANCE_DOC_ID), (snap) => {
      setAttendanceTally(snap.exists() ? snap.data() : {})
    })
    return unsubscribe
  }, [])

  useEffect(() => {
    const unsubscribe = onSnapshot(doc(db, NUDGES_COLLECTION, responsesDocId), (snap) => {
      setNudges(snap.exists() ? snap.data() : {})
    })
    return unsubscribe
  }, [responsesDocId])

  useEffect(() => {
    const unsubscribe = onSnapshot(doc(db, MOVEMENTS_COLLECTION, responsesDocId), (snap) => {
      setMovements(snap.exists() ? snap.data() : {})
    })
    return unsubscribe
  }, [responsesDocId])

  useEffect(() => {
    const unsubscribe = onSnapshot(doc(db, PAID_COLLECTION, responsesDocId), (snap) => {
      setPaid(snap.exists() ? snap.data() : {})
    })
    return unsubscribe
  }, [responsesDocId])

  useEffect(() => {
    const unsubscribe = onSnapshot(doc(db, COSTS_COLLECTION, responsesDocId), (snap) => {
      setCost(snap.exists() ? snap.data() : null)
    })
    return unsubscribe
  }, [responsesDocId])

  useEffect(() => {
    const unsubscribe = onSnapshot(doc(db, STATUS_COLLECTION, responsesDocId), (snap) => {
      setMatchStatus(snap.exists() ? snap.data().status : 'counting')
    })
    return unsubscribe
  }, [responsesDocId])

  useEffect(() => {
    const unsubscribe = onSnapshot(doc(db, MATCH_COLLECTION, responsesDocId), (snap) => {
      setMatchInfo(snap.exists() ? snap.data() : null)
    })
    return unsubscribe
  }, [responsesDocId])

  useEffect(() => {
    const unsubscribe = onSnapshot(doc(db, LAST_PLAYED_ROSTER_COLLECTION, LAST_PLAYED_DOC_ID), (snap) => {
      setLastPlayedRoster(snap.exists() ? snap.data().players ?? [] : [])
    })
    return unsubscribe
  }, [])

  useEffect(() => {
    const unsubscribe = onSnapshot(doc(db, RESPONSES_COLLECTION, LAST_PLAYED_DOC_ID), (snap) => {
      setLastPlayedResponses(snap.exists() ? snap.data() : {})
    })
    return unsubscribe
  }, [])

  useEffect(() => {
    const unsubscribe = onSnapshot(doc(db, PAID_COLLECTION, LAST_PLAYED_DOC_ID), (snap) => {
      setLastPlayedPaid(snap.exists() ? snap.data() : {})
    })
    return unsubscribe
  }, [])

  useEffect(() => {
    const unsubscribe = onSnapshot(doc(db, COSTS_COLLECTION, LAST_PLAYED_DOC_ID), (snap) => {
      setLastPlayedCost(snap.exists() ? snap.data() : null)
    })
    return unsubscribe
  }, [])

  useEffect(() => {
    const unsubscribe = onSnapshot(doc(db, MATCH_COLLECTION, LAST_PLAYED_DOC_ID), (snap) => {
      setLastPlayedMatchInfo(snap.exists() ? snap.data() : null)
    })
    return unsubscribe
  }, [])

  useEffect(() => {
    const unsubscribe = onSnapshot(doc(db, STATUS_COLLECTION, LAST_PLAYED_DOC_ID), (snap) => {
      setLastPlayedStatus(snap.exists() ? snap.data().status : null)
    })
    return unsubscribe
  }, [])

  // Fires synchronously after responses/paid change and the board has
  // re-rendered rows into their new columns, but before the browser paints
  // (useLayoutEffect, not useEffect) — so the real destination row can be
  // dimmed to a "landing here" placeholder before it's ever shown at full
  // opacity, while a flying clone of the row (grabbed at click time by
  // runMove) arcs from its old spot to its new one.
  useLayoutEffect(() => {
    if (flightsRef.current.size === 0) return
    const pending = Array.from(flightsRef.current.entries())
    flightsRef.current.clear()
    for (const [id, flight] of pending) {
      const el = rowRefs.current.get(id)
      if (!el) continue
      animateCardArc(flight, el)
    }
  }, [responses, paid, lastPlayedResponses, lastPlayedPaid])

  function animateCardArc(flight, toEl) {
    const layer = ballLayerRef.current
    if (!layer) return
    const fromRect = flight.rect
    const toRect = toEl.getBoundingClientRect()
    const dist = Math.hypot(toRect.left - fromRect.left, toRect.top - fromRect.top)
    if (dist < 4) return // same spot — nothing to animate

    toEl.classList.add('card-incoming')

    // A goalpost frames the landing spot for the whole flight — appears as
    // the shot is taken, gone the moment the card lands — so the move reads
    // as scoring a goal rather than just an arc between two points.
    const goalWidth = Math.max(110, Math.min(170, toRect.width * 0.55))
    const goalHeight = goalWidth * 0.34
    const goalLeft = toRect.left + toRect.width / 2 - goalWidth / 2
    const goalTop = toRect.top + toRect.height / 2 - goalHeight
    const goal = document.createElement('div')
    goal.className = 'goal-post'
    goal.style.width = `${goalWidth}px`
    goal.style.height = `${goalHeight}px`
    goal.style.left = `${goalLeft}px`
    goal.style.top = `${goalTop}px`
    const net = document.createElement('div')
    net.className = 'goal-net'
    goal.appendChild(net)
    layer.appendChild(goal)
    goal.animate([{ opacity: 0, transform: 'scaleY(0.85)' }, { opacity: 1, transform: 'scaleY(1)' }], {
      duration: 220,
      easing: 'ease-out',
      fill: 'forwards',
    })

    const clone = flight.node
    clone.classList.add('flying-card')
    clone.style.width = `${fromRect.width}px`
    clone.style.height = `${fromRect.height}px`
    clone.style.left = `${fromRect.left}px`
    clone.style.top = `${fromRect.top}px`
    layer.appendChild(clone)

    // A separate, always-square ball — not the card scaled down. Scaling a
    // wide rectangular card down non-uniformly to fake a circle (the
    // previous approach) rendered as an ellipse/rugby-ball whenever its
    // aspect ratio wasn't exactly compensated for, and any rotation on top
    // of that made it worse. A dedicated square element with its own
    // circular pattern is circular no matter what.
    const ballSize = 42
    const ball = document.createElement('div')
    ball.className = 'flying-ball'
    ball.style.width = `${ballSize}px`
    ball.style.height = `${ballSize}px`
    ball.style.backgroundImage = `radial-gradient(circle at 30% 25%, rgba(255, 255, 255, 0.55), rgba(255, 255, 255, 0) 45%), url("${FOOTBALL_DATA_URL}")`
    layer.appendChild(ball)

    // The ball flies INTO the net, not to the row itself — the row only
    // pops in once the net has taken the impact.
    const fromCenterX = fromRect.left + fromRect.width / 2
    const fromCenterY = fromRect.top + fromRect.height / 2
    // Aim for the top-right corner of the net when traveling left-to-right,
    // top-left when traveling right-to-left — a shot into the far top
    // corner reads more like an actual goal than a flat shot into dead
    // center.
    const cornerInset = goalWidth * 0.14
    const movingRight = fromRect.left <= toRect.left
    const netCenterX = movingRight ? goalLeft + goalWidth - cornerInset : goalLeft + cornerInset
    const netCenterY = goalTop + goalHeight * 0.24
    const arcHeight = Math.min(170, Math.max(60, dist * 0.32))
    const midCenterX = (fromCenterX + netCenterX) / 2
    const midCenterY = (fromCenterY + netCenterY) / 2 - arcHeight
    const duration = Math.min(1150, Math.max(600, dist * 1.2))
    const spins = Math.max(2, Math.round(dist / 110))
    // Crossfade envelope: card fades out, ball fades in, over the first
    // slice of the flight — then the ball is the only thing flying for the
    // rest of the arc, all the way to impact.
    const riseEnd = 0.16
    const smoothstep = (x) => x * x * (3 - 2 * x)
    const revealAt = (t) => (t < riseEnd ? smoothstep(t / riseEnd) : 1)

    clone.animate(
      [
        { opacity: 1, transform: 'translateY(0)', offset: 0 },
        { opacity: 0, transform: 'translateY(-14px)', offset: 1 },
      ],
      { duration: duration * riseEnd, easing: 'ease-out', fill: 'forwards' },
    )

    const steps = 30
    const ballFrames = []
    for (let i = 0; i <= steps; i++) {
      const t = i / steps
      const x = (1 - t) ** 2 * fromCenterX + 2 * (1 - t) * t * midCenterX + t ** 2 * netCenterX - ballSize / 2
      const y = (1 - t) ** 2 * fromCenterY + 2 * (1 - t) * t * midCenterY + t ** 2 * netCenterY - ballSize / 2
      const rotate = spins * 360 * t
      ballFrames.push({
        transform: `translate(${x}px, ${y}px) rotate(${rotate}deg)`,
        opacity: revealAt(t),
        offset: t,
      })
    }

    // Outer timing is linear — the keyframes above already carry their own
    // easing (the rise curve, the bezier arc), so a second eased timing
    // function on top would just distort it.
    const anim = ball.animate(ballFrames, { duration, easing: 'linear', fill: 'forwards' })

    const revealDestination = () => {
      const goalFade = goal.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, easing: 'ease-in', fill: 'forwards' })
      goalFade.onfinish = () => goal.remove()
      goalFade.oncancel = () => goal.remove()
      // The destination column can be far from wherever the player had
      // scrolled to (e.g. scrolled to the bottom of a long Pending list,
      // moving to In near the top) — bring the landed card into view before
      // revealing it so the move doesn't look like it silently vanished.
      toEl.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
      toEl.classList.remove('card-incoming')
      toEl.classList.add('card-landed')
      setTimeout(() => toEl.classList.remove('card-landed'), 500)
    }

    // Impact: the ball vanishes into the net and the net bulges as if it
    // just caught a shot. The move only completes (row reveal) once that
    // bulge has played, not the instant the ball arrives.
    const impact = () => {
      clone.remove() // already faded out during the crossfade, just cleanup
      ball.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 100, easing: 'ease-out', fill: 'forwards' }).onfinish = () =>
        ball.remove()
      const bulge = net.animate(
        [
          { transform: 'scale(1, 1)', offset: 0 },
          { transform: 'scale(1.08, 0.95) translateY(2px)', offset: 0.35 },
          { transform: 'scale(0.98, 1.02) translateY(-1px)', offset: 0.65 },
          { transform: 'scale(1, 1)', offset: 1 },
        ],
        { duration: 300, easing: 'ease-out' },
      )
      bulge.onfinish = revealDestination
      bulge.oncancel = revealDestination
    }
    anim.onfinish = impact
    anim.oncancel = impact
  }

  // Prefill the admin edit fields once, when this week's cost doc first
  // loads — but only if the admin hasn't started typing into them yet.
  // isoDate is only present on docs saved since the calendar-picker switch;
  // older docs just leave the picker empty until re-saved.
  useEffect(() => {
    if (cost && costTotalInput === '' && costPlayerCountInput === '') {
      setCostTotalInput(String(cost.totalCost))
      setCostPlayerCountInput(String(cost.playerCount))
      setCostDateISO(cost.isoDate ?? '')
    }
  }, [cost])

  // Same idea for the match date field.
  useEffect(() => {
    if (matchInfo && matchDateISO === '') {
      setMatchDateISO(matchInfo.isoDate ?? '')
    }
  }, [matchInfo])

  async function addPlayer(e) {
    e.preventDefault()
    if (!isAdmin) return
    const name = newName.trim()
    const code = newCode.trim()
    if (!name) return
    if (!/^\d{4}$/.test(code)) {
      setAddError('Code must be exactly 4 digits.')
      return
    }
    const id = slugify(name) || crypto.randomUUID()
    const codeHash = await sha256Hex(code)
    await setDoc(doc(db, PLAYERS_COLLECTION, id), { name, lastMovedAt: serverTimestamp() })
    await setDoc(doc(db, CODES_COLLECTION, id), { codeHash })
    setNewName('')
    setNewCode('')
    setAddError('')
  }

  // A walk-in who filled in for the last match but was never part of the
  // main roster. Goes straight into the Last played roster only — never
  // PLAYERS_COLLECTION — so they never show up as Pending on Current.
  async function addGuestToLastPlayed(e) {
    e.preventDefault()
    if (!isAdmin) return
    const name = guestName.trim()
    if (!name) return
    const id = slugify(name) || crypto.randomUUID()
    if (lastPlayedRoster.some((p) => p.id === id)) {
      setGuestError('Already in Last played.')
      return
    }
    await setDoc(doc(db, LAST_PLAYED_ROSTER_COLLECTION, LAST_PLAYED_DOC_ID), {
      players: [...lastPlayedRoster, { id, name }],
    })
    setGuestName('')
    setGuestError('')
  }

  async function deletePlayerData(player) {
    const id = player.id
    await deleteDoc(doc(db, PLAYERS_COLLECTION, id))
    await deleteDoc(doc(db, CODES_COLLECTION, id))
    await setDoc(doc(db, REMOVED_PLAYERS_COLLECTION, id), { name: player.name, removedAt: serverTimestamp() })
    await setDoc(
      doc(db, RESPONSES_COLLECTION, responsesDocId),
      { [id]: deleteField() },
      { merge: true },
    )
    await setDoc(doc(db, PAID_COLLECTION, responsesDocId), { [id]: deleteField() }, { merge: true })
    await setDoc(doc(db, MOVEMENTS_COLLECTION, responsesDocId), { [id]: deleteField() }, { merge: true })
    await setDoc(doc(db, NUDGES_COLLECTION, responsesDocId), { [id]: deleteField() }, { merge: true })
  }

  async function removePlayer(player) {
    if (!isAdmin) return
    if (!confirm(`Remove ${player.name}? This deletes their code and this week's response too.`)) return
    await deletePlayerData(player)
  }

  // Auto-removal: a Pending player with no movement for INACTIVITY_REMOVAL_DAYS
  // is deleted entirely. Runs only in an admin session (a visitor with a wrong
  // clock must never be able to mass-delete), once per page load, and aborts
  // if it would remove more than half the roster — that pattern means a bad
  // clock or bad data, not real inactivity. Reset never touches lastMovedAt,
  // so it doesn't rescue anyone from this.
  const sweptRef = useRef(false)
  useEffect(() => {
    if (!isAdmin || loading || sweptRef.current || players.length === 0) return
    sweptRef.current = true
    const expired = players.filter((p) => {
      if (responses[p.id]) return false
      const days = daysSinceMoved(p)
      return days !== null && days >= INACTIVITY_REMOVAL_DAYS
    })
    if (expired.length === 0) return
    if (expired.length > players.length / 2) {
      console.warn(`Inactivity sweep aborted: ${expired.length}/${players.length} players look expired.`)
      return
    }
    expired.forEach(deletePlayerData)
  }, [isAdmin, loading, players, responses])

  // Nudge: highlights a Pending card with "Are you joining this week?" until
  // the player responds, the admin removes it, or the week is reset.
  async function toggleNudge(player) {
    if (!isAdmin) return
    await setDoc(
      doc(db, NUDGES_COLLECTION, CURRENT_DOC_ID),
      { [player.id]: nudges[player.id] ? deleteField() : Date.now() },
      { merge: true },
    )
  }

  async function nudgeAllPending() {
    if (!isAdmin) return
    const now = Date.now()
    const entries = Object.fromEntries(
      players.filter((p) => !responses[p.id]).map((p) => [p.id, nudges[p.id] ?? now]),
    )
    if (Object.keys(entries).length === 0) return
    await setDoc(doc(db, NUDGES_COLLECTION, CURRENT_DOC_ID), entries, { merge: true })
  }

  async function clearAllNudges() {
    if (!isAdmin) return
    await deleteDoc(doc(db, NUDGES_COLLECTION, CURRENT_DOC_ID))
  }

  // Admin flag: shows the "account will be removed in 2 weeks" notice on the
  // card regardless of column, until unflagged. Unflagging also clears the
  // separate automatic 14-day inactivity warning and restarts that
  // countdown from today — otherwise a stale player would still show the
  // auto warning right after being unflagged.
  async function toggleFlag(player) {
    if (!isAdmin) return
    await setDoc(
      doc(db, PLAYERS_COLLECTION, player.id),
      player.flagged
        ? { flagged: deleteField(), lastMovedAt: serverTimestamp() }
        : { flagged: true },
      { merge: true },
    )
  }

  function startEdit(player) {
    if (!isAdmin) return
    setEditingId(player.id)
    setEditName(player.name)
    setEditCode('')
    setEditError('')
  }

  function cancelEdit() {
    setEditingId(null)
    setEditName('')
    setEditCode('')
    setEditError('')
  }

  async function saveEdit(player) {
    if (!isAdmin) return
    const name = editName.trim()
    if (!name) {
      setEditError('Name required.')
      return
    }
    if (editCode && !/^\d{4}$/.test(editCode)) {
      setEditError('Code must be exactly 4 digits.')
      return
    }
    await setDoc(doc(db, PLAYERS_COLLECTION, player.id), { name }, { merge: true })
    if (editCode) {
      const codeHash = await sha256Hex(editCode)
      await setDoc(doc(db, CODES_COLLECTION, player.id), { codeHash })
    }
    cancelEdit()
  }

  function startTallyEdit(player) {
    if (!isAdmin) return
    const t = attendanceTally[player.id] ?? {}
    setEditingTallyId(player.id)
    setTallyPresentInput(String(t.present ?? 0))
    setTallyAbsentInput(String(t.absent ?? 0))
    setTallyPendingInput(String(t.pending ?? 0))
  }

  function cancelTallyEdit() {
    setEditingTallyId(null)
  }

  async function saveTallyEdit(player) {
    if (!isAdmin) return
    const clamp = (v) => Math.max(0, parseInt(v, 10) || 0)
    await setDoc(
      doc(db, ATTENDANCE_COLLECTION, ATTENDANCE_DOC_ID),
      {
        [player.id]: {
          present: clamp(tallyPresentInput),
          absent: clamp(tallyAbsentInput),
          pending: clamp(tallyPendingInput),
        },
      },
      { merge: true },
    )
    cancelTallyEdit()
  }

  // Bulk +1 for a whole column at once — same idempotency-free, admin-only,
  // manual-only pattern as the single-card edit above, just applied to every
  // player currently in that column (ignoring the search box, like nudge
  // all/clear all does).
  async function bumpColumnTally(bucket, columnPlayers) {
    if (!isAdmin || columnPlayers.length === 0) return
    // A dotted string key ("id.bucket") is NOT parsed as a nested path by
    // setDoc(..., {merge:true}) — it silently writes one literal field
    // named "id.bucket" instead, which is why this didn't work before.
    // A real nested object per player merges correctly and increment()
    // still resolves inside it, verified against production Firestore.
    const update = {}
    for (const p of columnPlayers) {
      update[p.id] = { [bucket]: increment(1) }
    }
    await setDoc(doc(db, ATTENDANCE_COLLECTION, ATTENDANCE_DOC_ID), update, { merge: true })
  }

  async function submitLogin(e) {
    e.preventDefault()
    try {
      await signInWithEmailAndPassword(auth, emailInput.trim(), passwordInput)
      setShowLogin(false)
      setEmailInput('')
      setPasswordInput('')
      setShowPassword(false)
      setLoginError('')
    } catch {
      setLoginError('Wrong email or password.')
    }
  }

  function logout() {
    signOut(auth)
  }

  function setResponse(id, value, docId) {
    setDoc(doc(db, RESPONSES_COLLECTION, docId), { [id]: value }, { merge: true })
    setDoc(doc(db, PAID_COLLECTION, docId), { [id]: deleteField() }, { merge: true })
  }

  function clearResponse(id, docId) {
    setDoc(doc(db, RESPONSES_COLLECTION, docId), { [id]: deleteField() }, { merge: true })
    setDoc(doc(db, PAID_COLLECTION, docId), { [id]: deleteField() }, { merge: true })
  }

  function markPaid(id, docId) {
    setDoc(doc(db, PAID_COLLECTION, docId), { [id]: true }, { merge: true })
  }

  function unpay(id, docId) {
    setDoc(doc(db, PAID_COLLECTION, docId), { [id]: deleteField() }, { merge: true })
  }

  function requestReset() {
    if (!isAdmin) return
    setShowResetConfirm(true)
  }

  // Archive whatever Current holds right now into Last Played, then clear
  // Current — so Last Played always reflects the state right before the
  // most recent reset, independent of anything done to it afterwards.
  async function confirmReset() {
    await Promise.all([
      setDoc(doc(db, RESPONSES_COLLECTION, LAST_PLAYED_DOC_ID), responses),
      setDoc(doc(db, PAID_COLLECTION, LAST_PLAYED_DOC_ID), paid),
      setDoc(doc(db, LAST_PLAYED_ROSTER_COLLECTION, LAST_PLAYED_DOC_ID), {
        players: players.map((p) => ({ id: p.id, name: p.name })),
      }),
      cost
        ? setDoc(doc(db, COSTS_COLLECTION, LAST_PLAYED_DOC_ID), cost)
        : deleteDoc(doc(db, COSTS_COLLECTION, LAST_PLAYED_DOC_ID)),
      matchInfo
        ? setDoc(doc(db, MATCH_COLLECTION, LAST_PLAYED_DOC_ID), matchInfo)
        : deleteDoc(doc(db, MATCH_COLLECTION, LAST_PLAYED_DOC_ID)),
      setDoc(doc(db, STATUS_COLLECTION, LAST_PLAYED_DOC_ID), { status: matchStatus }),
    ])
    await deleteDoc(doc(db, RESPONSES_COLLECTION, responsesDocId))
    await deleteDoc(doc(db, PAID_COLLECTION, responsesDocId))
    await deleteDoc(doc(db, MOVEMENTS_COLLECTION, responsesDocId))
    await deleteDoc(doc(db, NUDGES_COLLECTION, responsesDocId))
    setExpandedIds(new Set())
    setShowResetConfirm(false)
  }

  async function setStatus(status) {
    if (!isAdmin) return
    await setDoc(doc(db, STATUS_COLLECTION, responsesDocId), { status })
  }

  async function saveCost(e) {
    e.preventDefault()
    if (!isAdmin) return
    setCostError('')

    const totalCost = parseFloat(costTotalInput)
    const playerCount = parseInt(costPlayerCountInput, 10)
    if (!(totalCost > 0)) {
      setCostError('Enter a total cost greater than 0.')
      return
    }
    if (!(playerCount > 0)) {
      setCostError('Enter a number of players greater than 0.')
      return
    }
    if (!costDateISO) {
      setCostError('Pick a date.')
      return
    }

    const file = costImageRef.current?.files?.[0]
    let imageDataUrl = cost?.imageDataUrl ?? null
    if (file) {
      setCostSaving(true)
      try {
        imageDataUrl = await compressImage(file)
      } catch {
        setCostError('Could not read that image.')
        setCostSaving(false)
        return
      }
      if (!imageDataUrl) {
        setCostError('Image too large — try a smaller or simpler photo.')
        setCostSaving(false)
        return
      }
    } else if (!imageDataUrl) {
      setCostError('Add an image.')
      return
    }

    setCostSaving(true)
    await setDoc(doc(db, COSTS_COLLECTION, responsesDocId), {
      imageDataUrl,
      totalCost,
      playerCount,
      isoDate: costDateISO,
      ...formatDayAndDate(costDateISO),
    })
    if (costImageRef.current) costImageRef.current.value = ''
    setCostSaving(false)
  }

  async function saveMatchInfo(e) {
    e.preventDefault()
    if (!isAdmin || !matchDateISO) return
    setMatchInfoSaving(true)
    await setDoc(doc(db, MATCH_COLLECTION, responsesDocId), {
      isoDate: matchDateISO,
      ...formatDayAndDate(matchDateISO),
    })
    setMatchInfoSaving(false)
  }

  // Which doc id a move writes to depends only on which tab is open —
  // Last Played moves never touch Current's docs and vice versa.
  const activeDocId = activeTab === 'current' ? CURRENT_DOC_ID : LAST_PLAYED_DOC_ID
  const MOVE_ACTIONS = {
    in: (id) => setResponse(id, 'yes', activeDocId),
    out: (id) => setResponse(id, 'no', activeDocId),
    undo: (id) => clearResponse(id, activeDocId),
    pay: (id) => markPaid(id, activeDocId),
    unpay: (id) => unpay(id, activeDocId),
  }

  // Which column a player is in right now, and which one each action lands
  // them in — used to log "from → to" for the show-more history.
  const MOVE_TARGET = { in: 'In', out: 'Out', undo: 'Pending', pay: 'Paid', unpay: 'In' }
  function columnOf(id) {
    const r = displayResponses[id]
    if (!r) return 'Pending'
    if (r === 'no') return 'Out'
    return displayPaid[id] ? 'Paid' : 'In'
  }

  function toggleExpanded(id) {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function renderHistory(p) {
    if (activeTab !== 'current' || !expandedIds.has(p.id)) return null
    const list = movements[p.id] ?? []
    return (
      <ul className="move-history">
        {list.length === 0 ? (
          <li className="move-history-empty">No movement yet.</li>
        ) : (
          list.map((m, i) => (
            <li key={i}>
              <span className="move-path">
                {m.from} <span aria-hidden="true">→</span> {m.to}
              </span>
              <span className="move-time">
                {new Date(m.at).toLocaleString(undefined, {
                  month: 'short',
                  day: 'numeric',
                  hour: 'numeric',
                  minute: '2-digit',
                })}
              </span>
            </li>
          ))
        )}
      </ul>
    )
  }

  function renderMoreButton(p) {
    if (activeTab !== 'current') return null
    const open = expandedIds.has(p.id)
    return (
      <button
        type="button"
        className={`more-btn ${open ? 'open' : ''}`}
        aria-label={`${open ? 'Hide' : 'Show'} movement for ${p.name}`}
        aria-expanded={open}
        onClick={() => toggleExpanded(p.id)}
      >
        ▾
      </button>
    )
  }

  // Grabs the row's current position and a visual clone before the move
  // actually runs, so the card-arc effect (above) has a "from" snapshot to
  // fly from once the real row lands in its new column.
  function runMove(id, action) {
    const el = rowRefs.current.get(id)
    if (el) {
      flightsRef.current.set(id, { rect: el.getBoundingClientRect(), node: el.cloneNode(true) })
    }
    const from = columnOf(id)
    MOVE_ACTIONS[action](id)
    const to = MOVE_TARGET[action]
    if (activeDocId === CURRENT_DOC_ID && nudges[id]) {
      setDoc(doc(db, NUDGES_COLLECTION, CURRENT_DOC_ID), { [id]: deleteField() }, { merge: true })
    }
    if (activeDocId === CURRENT_DOC_ID && from !== to) {
      setDoc(
        doc(db, MOVEMENTS_COLLECTION, CURRENT_DOC_ID),
        { [id]: arrayUnion({ from, to, at: Date.now() }) },
        { merge: true },
      )
    }
    // Only actions on the live roster count toward the inactivity clock —
    // correcting a Last played record (activeDocId === LAST_PLAYED_DOC_ID)
    // is historical bookkeeping, not the player showing up this week.
    if (activeDocId === CURRENT_DOC_ID) {
      setDoc(doc(db, PLAYERS_COLLECTION, id), { lastMovedAt: serverTimestamp() }, { merge: true })
    }
  }

  async function tryRememberedMove(player, action) {
    const raw = safeStorageGet(rememberedCodeKey(player.id))
    if (!raw) return false
    let saved
    try {
      saved = JSON.parse(raw)
    } catch {
      safeStorageRemove(rememberedCodeKey(player.id))
      return false
    }
    if (saved.date !== isoDate(new Date())) {
      safeStorageRemove(rememberedCodeKey(player.id))
      return false
    }
    const codeSnap = await getDoc(doc(db, CODES_COLLECTION, player.id))
    const storedHash = codeSnap.exists() ? codeSnap.data().codeHash : null
    if (storedHash && storedHash === saved.hash) {
      runMove(player.id, action)
      return true
    }
    safeStorageRemove(rememberedCodeKey(player.id))
    return false
  }

  async function requestMove(player, action) {
    if (isAdmin) {
      runMove(player.id, action)
      return
    }
    setCheckingId(player.id)
    let handled = false
    try {
      handled = await tryRememberedMove(player, action)
    } finally {
      setCheckingId(null)
    }
    if (handled) return
    setVerifyingId(player.id)
    setVerifyAction(action)
    setCodeInput('')
    setCodeError('')
  }

  function cancelVerify() {
    setVerifyingId(null)
    setVerifyAction(null)
    setCodeInput('')
    setCodeError('')
  }

  async function handleCodeInput(player, value) {
    const digits = value.replace(/\D/g, '').slice(0, 4)
    setCodeInput(digits)
    setCodeError('')
    if (digits.length !== 4) return
    const codeSnap = await getDoc(doc(db, CODES_COLLECTION, player.id))
    const storedHash = codeSnap.exists() ? codeSnap.data().codeHash : null
    if (!storedHash) {
      setCodeError('No code assigned — ask admin.')
      return
    }
    const digitsHash = await sha256Hex(digits)
    if (digitsHash === storedHash) {
      safeStorageSet(
        rememberedCodeKey(player.id),
        JSON.stringify({ hash: storedHash, date: isoDate(new Date()) }),
      )
      runMove(player.id, verifyAction)
      cancelVerify()
    } else {
      setCodeError('Wrong code.')
      setCodeInput('')
    }
  }

  const displayPlayers = activeTab === 'current' ? players : lastPlayedRoster
  const displayResponses = activeTab === 'current' ? responses : lastPlayedResponses
  const displayPaid = activeTab === 'current' ? paid : lastPlayedPaid
  const displayCost = activeTab === 'current' ? cost : lastPlayedCost
  const displayMatchInfo = activeTab === 'current' ? matchInfo : lastPlayedMatchInfo
  const displayStatus = activeTab === 'current' ? matchStatus : lastPlayedStatus

  const visiblePlayers = displayPlayers.filter((p) =>
    p.name.toLowerCase().includes(search.trim().toLowerCase()),
  )
  const pendingPlayers = visiblePlayers.filter((p) => !displayResponses[p.id])
  const confirmedPlayers = visiblePlayers.filter((p) => displayResponses[p.id] === 'yes')
  const inPlayers = confirmedPlayers.filter((p) => !displayPaid[p.id])
  const outPlayers = visiblePlayers.filter((p) => displayResponses[p.id] === 'no')
  const paidPlayers = confirmedPlayers.filter((p) => displayPaid[p.id])

  // Unfiltered by search — column-wide tally bumps hit the whole column,
  // same as nudge all/clear all already do.
  const allConfirmedPlayers = players.filter((p) => responses[p.id] === 'yes')
  const allPendingPlayers = players.filter((p) => !responses[p.id])
  const allInPlayers = allConfirmedPlayers.filter((p) => !paid[p.id])
  const allOutPlayers = players.filter((p) => responses[p.id] === 'no')
  const allPaidPlayers = allConfirmedPlayers.filter((p) => paid[p.id])

  // Cost banner on the Current tab keeps showing last week's receipt until
  // admin uploads a new one after reset — reset already zeroed out `paid`
  // for the new week, so counting from it here would wrongly show Rs. 0
  // against a receipt that was actually for last week. When the banner's
  // date still matches Last played's, count from the Last played roster
  // instead.
  const costIsFromLastPlayed =
    activeTab === 'current' &&
    displayCost &&
    lastPlayedCost &&
    displayCost.day === lastPlayedCost.day &&
    displayCost.date === lastPlayedCost.date
  const costPaidCount = costIsFromLastPlayed
    ? lastPlayedRoster.filter((p) => lastPlayedPaid[p.id]).length
    : paidPlayers.length

  // Only Pending — a player who has moved to In/Out/Paid has, by
  // definition, moved. Last played rows share this shape but never carry
  // lastMovedAt, so daysSinceMoved is naturally null there and no warning
  // shows — no activeTab check needed.
  function isStalePending(p) {
    if (displayResponses[p.id]) return false // In or Out already — not pending
    const days = daysSinceMoved(p)
    return days !== null && days >= INACTIVITY_WARNING_DAYS
  }

  // Nudges only apply to Pending players on the live roster.
  function isNudged(p) {
    return activeTab === 'current' && !displayResponses[p.id] && !!nudges[p.id]
  }

  function rowClassName(p) {
    return `player-row${p.flagged || isStalePending(p) ? ' stale' : ''}${isNudged(p) ? ' nudged' : ''}`
  }

  function renderTally(p) {
    if (activeTab !== 'current') return null

    if (editingTallyId === p.id) {
      return (
        <form
          className="tally-edit-form"
          onSubmit={(e) => {
            e.preventDefault()
            saveTallyEdit(p)
          }}
        >
          <label>
            Present
            <input
              type="number"
              min="0"
              value={tallyPresentInput}
              onChange={(e) => setTallyPresentInput(e.target.value)}
            />
          </label>
          <label>
            Absent
            <input
              type="number"
              min="0"
              value={tallyAbsentInput}
              onChange={(e) => setTallyAbsentInput(e.target.value)}
            />
          </label>
          <label>
            Pending
            <input
              type="number"
              min="0"
              value={tallyPendingInput}
              onChange={(e) => setTallyPendingInput(e.target.value)}
            />
          </label>
          <button type="submit" className="link-btn">
            Save
          </button>
          <button type="button" className="link-btn" onClick={cancelTallyEdit}>
            Cancel
          </button>
        </form>
      )
    }

    const t = attendanceTally[p.id]
    const present = t?.present ?? 0
    const absent = t?.absent ?? 0
    const pending = t?.pending ?? 0
    // Tally marks, not a proportional bar or numbers — color alone tells
    // present (green) from absent (red) from pending (blue). Always
    // visible, even at 0/0/0, so the label and (for admin) the edit
    // control are always there.
    const marks = (count, cls) =>
      count > 0 && (
        <span className="tally-group">
          {Array.from({ length: count }, (_, i) => (
            <span key={i} className={`tally-mark ${cls}`} />
          ))}
        </span>
      )
    return (
      <div className="tally-row">
        <span className="tally-label">Attendance history</span>
        <div className="tally-marks">
          {marks(present, 'tally-present')}
          {marks(absent, 'tally-absent')}
          {marks(pending, 'tally-pending')}
        </div>
        {isAdmin && (
          <button type="button" className="link-btn tally-edit-btn" onClick={() => startTallyEdit(p)}>
            Edit tally
          </button>
        )}
      </div>
    )
  }

  function renderNudge(p) {
    if (!isNudged(p)) return null
    return (
      <p className="nudge-note">
        <span className="nudge-wave" aria-hidden="true">
          👋
        </span>{' '}
        Are you joining this week?
      </p>
    )
  }

  function renderStaleWarning(p) {
    if (p.flagged) {
      return <p className="stale-warning">
          You are not even RSVPing, let alone participating. Your account will be deleted in 2 weeks
          if this continues!
        </p>
    }
    if (!isStalePending(p)) return null
    const days = daysSinceMoved(p)
    return (
      <p className="stale-warning">
        You haven't shown any movement for {days} day{days === 1 ? '' : 's'}. After{' '}
        {INACTIVITY_REMOVAL_DAYS / 7} weeks your account would be removed.
      </p>
    )
  }

  function renderVerifyForm(p) {
    return (
      <div className="verify-form">
        <input
          type="text"
          inputMode="numeric"
          className={`code-input ${codeError ? 'error' : ''}`}
          placeholder="Code"
          value={codeInput}
          onChange={(e) => handleCodeInput(p, e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && cancelVerify()}
          autoFocus
        />
        {codeError && <span className="code-error">{codeError}</span>}
        <button type="button" className="link-btn" aria-label="Cancel" onClick={cancelVerify}>
          ×
        </button>
      </div>
    )
  }

  function renderEditForm(p) {
    return (
      <form
        className="edit-form"
        onSubmit={(e) => {
          e.preventDefault()
          saveEdit(p)
        }}
      >
        <input
          type="text"
          className="edit-name-input"
          value={editName}
          onChange={(e) => setEditName(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && cancelEdit()}
          autoFocus
        />
        <input
          type="text"
          inputMode="numeric"
          className="edit-code-input"
          placeholder="New code"
          value={editCode}
          onChange={(e) => setEditCode(e.target.value.replace(/\D/g, '').slice(0, 4))}
        />
        <button type="submit" className="link-btn">
          Save
        </button>
        <button type="button" className="link-btn" aria-label="Cancel" onClick={cancelEdit}>
          ×
        </button>
        {editError && <span className="code-error">{editError}</span>}
      </form>
    )
  }

  function renderRow(p) {
    const status = displayResponses[p.id]
    const isVerifying = verifyingId === p.id
    const isChecking = checkingId === p.id
    const isEditing = editingId === p.id
    return (
      <li key={p.id} ref={setRowRef(p.id)} className={rowClassName(p)}>
        <span className="player-name">{p.name}</span>
        {isChecking ? (
          <span className="checking">Checking…</span>
        ) : isEditing ? (
          renderEditForm(p)
        ) : isVerifying ? (
          renderVerifyForm(p)
        ) : (
          <div className="actions">
            <button
              type="button"
              className={`choice yes ${status === 'yes' ? 'active' : ''}`}
              onClick={() => requestMove(p, 'in')}
            >
              In
            </button>
            <button
              type="button"
              className={`choice no ${status === 'no' ? 'active' : ''}`}
              onClick={() => requestMove(p, 'out')}
            >
              Out
            </button>
            {status === 'yes' && (
              <button type="button" className="pay" onClick={() => requestMove(p, 'pay')}>
                Pay
              </button>
            )}
            {status && (
              <button
                type="button"
                className="undo"
                aria-label={`Move ${p.name} back to pending`}
                onClick={() => requestMove(p, 'undo')}
              >
                ↺
              </button>
            )}
            {isAdmin && activeTab === 'current' && !status && (
              <button
                type="button"
                className={`edit nudge-btn ${nudges[p.id] ? 'active' : ''}`}
                aria-label={`${nudges[p.id] ? 'Remove nudge for' : 'Nudge'} ${p.name}`}
                onClick={() => toggleNudge(p)}
              >
                {nudges[p.id] ? 'Un-nudge' : 'Nudge'}
              </button>
            )}
            {isAdmin && activeTab === 'current' && (
              <button
                type="button"
                className="edit"
                aria-label={`${p.flagged ? 'Unflag' : 'Flag'} ${p.name}`}
                onClick={() => toggleFlag(p)}
              >
                {p.flagged ? 'Unflag' : 'Flag'}
              </button>
            )}
            {isAdmin && activeTab === 'current' && (
              <button
                type="button"
                className="edit"
                aria-label={`Edit ${p.name}`}
                onClick={() => startEdit(p)}
              >
                Edit
              </button>
            )}
            {isAdmin && activeTab === 'current' && (
              <button
                type="button"
                className="remove"
                aria-label={`Remove ${p.name}`}
                onClick={() => removePlayer(p)}
              >
                ×
              </button>
            )}
            {renderMoreButton(p)}
          </div>
        )}
        {renderTally(p)}
        {renderNudge(p)}
        {renderStaleWarning(p)}
        {renderHistory(p)}
      </li>
    )
  }

  function renderPaidRow(p) {
    const isVerifying = verifyingId === p.id
    const isChecking = checkingId === p.id
    const isEditing = editingId === p.id
    return (
      <li key={p.id} ref={setRowRef(p.id)} className={rowClassName(p)}>
        <span className="player-name">{p.name}</span>
        {isChecking ? (
          <span className="checking">Checking…</span>
        ) : isEditing ? (
          renderEditForm(p)
        ) : isVerifying ? (
          renderVerifyForm(p)
        ) : (
          <div className="actions">
            <button
              type="button"
              className="undo"
              aria-label={`Move ${p.name} back to In (unpaid)`}
              onClick={() => requestMove(p, 'unpay')}
            >
              ↺
            </button>
            {isAdmin && activeTab === 'current' && (
              <button
                type="button"
                className="edit"
                aria-label={`${p.flagged ? 'Unflag' : 'Flag'} ${p.name}`}
                onClick={() => toggleFlag(p)}
              >
                {p.flagged ? 'Unflag' : 'Flag'}
              </button>
            )}
            {isAdmin && activeTab === 'current' && (
              <button
                type="button"
                className="edit"
                aria-label={`Edit ${p.name}`}
                onClick={() => startEdit(p)}
              >
                Edit
              </button>
            )}
            {isAdmin && activeTab === 'current' && (
              <button
                type="button"
                className="remove"
                aria-label={`Remove ${p.name}`}
                onClick={() => removePlayer(p)}
              >
                ×
              </button>
            )}
            {renderMoreButton(p)}
          </div>
        )}
        {renderTally(p)}
        {renderNudge(p)}
        {renderStaleWarning(p)}
        {renderHistory(p)}
      </li>
    )
  }

  return (
    <div className="page">
      <div className="ball-layer" ref={ballLayerRef} />
      <div className="admin-bar">
        {isAdmin ? (
          <>
            <span className="admin-badge">Admin mode</span>
            <button type="button" className="link-btn reset-all" onClick={requestReset}>
              Reset all to Pending
            </button>
            <button type="button" className="link-btn" onClick={logout}>
              Log out
            </button>
          </>
        ) : showLogin ? (
          <form className="login-form" onSubmit={submitLogin}>
            <input
              type="email"
              placeholder="Admin email"
              value={emailInput}
              onChange={(e) => setEmailInput(e.target.value)}
              autoComplete="username"
              autoFocus
            />
            <span className="password-field">
              <input
                type={showPassword ? 'text' : 'password'}
                placeholder="Admin password"
                value={passwordInput}
                onChange={(e) => setPasswordInput(e.target.value)}
                autoComplete="current-password"
              />
              <button
                type="button"
                className="link-btn password-toggle"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? 'Hide' : 'Show'}
              </button>
            </span>
            <button type="submit">Unlock</button>
            <button
              type="button"
              className="link-btn"
              onClick={() => {
                setShowLogin(false)
                setLoginError('')
                setEmailInput('')
                setPasswordInput('')
                setShowPassword(false)
              }}
            >
              Cancel
            </button>
            {loginError && <span className="login-error">{loginError}</span>}
          </form>
        ) : (
          <button type="button" className="link-btn" onClick={() => setShowLogin(true)}>
            Admin login
          </button>
        )}
      </div>

      <div className="tabs">
        <button
          type="button"
          className={`tab ${activeTab === 'current' ? 'active' : ''}`}
          onClick={() => setActiveTab('current')}
        >
          Current
        </button>
        <button
          type="button"
          className={`tab ${activeTab === 'last' ? 'active' : ''}`}
          onClick={() => setActiveTab('last')}
        >
          Last played
        </button>
      </div>

      {activeTab === 'current' ? (
        <header className="header">
          <h1>Office Futsal</h1>
          <p className="subtitle subtitle-hero">
            {matchInfo?.day && matchInfo?.date
              ? `Who's in for ${matchInfo.day}, ${matchInfo.date}?`
              : "Who's in?"}
          </p>
          {isAdmin && (
            <form className="match-info-form" onSubmit={saveMatchInfo}>
              <input
                type="date"
                value={matchDateISO}
                onChange={(e) => setMatchDateISO(e.target.value)}
              />
              <button type="submit" disabled={matchInfoSaving || !matchDateISO}>
                {matchInfoSaving ? 'Saving…' : 'Save'}
              </button>
            </form>
          )}
        </header>
      ) : (
        <header className="header">
          <h1>Office Futsal</h1>
          <p className="subtitle">
            {lastPlayedMatchInfo?.day && lastPlayedMatchInfo?.date
              ? `Last played: ${lastPlayedMatchInfo.day}, ${lastPlayedMatchInfo.date}`
              : 'No archived match yet.'}
          </p>
        </header>
      )}

      <div className="top-panels">
        {displayCost && (
          <section className="cost-banner">
            <h2 className="cost-banner-title">
              {displayCost.day && displayCost.date
                ? `Payment for ${displayCost.day}, ${displayCost.date}`
                : 'Payment for'}
            </h2>
            <div className="cost-body">
              <img
                src={displayCost.imageDataUrl}
                alt="Cost receipt"
                className="cost-thumb"
                onClick={() => setImageExpanded(true)}
              />
              <div className="cost-details">
                <div className="cost-row">
                  <span>Total cost</span>
                  <strong>{formatMoney(displayCost.totalCost)}</strong>
                </div>
                <div className="cost-row">
                  <span>Players</span>
                  <strong>{displayCost.playerCount}</strong>
                </div>
                <div className="cost-share">
                  <span>Each's share</span>
                  <strong>{formatMoney(displayCost.totalCost / displayCost.playerCount)}</strong>
                </div>
                <div
                  className={`cost-share cost-payments ${
                    costPaidCount >= displayCost.playerCount ? 'complete' : 'pending'
                  }`}
                >
                  <span>Payments collected</span>
                  <strong>
                    {costPaidCount >= displayCost.playerCount ? (
                      'Fully Paid'
                    ) : (
                      <>
                        {costPaidCount} &times; {formatMoney(displayCost.totalCost / displayCost.playerCount)} ={' '}
                        {formatMoney((displayCost.totalCost / displayCost.playerCount) * costPaidCount)}
                      </>
                    )}
                  </strong>
                </div>
              </div>
            </div>
          </section>
        )}
      </div>

      {imageExpanded && displayCost && (
        <div className="lightbox" onClick={() => setImageExpanded(false)}>
          <img src={displayCost.imageDataUrl} alt="Cost receipt, full size" />
        </div>
      )}

      {showResetConfirm && (
        <div className="lightbox" onClick={() => setShowResetConfirm(false)}>
          <div className="confirm-modal" onClick={(e) => e.stopPropagation()}>
            <p>
              Move every player back to Pending? This week's roster, payment info, and images will
              be saved to "Last played" first, then In/Out/Paid will be cleared for the new week.
            </p>
            <div className="confirm-modal-actions">
              <button type="button" className="confirm-cancel" onClick={() => setShowResetConfirm(false)}>
                Cancel
              </button>
              <button type="button" className="confirm-danger" onClick={confirmReset}>
                Reset all
              </button>
            </div>
          </div>
        </div>
      )}

      {isAdmin && activeTab === 'current' && (
        <form className="cost-form" onSubmit={saveCost}>
          <h3 className="cost-form-title">Cost breakdown</h3>
          <div className="cost-form-row">
            <input type="file" accept="image/*" ref={costImageRef} />
            <input
              type="number"
              min="0"
              step="0.01"
              placeholder="Total cost"
              value={costTotalInput}
              onChange={(e) => setCostTotalInput(e.target.value)}
            />
            <input
              type="number"
              min="1"
              step="1"
              placeholder="No. of players"
              value={costPlayerCountInput}
              onChange={(e) => setCostPlayerCountInput(e.target.value)}
            />
            <input
              type="date"
              value={costDateISO}
              onChange={(e) => setCostDateISO(e.target.value)}
            />
            <button type="submit" disabled={costSaving}>
              {costSaving ? 'Saving…' : cost ? 'Update' : 'Save'}
            </button>
          </div>
          {costError && <span className="login-error">{costError}</span>}
        </form>
      )}

      {isAdmin && activeTab === 'current' && (
        <form className="add-form" onSubmit={addPlayer}>
          <input
            type="text"
            placeholder="Add a player"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
          <input
            type="text"
            inputMode="numeric"
            placeholder="4-digit code"
            className="add-code-input"
            value={newCode}
            onChange={(e) => setNewCode(e.target.value.replace(/\D/g, '').slice(0, 4))}
          />
          <button type="submit">Add</button>
          {addError && <span className="login-error">{addError}</span>}
        </form>
      )}

      {isAdmin && activeTab === 'last' && (
        <form className="add-form" onSubmit={addGuestToLastPlayed}>
          <input
            type="text"
            placeholder="Add a guest to Last played"
            value={guestName}
            onChange={(e) => setGuestName(e.target.value)}
          />
          <button type="submit">Add</button>
          {guestError && <span className="login-error">{guestError}</span>}
        </form>
      )}

      <div className="search-row">
        {displayPlayers.length > 0 && (
          <input
            type="search"
            className="search-input"
            placeholder="Search players…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        )}
        {displayStatus && (
          <div className="status-block">
            {displayMatchInfo?.day && displayMatchInfo?.date && (
              <p className="status-date">
                {displayMatchInfo.day}, {displayMatchInfo.date}
              </p>
            )}
            <div className="status-inline">
              <span className="status-inline-title">Futsal Status:</span>
              <span className={`status-badge status-${displayStatus}`}>{STATUS_LABELS[displayStatus]}</span>
              {isAdmin && activeTab === 'current' && (
                <div className="status-admin-actions">
                  {Object.keys(STATUS_LABELS).map((key) => (
                    <button
                      key={key}
                      type="button"
                      className={`choice status-choice-${key} ${matchStatus === key ? 'active' : ''}`}
                      onClick={() => setStatus(key)}
                    >
                      {STATUS_LABELS[key]}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {activeTab === 'current' && loading ? (
        <p className="empty">Loading players…</p>
      ) : displayPlayers.length === 0 ? (
        <p className="empty">
          {activeTab === 'current' ? 'No players yet. Add one above.' : 'No match played yet.'}
        </p>
      ) : visiblePlayers.length === 0 ? (
        <p className="empty">No players match "{search}".</p>
      ) : (
        <div className="board">
          <section className="column">
            <h2 className="column-title pending">
              Pending <span className="count">{pendingPlayers.length}</span>
              {isAdmin && activeTab === 'current' && (
                <span className="column-actions">
                  <button type="button" className="link-btn" onClick={nudgeAllPending}>
                    Nudge all
                  </button>
                  {Object.keys(nudges).length > 0 && (
                    <button type="button" className="link-btn" onClick={clearAllNudges}>
                      Clear nudges
                    </button>
                  )}
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => bumpColumnTally('pending', allPendingPlayers)}
                  >
                    +1 tally, whole column
                  </button>
                </span>
              )}
            </h2>
            <ul className="player-list">
              {pendingPlayers.length === 0 ? (
                <li className="column-empty">Everyone has responded.</li>
              ) : (
                pendingPlayers.map(renderRow)
              )}
            </ul>
          </section>

          <section className="column">
            <h2 className="column-title in">
              In <span className="count">{inPlayers.length}</span>
              {isAdmin && activeTab === 'current' && (
                <span className="column-actions">
                  <button type="button" className="link-btn" onClick={() => bumpColumnTally('present', allInPlayers)}>
                    +1 tally, whole column
                  </button>
                </span>
              )}
            </h2>
            <ul className="player-list">
              {inPlayers.length === 0 ? (
                <li className="column-empty">No one yet.</li>
              ) : (
                inPlayers.map(renderRow)
              )}
            </ul>
          </section>

          <section className="column">
            <h2 className="column-title out">
              Out <span className="count">{outPlayers.length}</span>
              {isAdmin && activeTab === 'current' && (
                <span className="column-actions">
                  <button type="button" className="link-btn" onClick={() => bumpColumnTally('absent', allOutPlayers)}>
                    +1 tally, whole column
                  </button>
                </span>
              )}
            </h2>
            <ul className="player-list">
              {outPlayers.length === 0 ? (
                <li className="column-empty">No one yet.</li>
              ) : (
                outPlayers.map(renderRow)
              )}
            </ul>
          </section>

          <section className="column">
            <h2 className="column-title paid">
              Paid <span className="count">{paidPlayers.length}</span>
              {isAdmin && activeTab === 'current' && (
                <span className="column-actions">
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => bumpColumnTally('present', allPaidPlayers)}
                  >
                    +1 tally, whole column
                  </button>
                </span>
              )}
            </h2>
            <ul className="player-list">
              {paidPlayers.length === 0 ? (
                <li className="column-empty">No one yet.</li>
              ) : (
                paidPlayers.map(renderPaidRow)
              )}
            </ul>
          </section>
        </div>
      )}
    </div>
  )
}

export default App
