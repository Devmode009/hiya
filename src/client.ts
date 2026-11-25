import { useEffect, useState } from 'react';
import { applyAction, demoUsers, seedData, visibleData, type Action, type AppData, type User } from './domain';

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, { credentials: 'same-origin', ...init, headers: { 'Content-Type': 'application/json', ...init?.headers } });
  const body = await response.json().catch(() => ({ error: 'The server could not be reached. Your local drafts are still available.' }));
  if (!response.ok) throw new Error(body.error || 'The request could not be completed.');
  return body;
}
function restore(): AppData {
  try { const stored = JSON.parse(localStorage.getItem('haya-demo-v1') || 'null'); if (stored?.sites && stored?.revision >= 0) return stored; } catch { /* Start a new sample workspace. */ }
  return seedData();
}
export function useWorkspace() {
  const demoAllowed = import.meta.env.DEV || import.meta.env.VITE_DEMO_MODE === 'true';
  const [demo, setDemo] = useState(demoAllowed && localStorage.getItem('haya-mode') !== 'server');
  const [raw, setRaw] = useState<AppData>(restore);
  const [user, setUser] = useState<User | null>(null);
  const [people, setPeople] = useState<User[]>([]);
  const [role, setRole] = useState(localStorage.getItem('haya-demo-role') || 'supervisor');
  const [loading, setLoading] = useState(!demo);
  const [error, setError] = useState('');
  const activeUser = demo ? demoUsers.find(u => u.id === role) || demoUsers[2] : user;
  const refresh = async () => {
    const result = await api<{ user: User; data: AppData; people: User[] }>('/workspace');
    setUser(result.user); setRaw(result.data); setPeople(result.people);
  };
  useEffect(() => { if (!demo) { setLoading(true); refresh().catch(e => { setUser(null); if (!e.message.includes('Sign in')) setError(e.message); }).finally(() => setLoading(false)); } }, [demo]);
  const act = async (action: Action) => {
    if (!activeUser) throw new Error('Sign in to continue.');
    if (demo) {
      const next = applyAction(raw, activeUser, action);
      // Persist before acknowledging so quota failures never look successful.
      localStorage.setItem('haya-demo-v1', JSON.stringify(next)); setRaw(next);
    } else {
      const result = await api<{ data: AppData }>('/actions', { method: 'POST', body: JSON.stringify({ action }) }); setRaw(result.data);
    }
  };
  return { demo, demoAllowed, data: activeUser ? visibleData(raw, activeUser) : raw, user: activeUser, people: demo ? demoUsers : people, loading, error, act, refresh,
    changeRole: (value: string) => { setRole(value); localStorage.setItem('haya-demo-role', value); },
    switchMode: (value: boolean) => { setDemo(value); localStorage.setItem('haya-mode', value ? 'demo' : 'server'); },
    login: async (email: string, password: string) => { await api('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }); await refresh(); },
    logout: async () => { await api('/auth/logout', { method: 'POST' }); setUser(null); },
  };
}
export function useDraft<T>(key: string, initial: T): [T, (value: T) => void, () => void] {
  const read = () => { try { return JSON.parse(localStorage.getItem(key) || 'null') ?? initial; } catch { return initial; } };
  const [value, setValue] = useState<T>(read);
  useEffect(() => { setValue(read()); }, [key]);
  return [value, (next: T) => { localStorage.setItem(key, JSON.stringify(next)); setValue(next); }, () => { localStorage.removeItem(key); setValue(initial); }];
}
export async function storePhoto(file: File, demo: boolean, siteId: string): Promise<string> {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('Choose a JPG, PNG or WebP photo.');
  if (file.size > 8 * 1024 * 1024) throw new Error('Each photo must be smaller than 8 MB.');
  if (!demo) {
    const form = new FormData(); form.append('siteId', siteId); form.append('photo', file);
    const response = await fetch('/api/media', { method: 'POST', body: form });
    const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Photo upload failed.'); return result.id;
  }
  const db = await openPhotos(); const key = crypto.randomUUID();
  await new Promise<void>((resolve, reject) => { const transaction = db.transaction('photos', 'readwrite'); transaction.objectStore('photos').put(file, key); transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(new Error('Unable to save photo on this device.')); });
  db.close(); return key;
}
function openPhotos(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => { const request = indexedDB.open('haya-evidence', 1); request.onupgradeneeded = () => request.result.createObjectStore('photos'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(new Error('Photo storage is unavailable in this browser.')); });
}
export async function photoUrl(key: string, demo: boolean): Promise<string> {
  if (!demo) { const result = await api<{ url: string }>(`/media/${encodeURIComponent(key)}`); return result.url; }
  const db = await openPhotos(); const blob = await new Promise<Blob>((resolve, reject) => { const request = db.transaction('photos').objectStore('photos').get(key); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(new Error('Photo not found.')); }); db.close();
  return blob ? URL.createObjectURL(blob) : '';
}
