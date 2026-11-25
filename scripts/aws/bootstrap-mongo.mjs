// Run by the AWS account operator after the first infrastructure deployment.
// Secrets and TLS keys are generated on EC2 and never pass through this process.
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
const args = Object.fromEntries(process.argv.slice(2).map(a => a.split('=')));
const region = args.region || 'ap-south-1';
const dryRun = args.dryRun === 'true';
const outputs = dryRun ? { MongoNode1: 'i-00000000000000001', MongoNode2: 'i-00000000000000002', MongoNode3: 'i-00000000000000003', MongoRootSecret: 'arn:aws:secretsmanager:ap-south-1:111111111111:secret:example-root', MongoAppSecret: 'arn:aws:secretsmanager:ap-south-1:111111111111:secret:example-app', MongoClusterSecret: 'arn:aws:secretsmanager:ap-south-1:111111111111:secret:example-cluster' } : JSON.parse(readFileSync(args.outputs || 'aws-outputs.json', 'utf8')).HayaStack;
if (!outputs?.MongoNode1) throw new Error('Missing HayaStack outputs. Pass outputs=path/to/aws-outputs.json.');
function aws(...parameters) { return JSON.parse(execFileSync(process.platform === 'win32' ? 'aws.exe' : 'aws', [...parameters, '--region', region, '--output', 'json'], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })); }
async function run(instance, script, label) {
  console.log(label);
  if (dryRun) { mkdirSync('infra/bootstrap-review', { recursive: true }); writeFileSync(`infra/bootstrap-review/${label.replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase()}.sh`, script); return; }
  const result = aws('ssm', 'send-command', '--instance-ids', instance, '--document-name', 'AWS-RunShellScript', '--timeout-seconds', '900', '--parameters', JSON.stringify({ commands: [script] }));
  const commandId = result.Command.CommandId;
  for (let i = 0; i < 180; i++) {
    await new Promise(resolve => setTimeout(resolve, 5000));
    let status; try { status = aws('ssm', 'get-command-invocation', '--command-id', commandId, '--instance-id', instance); } catch { continue; }
    if (status.Status === 'Success') return;
    if (!['Pending', 'InProgress', 'Delayed'].includes(status.Status)) throw new Error(`${label} failed (${status.Status}). Inspect Systems Manager command ${commandId}; do not rerun over an existing database.`);
  }
  throw new Error(`${label} timed out. Inspect SSM command ${commandId} before retrying.`);
}
const env = `export AWS_DEFAULT_REGION='${region}'\nROOT_SECRET='${outputs.MongoRootSecret}'\nAPP_SECRET='${outputs.MongoAppSecret}'\nCLUSTER_SECRET='${outputs.MongoClusterSecret}'\nexport ROOT_SECRET APP_SECRET CLUSTER_SECRET\n`;
await run(outputs.MongoNode1, String.raw`#!/bin/bash
set -euo pipefail
${env}
for i in $(seq 1 60); do test -f /opt/haya/ready && break; sleep 5; done
test -f /opt/haya/ready
umask 077
mkdir -p /opt/haya/bootstrap
cd /opt/haya/bootstrap
aws secretsmanager get-secret-value --secret-id "$CLUSTER_SECRET" --query SecretString --output text > current.json
if python3 -c 'import json; exit(0 if "certificate" in json.load(open("current.json")) else 1)'; then
  cp current.json cluster.json
else
openssl req -x509 -newkey rsa:3072 -nodes -days 1825 -keyout ca.key -out ca.pem -subj '/CN=HAYA MongoDB CA'
openssl req -newkey rsa:3072 -nodes -keyout server.key -out server.csr -subj '/CN=mongo1.mongo.haya.internal'
printf 'subjectAltName=DNS:mongo1.mongo.haya.internal,DNS:mongo2.mongo.haya.internal,DNS:mongo3.mongo.haya.internal,DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth,clientAuth\n' > extensions.cnf
openssl x509 -req -in server.csr -CA ca.pem -CAkey ca.key -CAcreateserial -days 365 -out server.crt -extfile extensions.cnf
cat server.crt server.key > certificate.pem
openssl rand -base64 756 > replica.key
python3 - <<'PY'
import json
ca=open('ca.pem').read()
cluster={'ca':ca,'caKey':open('ca.key').read(),'certificate':open('certificate.pem').read(),'keyfile':open('replica.key').read()}
json.dump(cluster,open('cluster.json','w'))
PY
aws secretsmanager put-secret-value --secret-id "$CLUSTER_SECRET" --secret-string file://cluster.json > /dev/null
fi
aws secretsmanager get-secret-value --secret-id "$APP_SECRET" --query SecretString --output text > app.json
python3 - <<'PY'
import json,urllib.parse
ca=json.load(open('cluster.json'))['ca']
app=json.load(open('app.json'))
app['ca']=ca
app['uri']='mongodb://'+urllib.parse.quote(app['username'],safe='')+':'+urllib.parse.quote(app['password'],safe='')+'@mongo1.mongo.haya.internal:27017,mongo2.mongo.haya.internal:27017,mongo3.mongo.haya.internal:27017/haya?replicaSet=rs0&authSource=haya&tls=true'
json.dump(app,open('updated-app.json','w'))
PY
aws secretsmanager put-secret-value --secret-id "$APP_SECRET" --secret-string file://updated-app.json > /dev/null
rm -f ca.key ca.pem ca.srl server.key server.csr server.crt certificate.pem replica.key extensions.cnf app.json updated-app.json cluster.json current.json
`, 'Generate private MongoDB certificates and replica credentials');
for (let i = 1; i <= 3; i++) {
  await run(outputs[`MongoNode${i}`], String.raw`#!/bin/bash
set -euo pipefail
${env}
for i in $(seq 1 60); do test -f /opt/haya/ready && break; sleep 5; done
test -f /opt/haya/ready
umask 077
mkdir -p /opt/haya/tls /opt/haya/mongo
aws secretsmanager get-secret-value --secret-id "$CLUSTER_SECRET" --query SecretString --output text > /opt/haya/tls/config.json
python3 - <<'PY'
import json,os
d=json.load(open('/opt/haya/tls/config.json'))
for field,name in [('ca','ca.pem'),('certificate','certificate.pem'),('keyfile','replica.key')]:
 p='/opt/haya/tls/'+name;open(p,'w').write(d[field]);os.chmod(p,0o400);os.chown(p,999,999)
os.remove('/opt/haya/tls/config.json')
PY
chown 999:999 /opt/haya/mongo /opt/haya/tls
if docker inspect haya-mongo > /dev/null 2>&1; then exit 0; fi
docker run -d --name haya-mongo --restart unless-stopped --network host -v /opt/haya/mongo:/data/db -v /opt/haya/tls:/tls:ro mongo:8.0 mongod --replSet rs0 --bind_ip_all --auth --keyFile /tls/replica.key --tlsMode requireTLS --tlsCertificateKeyFile /tls/certificate.pem --tlsCAFile /tls/ca.pem --tlsAllowConnectionsWithoutCertificates > /dev/null
`, `Start MongoDB replica member ${i}`);
}
await run(outputs.MongoNode1, String.raw`#!/bin/bash
set -euo pipefail
${env}
umask 077
cd /opt/haya/bootstrap
if test -f initialised; then exit 0; fi
aws secretsmanager get-secret-value --secret-id "$ROOT_SECRET" --query SecretString --output text > root.json
aws secretsmanager get-secret-value --secret-id "$APP_SECRET" --query SecretString --output text > app.json
python3 - <<'PY'
import json
root=json.load(open('root.json'));app=json.load(open('app.json'))
script='try { rs.status(); } catch(e) { rs.initiate({_id:"rs0",members:[{_id:0,host:"mongo1.mongo.haya.internal:27017",priority:2},{_id:1,host:"mongo2.mongo.haya.internal:27017"},{_id:2,host:"mongo3.mongo.haya.internal:27017"}]}); }\n'
script+='for(let i=0;i<120&&!db.hello().isWritablePrimary;i++) sleep(1000); if(!db.hello().isWritablePrimary) throw Error("Primary election timed out");\n'
script+='db=db.getSiblingDB("admin"); db.createUser('+json.dumps({'user':root['username'],'pwd':root['password'],'roles':['root']})+');\n'
script+='db.auth('+json.dumps(root['username'])+','+json.dumps(root['password'])+');db=db.getSiblingDB("haya"); db.createUser('+json.dumps({'user':app['username'],'pwd':app['password'],'roles':[{'role':'readWrite','db':'haya'}]})+');\n'
open('initialise.js','w').write(script)
PY
docker exec -i haya-mongo mongosh --quiet --host localhost --tls --tlsCAFile /tls/ca.pem --file /dev/stdin < initialise.js > /dev/null
touch initialised
rm -f root.json app.json initialise.js
`, 'Initialise rs0 and create least-privilege application user');
console.log(dryRun ? 'Prepared review scripts only; no AWS calls made.' : 'MongoDB bootstrap finished. Build/push the API image, then deploy with desiredCount=2. Schedule certificate rotation before the 365-day server certificate expires.');
