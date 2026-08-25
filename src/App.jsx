import { useEffect, useMemo, useRef, useState } from 'react'
import {
  collection,
  deleteDoc,
  deleteField,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
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
const STATUS_LABELS = {
  counting: 'Counting players',
  booked: 'Booked',
  cancelled: 'Cancelled',
}
// Firestore docs cap out at 1 MiB; leave headroom for the other fields on
// the doc and base64's ~33% size overhead over the raw image bytes.
const MAX_IMAGE_DATA_URL_LENGTH = 700_000

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

// Always the next upcoming Thursday (today if today is Thursday) — never a
// date that's already passed. Since this is a fresh Firestore doc key, the
// board goes blank the moment the previous Thursday passes, well ahead of
// the following week's game.
function getCycleThursday() {
  const now = new Date()
  const day = now.getDay() // 0 = Sun ... 4 = Thu
  const diff = (4 - day + 7) % 7
  const thursday = new Date(now)
  thursday.setDate(now.getDate() + diff)
  thursday.setHours(0, 0, 0, 0)
  return thursday
}

function isoDate(date) {
  return date.toISOString().slice(0, 10)
}

function formatDate(date) {
  return date.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  })
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
    batch.set(doc(db, PLAYERS_COLLECTION, slugify(name)), { name })
  }
  await batch.commit()
}

