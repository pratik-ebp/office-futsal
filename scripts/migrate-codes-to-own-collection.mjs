// One-off: move the plaintext `code` field off /players/{id} into its own
// /playerCodes/{id} collection, hashed (SHA-256) so no plaintext code is
// ever stored in Firestore. Safe to re-run — skips players with no
// plaintext code left to move.
import { createHash } from 'node:crypto'
import { initializeApp } from 'firebase/app'
import {
  collection,
  deleteField,
  doc,
  getDocs,
  getFirestore,
  writeBatch,
} from 'firebase/firestore'

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

const app = initializeApp(firebaseConfig)
const db = getFirestore(app)

const snap = await getDocs(collection(db, 'players'))
const batch = writeBatch(db)
let moved = 0

for (const d of snap.docs) {
  const data = d.data()
  if (!data.code) continue
  batch.set(doc(db, 'playerCodes', d.id), { codeHash: sha256Hex(data.code) })
  batch.update(doc(db, 'players', d.id), { code: deleteField() })
  moved++
}

if (moved > 0) await batch.commit()
console.error(`Moved and hashed ${moved} codes into playerCodes/*.`)
