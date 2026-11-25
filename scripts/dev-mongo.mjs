import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { MongoClient } from 'mongodb';
import { MongoBinary } from 'mongodb-memory-server-core';

const uri = 'mongodb://127.0.0.1:27017/';
const probe = new MongoClient(uri, { serverSelectionTimeoutMS: 1500 });
try {
  await probe.connect(); await probe.db('admin').command({ ping: 1 });
  console.log(`MongoDB is already running at ${uri}; using the existing instance.`);
  await probe.close(); process.exit(0);
} catch { await probe.close(); }

// This launches the real mongod engine with persistent disk storage, not a temporary test database.
const directory = path.resolve('.local', 'mongodb');
mkdirSync(directory, { recursive: true });
const binary = process.env.MONGOD_BINARY || await MongoBinary.getPath();
const child = spawn(binary, ['--bind_ip', '127.0.0.1', '--port', '27017', '--dbpath', directory, '--logpath', path.resolve('.local', 'mongodb.log'), '--logappend'], { stdio: 'inherit', windowsHide: true });
let stopping = false;
child.on('error', error => { console.error(`MongoDB could not start: ${error.message}`); process.exitCode = 1; });
child.on('exit', code => { if (!stopping) process.exitCode = code || 0; });
for (let attempt = 0; attempt < 60; attempt++) {
  if (child.exitCode !== null) throw new Error('MongoDB exited. Inspect .local/mongodb.log.');
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 500 });
  try { await client.connect(); await client.db('admin').command({ ping: 1 }); console.log(`Persistent development MongoDB ready at ${uri}\nData: ${directory}`); break; }
  catch { if (attempt === 59) { child.kill(); throw new Error('MongoDB startup timed out. Inspect .local/mongodb.log.'); } }
  finally { await client.close(); }
  await new Promise(resolve => setTimeout(resolve, 500));
}
async function stop() {
  if (stopping) return; stopping = true;
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 1500 });
  try { await client.connect(); await client.db('admin').command({ shutdown: 1 }); } catch { /* Shutdown closes its connection. */ } finally { await client.close(); }
  setTimeout(() => { if (child.exitCode === null) child.kill(); }, 3000).unref();
}
process.on('SIGINT', stop); process.on('SIGTERM', stop);