function App() {
  const thursday = useMemo(() => getCycleThursday(), [])
  const responsesDocId = isoDate(thursday)

  const [players, setPlayers] = useState([])
  const [responses, setResponses] = useState({})
  const [paid, setPaid] = useState({})
  const [cost, setCost] = useState(null)
  const [matchStatus, setMatchStatus] = useState('counting')
  const [loading, setLoading] = useState(true)
  const [newName, setNewName] = useState('')
  const [newCode, setNewCode] = useState('')
  const [addError, setAddError] = useState('')
  const [search, setSearch] = useState('')

  const costImageRef = useRef(null)
  const [costTotalInput, setCostTotalInput] = useState('')
  const [costPlayerCountInput, setCostPlayerCountInput] = useState('')
  const [costError, setCostError] = useState('')
  const [costSaving, setCostSaving] = useState(false)
  const [imageExpanded, setImageExpanded] = useState(false)

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
    ensureSeeded()
    const unsubscribe = onSnapshot(collection(db, PLAYERS_COLLECTION), (snap) => {
      const list = snap.docs.map((d) => ({ id: d.id, name: d.data().name }))
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

  // Fires after responses/paid change and the board has re-rendered rows
  // into their new columns. For every move captured by runMove(), the old
  // rect was grabbed at click time; now grab the landed rect and play the
  // arc between them.
  useEffect(() => {
    if (flightsRef.current.size === 0) return
    const pending = Array.from(flightsRef.current.entries())
    flightsRef.current.clear()
    for (const [id, fromRect] of pending) {
      const el = rowRefs.current.get(id)
      if (!el) continue
      animateBall(fromRect, el)
    }
  }, [responses, paid])

  function animateBall(fromRect, toEl) {
    const layer = ballLayerRef.current
    if (!layer) return
    const toRect = toEl.getBoundingClientRect()
    const startX = fromRect.left + fromRect.width / 2
    const startY = fromRect.top + fromRect.height / 2
    const endX = toRect.left + toRect.width / 2
    const endY = toRect.top + toRect.height / 2
    const dist = Math.hypot(endX - startX, endY - startY)
    if (dist < 4) return // same spot — nothing to animate

    const arcHeight = Math.min(140, Math.max(50, dist * 0.3))
    const midX = (startX + endX) / 2
    const midY = (startY + endY) / 2 - arcHeight
    const duration = Math.min(900, Math.max(420, dist * 1.1))
    const spins = Math.max(1, Math.round(dist / 140)) * 360

    const ball = document.createElement('div')
    ball.className = 'flying-ball'
    ball.textContent = '⚽'
    layer.appendChild(ball)

    const steps = 24
    const keyframes = []
    for (let i = 0; i <= steps; i++) {
      const t = i / steps
      const x = (1 - t) ** 2 * startX + 2 * (1 - t) * t * midX + t ** 2 * endX
      const y = (1 - t) ** 2 * startY + 2 * (1 - t) * t * midY + t ** 2 * endY
      const scale = 1 + Math.sin(Math.PI * t) * 0.15
      keyframes.push({
        transform: `translate(${x}px, ${y}px) translate(-50%, -50%) rotate(${spins * t}deg) scale(${scale})`,
        offset: t,
      })
    }

    const anim = ball.animate(keyframes, { duration, easing: 'linear', fill: 'forwards' })
    const finish = () => {
      ball.remove()
      toEl.classList.add('ball-landed')
      setTimeout(() => toEl.classList.remove('ball-landed'), 500)
    }
    anim.onfinish = finish
    anim.oncancel = finish
  }

  // Prefill the admin edit fields once, when this week's cost doc first
  // loads — but only if the admin hasn't started typing into them yet.
  useEffect(() => {
    if (cost && costTotalInput === '' && costPlayerCountInput === '') {
      setCostTotalInput(String(cost.totalCost))
      setCostPlayerCountInput(String(cost.playerCount))
    }
  }, [cost])

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
    await setDoc(doc(db, PLAYERS_COLLECTION, id), { name })
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

  function setResponse(id, value) {
    setDoc(doc(db, RESPONSES_COLLECTION, responsesDocId), { [id]: value }, { merge: true })
    setDoc(doc(db, PAID_COLLECTION, responsesDocId), { [id]: deleteField() }, { merge: true })
  }

  function clearResponse(id) {
    setDoc(doc(db, RESPONSES_COLLECTION, responsesDocId), { [id]: deleteField() }, { merge: true })
    setDoc(doc(db, PAID_COLLECTION, responsesDocId), { [id]: deleteField() }, { merge: true })
  }

  function markPaid(id) {
    setDoc(doc(db, PAID_COLLECTION, responsesDocId), { [id]: true }, { merge: true })
  }

  function unpay(id) {
    setDoc(doc(db, PAID_COLLECTION, responsesDocId), { [id]: deleteField() }, { merge: true })
  }

  async function resetAll() {
    if (!isAdmin) return
    if (!confirm('Move every player back to Pending? This clears In/Out/Paid for this week.')) return
    await deleteDoc(doc(db, RESPONSES_COLLECTION, responsesDocId))
    await deleteDoc(doc(db, PAID_COLLECTION, responsesDocId))
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
    await setDoc(doc(db, COSTS_COLLECTION, responsesDocId), { imageDataUrl, totalCost, playerCount })
    if (costImageRef.current) costImageRef.current.value = ''
    setCostSaving(false)
  }

  const MOVE_ACTIONS = {
    in: (id) => setResponse(id, 'yes'),
    out: (id) => setResponse(id, 'no'),
    undo: (id) => clearResponse(id),
    pay: (id) => markPaid(id),
    unpay: (id) => unpay(id),
  }

  // Grabs the row's current position before the move actually runs, so the
  // ball-arc effect (above) has a "from" rect to animate away from once the
  // row lands in its new column.
  function runMove(id, action) {
    const el = rowRefs.current.get(id)
    if (el) flightsRef.current.set(id, el.getBoundingClientRect())
    MOVE_ACTIONS[action](id)
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

  const visiblePlayers = players.filter((p) =>
    p.name.toLowerCase().includes(search.trim().toLowerCase()),
  )
  const pendingPlayers = visiblePlayers.filter((p) => !responses[p.id])
  const confirmedPlayers = visiblePlayers.filter((p) => responses[p.id] === 'yes')
  const inPlayers = confirmedPlayers.filter((p) => !paid[p.id])
  const outPlayers = visiblePlayers.filter((p) => responses[p.id] === 'no')
  const paidPlayers = confirmedPlayers.filter((p) => paid[p.id])

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
    const status = responses[p.id]
    const isVerifying = verifyingId === p.id
    const isChecking = checkingId === p.id
    return (
      <li key={p.id} ref={setRowRef(p.id)} className="player-row">
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
            {isAdmin && (
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
      </li>
    )
  }

  function renderPaidRow(p) {
    const isVerifying = verifyingId === p.id
    const isChecking = checkingId === p.id
    return (
      <li key={p.id} ref={setRowRef(p.id)} className="player-row">
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
            {isAdmin && (
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
            <button type="button" className="link-btn reset-all" onClick={resetAll}>
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

      <header className="header">
        <h1>Thursday Players</h1>
        <p className="subtitle">Who's in for {formatDate(thursday)}?</p>
      </header>

      <div className="top-panels">
        {cost && (
          <section className="cost-banner">
            <h2 className="cost-banner-title">Last week's payment to:</h2>
            <img
              src={cost.imageDataUrl}
              alt="Cost receipt"
              className="cost-thumb"
              onClick={() => setImageExpanded(true)}
            />
            <div className="cost-details">
              <div className="cost-row">
                <span>Total cost</span>
                <strong>{formatMoney(cost.totalCost)}</strong>
              </div>
              <div className="cost-row">
                <span>Players</span>
                <strong>{cost.playerCount}</strong>
              </div>
              <div className="cost-share">
                <span>Each's share</span>
                <strong>{formatMoney(cost.totalCost / cost.playerCount)}</strong>
              </div>
            </div>
          </section>
        )}
      </div>

      {imageExpanded && cost && (
        <div className="lightbox" onClick={() => setImageExpanded(false)}>
          <img src={cost.imageDataUrl} alt="Cost receipt, full size" />
        </div>
      )}

      {isAdmin && (
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
            <button type="submit" disabled={costSaving}>
              {costSaving ? 'Saving…' : cost ? 'Update' : 'Save'}
            </button>
          </div>
          {costError && <span className="login-error">{costError}</span>}
        </form>
      )}

      {isAdmin && (
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
        {players.length > 0 && (
          <input
            type="search"
            className="search-input"
            placeholder="Search players…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        )}
        <div className="status-inline">
          <span className="status-inline-title">Futsal Status:</span>
          <span className={`status-badge status-${matchStatus}`}>{STATUS_LABELS[matchStatus]}</span>
          {isAdmin && (
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

      {loading ? (
        <p className="empty">Loading players…</p>
      ) : players.length === 0 ? (
        <p className="empty">No players yet. Add one above.</p>
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
