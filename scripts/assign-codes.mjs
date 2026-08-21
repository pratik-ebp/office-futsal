// One-off migration: assign a unique 4-digit code to every existing player
// that doesn't already have one, storing only its SHA-256 hash in
// playerCodes/{id}. The plaintext codes are printed once here (never
// written anywhere) so you can send them to people. Safe to re-run — skips
// players that already have a codeHash.
import { createHash } from 'node:crypto'
import { initializeApp } from 'firebase/app'
import { collection, doc, getDoc, getDocs, getFirestore, writeBatch } from 'firebase/firestore'

const firebaseConfig = {
  apiKey: process.env.VITE_FIREBASE_API_KEY,
  authDomain: process.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: process.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.VITE_FIREBASE_APP_ID,
}

function sha256Hex(text) {
  return createHash('sha256').update(text).digest('hex')
}

function randomCode() {
  return String(Math.floor(Math.random() * 10000)).padStart(4, '0')
}

const app = initializeApp(firebaseConfig)
const db = getFirestore(app)

const snap = await getDocs(collection(db, 'players'))
const players = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
players.sort((a, b) => a.name.localeCompare(b.name))

for (const p of players) {
  const codeSnap = await getDoc(doc(db, 'playerCodes', p.id))
  p.hasCode = codeSnap.exists() && !!codeSnap.data().codeHash
}

// Only used to avoid generating a duplicate plaintext code within this run
// — hashes on the server give no way to detect collisions after the fact.
const usedThisRun = new Set()
const batch = writeBatch(db)
let assigned = 0

for (const p of players) {
  if (p.hasCode) continue
  let code
  do {
    code = randomCode()
  } while (usedThisRun.has(code))
  usedThisRun.add(code)
  batch.set(doc(db, 'playerCodes', p.id), { codeHash: sha256Hex(code) })
  p.code = code
  assigned++
}

if (assigned > 0) await batch.commit()

console.error(`Assigned ${assigned} new codes (${players.length - assigned} already had one).`)
console.log('name,code')
for (const p of players) {
  if (p.code) console.log(`${p.name},${p.code}`)
}
