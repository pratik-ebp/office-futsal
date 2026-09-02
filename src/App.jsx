import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  collection,
  deleteDoc,
  deleteField,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  serverTimestamp,
  setDoc,
  writeBatch,
} from 'firebase/firestore'
import { db } from './firebase'
import { ROSTER } from './data/roster'
import './App.css'

const ADMIN_SESSION_KEY = 'thursday-players:isAdmin'
const REMEMBERED_CODE_PREFIX = 'thursday-players:code:'
const rememberedCodeKey = (id) => `${REMEMBERED_CODE_PREFIX}${id}`
const ADMIN_PASSWORD_HASH = import.meta.env.VITE_ADMIN_PASSWORD_HASH

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

// One-time (per empty database) seed from the roster file. Safe to call on
// every load — it's a no-op once any player doc exists. Seeded players get
// no code; run scripts/assign-codes.mjs afterward to assign them (writes to
// the separate playerCodes collection, never to /players itself).
async function ensureSeeded() {
  const snap = await getDocs(collection(db, PLAYERS_COLLECTION))
  if (!snap.empty) return
  const batch = writeBatch(db)
  for (const name of ROSTER) {
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
  const [matchDayInput, setMatchDayInput] = useState('')
  const [matchDateInput, setMatchDateInput] = useState('')
  const [matchInfoSaving, setMatchInfoSaving] = useState(false)
  const [loading, setLoading] = useState(true)

  // Last played: a frozen-at-archive-time mirror of the same shape, kept
  // live-subscribed (not just loaded on tab switch) so payment moves made
  // here while viewing this tab update immediately, same as Current.
  const [lastPlayedRoster, setLastPlayedRoster] = useState([])
  const [lastPlayedResponses, setLastPlayedResponses] = useState({})
  const [lastPlayedPaid, setLastPlayedPaid] = useState({})
  const [lastPlayedCost, setLastPlayedCost] = useState(null)
  const [lastPlayedMatchInfo, setLastPlayedMatchInfo] = useState(null)
  const [lastPlayedStatus, setLastPlayedStatus] = useState(null)
  const [newName, setNewName] = useState('')
  const [newCode, setNewCode] = useState('')
  const [addError, setAddError] = useState('')
  const [search, setSearch] = useState('')

  const costImageRef = useRef(null)
  const [costTotalInput, setCostTotalInput] = useState('')
  const [costPlayerCountInput, setCostPlayerCountInput] = useState('')
  const [costDayInput, setCostDayInput] = useState('')
  const [costDateInput, setCostDateInput] = useState('')
  const [costError, setCostError] = useState('')
  const [costSaving, setCostSaving] = useState(false)
  const [imageExpanded, setImageExpanded] = useState(false)
  const [showResetConfirm, setShowResetConfirm] = useState(false)

  const [isAdmin, setIsAdmin] = useState(
    () => sessionStorage.getItem(ADMIN_SESSION_KEY) === 'true',
  )
  const [showLogin, setShowLogin] = useState(false)
  const [passwordInput, setPasswordInput] = useState('')
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
    ensureSeeded().then(backfillLastMovedAt)
    const unsubscribe = onSnapshot(collection(db, PLAYERS_COLLECTION), (snap) => {
      const list = snap.docs.map((d) => ({ id: d.id, name: d.data().name, lastMovedAt: d.data().lastMovedAt ?? null }))
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
  useEffect(() => {
    if (cost && costTotalInput === '' && costPlayerCountInput === '') {
      setCostTotalInput(String(cost.totalCost))
      setCostPlayerCountInput(String(cost.playerCount))
      setCostDayInput(cost.day ?? '')
      setCostDateInput(cost.date ?? '')
    }
  }, [cost])

  // Same idea for the match day/date fields.
  useEffect(() => {
    if (matchInfo && matchDayInput === '' && matchDateInput === '') {
      setMatchDayInput(matchInfo.day ?? '')
      setMatchDateInput(matchInfo.date ?? '')
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

  async function removePlayer(player) {
    if (!isAdmin) return
    if (!confirm(`Remove ${player.name}? This deletes their code and this week's response too.`)) return
    const id = player.id
    await deleteDoc(doc(db, PLAYERS_COLLECTION, id))
    await deleteDoc(doc(db, CODES_COLLECTION, id))
    await setDoc(
      doc(db, RESPONSES_COLLECTION, responsesDocId),
      { [id]: deleteField() },
      { merge: true },
    )
    await setDoc(doc(db, PAID_COLLECTION, responsesDocId), { [id]: deleteField() }, { merge: true })
  }

  async function submitLogin(e) {
    e.preventDefault()
    if (!ADMIN_PASSWORD_HASH) {
      setLoginError('No admin password configured (set VITE_ADMIN_PASSWORD_HASH).')
      return
    }
    const hash = await sha256Hex(passwordInput)
    if (hash === ADMIN_PASSWORD_HASH) {
      sessionStorage.setItem(ADMIN_SESSION_KEY, 'true')
      setIsAdmin(true)
      setShowLogin(false)
      setPasswordInput('')
      setLoginError('')
    } else {
      setLoginError('Wrong password.')
    }
  }

  function logout() {
    sessionStorage.removeItem(ADMIN_SESSION_KEY)
    setIsAdmin(false)
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
      day: costDayInput.trim(),
      date: costDateInput.trim(),
    })
    if (costImageRef.current) costImageRef.current.value = ''
    setCostSaving(false)
  }

  async function saveMatchInfo(e) {
    e.preventDefault()
    if (!isAdmin) return
    setMatchInfoSaving(true)
    await setDoc(doc(db, MATCH_COLLECTION, responsesDocId), {
      day: matchDayInput.trim(),
      date: matchDateInput.trim(),
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

  // Grabs the row's current position and a visual clone before the move
  // actually runs, so the card-arc effect (above) has a "from" snapshot to
  // fly from once the real row lands in its new column.
  function runMove(id, action) {
    const el = rowRefs.current.get(id)
    if (el) {
      flightsRef.current.set(id, { rect: el.getBoundingClientRect(), node: el.cloneNode(true) })
    }
    MOVE_ACTIONS[action](id)
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
  const displayStatus = activeTab === 'current' ? matchStatus : lastPlayedStatus

  const visiblePlayers = displayPlayers.filter((p) =>
    p.name.toLowerCase().includes(search.trim().toLowerCase()),
  )
  const pendingPlayers = visiblePlayers.filter((p) => !displayResponses[p.id])
  const confirmedPlayers = visiblePlayers.filter((p) => displayResponses[p.id] === 'yes')
  const inPlayers = confirmedPlayers.filter((p) => !displayPaid[p.id])
  const outPlayers = visiblePlayers.filter((p) => displayResponses[p.id] === 'no')
  const paidPlayers = confirmedPlayers.filter((p) => displayPaid[p.id])

  // Last played rows share this shape but never carry lastMovedAt, so
  // daysSinceMoved is naturally null there and no warning shows — no
  // activeTab check needed.
  function rowClassName(p) {
    const days = daysSinceMoved(p)
    const stale = days !== null && days >= INACTIVITY_WARNING_DAYS
    return `player-row${stale ? ' stale' : ''}`
  }

  function renderStaleWarning(p) {
    const days = daysSinceMoved(p)
    if (days === null || days < INACTIVITY_WARNING_DAYS) return null
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

  function renderRow(p) {
    const status = displayResponses[p.id]
    const isVerifying = verifyingId === p.id
    const isChecking = checkingId === p.id
    return (
      <li key={p.id} ref={setRowRef(p.id)} className={rowClassName(p)}>
        <span className="player-name">{p.name}</span>
        {isChecking ? (
          <span className="checking">Checking…</span>
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
          </div>
        )}
        {renderStaleWarning(p)}
      </li>
    )
  }

  function renderPaidRow(p) {
    const isVerifying = verifyingId === p.id
    const isChecking = checkingId === p.id
    return (
      <li key={p.id} ref={setRowRef(p.id)} className={rowClassName(p)}>
        <span className="player-name">{p.name}</span>
        {isChecking ? (
          <span className="checking">Checking…</span>
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
                className="remove"
                aria-label={`Remove ${p.name}`}
                onClick={() => removePlayer(p)}
              >
                ×
              </button>
            )}
          </div>
        )}
        {renderStaleWarning(p)}
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
              type="password"
              placeholder="Admin password"
              value={passwordInput}
              onChange={(e) => setPasswordInput(e.target.value)}
              autoFocus
            />
            <button type="submit">Unlock</button>
            <button
              type="button"
              className="link-btn"
              onClick={() => {
                setShowLogin(false)
                setLoginError('')
                setPasswordInput('')
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
                type="text"
                placeholder="Day (e.g. Thursday)"
                value={matchDayInput}
                onChange={(e) => setMatchDayInput(e.target.value)}
              />
              <input
                type="text"
                placeholder="Date (e.g. September 3)"
                value={matchDateInput}
                onChange={(e) => setMatchDateInput(e.target.value)}
              />
              <button type="submit" disabled={matchInfoSaving}>
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
              type="text"
              placeholder="Day (e.g. Thursday)"
              value={costDayInput}
              onChange={(e) => setCostDayInput(e.target.value)}
            />
            <input
              type="text"
              placeholder="Date (e.g. August 27)"
              value={costDateInput}
              onChange={(e) => setCostDateInput(e.target.value)}
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
