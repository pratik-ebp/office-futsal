import { useEffect, useMemo, useState } from 'react'
import {
  collection,
  deleteDoc,
  deleteField,
  doc,
  getDocs,
  onSnapshot,
  setDoc,
  writeBatch,
} from 'firebase/firestore'
import { db } from './firebase'
import { ROSTER } from './data/roster'
import './App.css'

const ADMIN_SESSION_KEY = 'thursday-players:isAdmin'
const ADMIN_PASSWORD = import.meta.env.VITE_ADMIN_PASSWORD
const PLAYERS_COLLECTION = 'players'
const RESPONSES_COLLECTION = 'responses'

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

// Poll cycle resets every Tuesday midnight: from Tue through the following
// Monday, the target is that window's Thursday. So the board goes blank
// Tuesday morning for the upcoming Thursday (countable from Wednesday on),
// and stays frozen on last Thursday's tally Fri-Mon until the next reset.
function getCycleThursday() {
  const now = new Date()
  const day = now.getDay() // 0 = Sun ... 2 = Tue ... 4 = Thu
  const daysSinceTuesday = (day - 2 + 7) % 7
  const tuesday = new Date(now)
  tuesday.setDate(now.getDate() - daysSinceTuesday)
  const thursday = new Date(tuesday)
  thursday.setDate(tuesday.getDate() + 2)
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
// every load — it's a no-op once any player doc exists.
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
  const [loading, setLoading] = useState(true)
  const [newName, setNewName] = useState('')

  const [isAdmin, setIsAdmin] = useState(
    () => sessionStorage.getItem(ADMIN_SESSION_KEY) === 'true',
  )
  const [showLogin, setShowLogin] = useState(false)
  const [passwordInput, setPasswordInput] = useState('')
  const [loginError, setLoginError] = useState('')

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

  async function addPlayer(e) {
    e.preventDefault()
    if (!isAdmin) return
    const name = newName.trim()
    if (!name) return
    const id = slugify(name) || crypto.randomUUID()
    await setDoc(doc(db, PLAYERS_COLLECTION, id), { name })
    setNewName('')
  }

  async function removePlayer(id) {
    if (!isAdmin) return
    await deleteDoc(doc(db, PLAYERS_COLLECTION, id))
    await setDoc(
      doc(db, RESPONSES_COLLECTION, responsesDocId),
      { [id]: deleteField() },
      { merge: true },
    )
  }

  function submitLogin(e) {
    e.preventDefault()
    if (!ADMIN_PASSWORD) {
      setLoginError('No admin password configured (set VITE_ADMIN_PASSWORD).')
      return
    }
    if (passwordInput === ADMIN_PASSWORD) {
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
  }

  const pendingPlayers = players.filter((p) => !responses[p.id])
  const inPlayers = players.filter((p) => responses[p.id] === 'yes')
  const outPlayers = players.filter((p) => responses[p.id] === 'no')

  function renderRow(p) {
    const status = responses[p.id]
    return (
      <li key={p.id} className="player-row">
        <span className="player-name">{p.name}</span>
        <div className="actions">
          <button
            type="button"
            className={`choice yes ${status === 'yes' ? 'active' : ''}`}
            onClick={() => setResponse(p.id, 'yes')}
          >
            In
          </button>
          <button
            type="button"
            className={`choice no ${status === 'no' ? 'active' : ''}`}
            onClick={() => setResponse(p.id, 'no')}
          >
            Out
          </button>
          {isAdmin && (
            <button
              type="button"
              className="remove"
              aria-label={`Remove ${p.name}`}
              onClick={() => removePlayer(p.id)}
            >
              ×
            </button>
          )}
        </div>
      </li>
    )
  }

  return (
    <div className="page">
      <div className="admin-bar">
        {isAdmin ? (
          <>
            <span className="admin-badge">Admin mode</span>
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

      {isAdmin && (
        <form className="add-form" onSubmit={addPlayer}>
          <input
            type="text"
            placeholder="Add a player"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
          <button type="submit">Add</button>
        </form>
      )}

      {loading ? (
        <p className="empty">Loading players…</p>
      ) : players.length === 0 ? (
        <p className="empty">No players yet. Add one above.</p>
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
        </div>
      )}
    </div>
  )
}

export default App
