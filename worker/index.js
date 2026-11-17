const cookieName = '__Host-kyote_session';
const sessionAge = 14 * 24 * 60 * 60;
const headers = {'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
const json = (data, status = 200, extra = {}) => Response.json(data, {status,headers:{...headers,...extra}});
const error = (message, status) => json({error:message},status);
const denied = () => error('ログインしてください。',401);
const idPattern = /^[a-z0-9_-]{3,32}$/;
const randomHex = bytes => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), n => n.toString(16).padStart(2,'0')).join('');
const digest = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))), n => n.toString(16).padStart(2,'0')).join('');
const digestPassword = (id,password) => digest('student-password:' + id + ':' + password);
const passwordTooLong = value => value.length > 128;
const passwordMinimum = 15;
const passwordWindow = 15 * 60 * 1000;

async function derivePassword(password,salt) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw',encoder.encode(password),'PBKDF2',false,['deriveBits']);
  const bits = await crypto.subtle.deriveBits({
    name:'PBKDF2',hash:'SHA-256',salt:encoder.encode(salt),iterations:100000
  },key,256);
  return Array.from(new Uint8Array(bits),n=>n.toString(16).padStart(2,'0')).join('');
}
async function hashPassword(password) {
  const salt = randomHex(16);
  return 'pbkdf2-v1:' + salt + ':' + await derivePassword(password,salt);
}
async function matchesPassword(id,password,stored) {
  if (stored.startsWith('pbkdf2-v1:')) {
    const [,salt,hash] = stored.split(':');
    return equalDigest(await derivePassword(password,salt),hash);
  }
  // Only accounts issued by the teacher use this initial, randomly generated credential.
  return /^[a-f0-9]{32}$/.test(password) && equalDigest(await digestPassword(id,password),stored);
}
async function reservePasswordAttempt(db,id) {
  const now = Date.now();
  const cutoff = now - passwordWindow;
  return db.prepare(
    'UPDATE students SET password_attempts = CASE WHEN password_window <= ? THEN 1 ELSE password_attempts + 1 END, password_window = CASE WHEN password_window <= ? THEN ? ELSE password_window END WHERE id = ? AND (password_window <= ? OR password_attempts < 10) RETURNING id,name,password_digest'
  ).bind(cutoff,cutoff,now,id,cutoff).first();
}
const retryPasswordLater = () => error('パスワードの確認を何度も試したため、しばらく待ってから再試行してください。',429);

function equalDigest(left, right) {
  let difference = left.length ^ right.length;
  for (let i=0;i<left.length;i++) difference |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return difference === 0;
}
function cookie(token, age) {
  return cookieName+'='+token+'; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age='+age;
}
function tokenFrom(request) {
  return (request.headers.get('Cookie') || '').match(/(?:^|;\s*)__Host-kyote_session=([a-f0-9]{64})(?:;|$)/)?.[1];
}
function isTeacher(request, env) {
  const email = request.headers.get('oai-authenticated-user-email')?.trim().toLowerCase();
  return Boolean(request.headers.get('oai-authenticated-user-id') && email &&
    env.TEACHER_EMAIL && email === env.TEACHER_EMAIL.trim().toLowerCase());
}
async function getStudent(request, db) {
  const token = tokenFrom(request);
  if (!token) return null;
  return db.prepare('SELECT students.id, students.name FROM sessions JOIN students ON students.id = sessions.student_id WHERE token_digest = ? AND expires_at > ?')
    .bind(await digest(token),Date.now()).first();
}
async function getRecords(db,id) {
  const {results} = await db.prepare('SELECT payload FROM attempts WHERE student_id = ? ORDER BY json_extract(payload, \'$.at\') DESC').bind(id).all();
  return results.map(row=>JSON.parse(row.payload));
}
async function getComments(db,id) {
  const {results} = await db.prepare('SELECT body, created_at FROM teacher_comments WHERE student_id = ? ORDER BY id DESC').bind(id).all();
  return results;
}
async function readJson(request) {
  if (!(/^application\/json(?:;|$)/i.test(request.headers.get('Content-Type') || '')) ||
      request.headers.get('Sec-Fetch-Site') === 'cross-site') throw new Error('format');
  const max = 1024 * 1024;
  const reader = request.body?.getReader();
  if (!reader) throw new Error('format');
  const decoder = new TextDecoder();
  let size = 0, text = '';
  for (;;) {
    const {done,value} = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size>max) { await reader.cancel(); throw new Error('size'); }
    text += decoder.decode(value,{stream:true});
  }
  return JSON.parse(text + decoder.decode());
}
async function readMutation(request) {
  try {
    const data = await readJson(request);
    if (data && typeof data === 'object' && !Array.isArray(data)) return data;
  } catch {}
  return null;
}
async function teacherApi(path, method, request, env, data) {
  if (!isTeacher(request,env)) return error('講師用のChatGPTアカウントでログインしてください。',403);
  const db = env.DB;
  if (path === '/api/teacher/students') {
    if (method === 'GET') {
      const {results} = await db.prepare('SELECT id,name FROM students ORDER BY name,id').all();
      return json({students:results});
    }
    if (method === 'POST') {
      const id = typeof data.id === 'string' ? data.id.trim().toLowerCase() : '';
      const name = typeof data.name === 'string' ? data.name.trim() : '';
      if (!idPattern.test(id) || !name || name.length>60) return error('表示名と、英数字・ハイフン・アンダーバー3〜32文字のIDを入力してください。',400);
      const password = randomHex(16);
      const result = await db.prepare('INSERT INTO students (id,name,password_digest) VALUES (?,?,?) ON CONFLICT(id) DO NOTHING')
        .bind(id,name,await digestPassword(id,password)).run();
      return result.meta.changes ? json({id,name,password},201) : error('このIDは既に使われています。',409);
    }
  }
  const route = path.match(/^\/api\/teacher\/students\/([a-z0-9_-]{3,32})(\/comments)?$/);
  if (!route) return error('ページが見つかりません。',404);
  const [,id,commentsPath] = route;
  const student = await db.prepare('SELECT id,name FROM students WHERE id = ?').bind(id).first();
  if (!student) return error('生徒が見つかりません。',404);
  if (!commentsPath && method === 'GET') {
    const [records,comments] = await Promise.all([getRecords(db,id),getComments(db,id)]);
    return json({student,records,comments});
  }
  if (commentsPath && method === 'POST') {
    const body = typeof data.body === 'string' ? data.body.trim() : '';
    if (!body || body.length>2000) return error('コメントを1〜2000文字で入力してください。',400);
    const created_at = new Date().toISOString();
    await db.prepare('INSERT INTO teacher_comments (student_id,body,created_at) VALUES (?,?,?)').bind(id,body,created_at).run();
    return json({body,created_at},201);
  }
  return error('ページが見つかりません。',404);
}
async function studentApi(path, method, request, env, data) {
  const db = env.DB;
  if (path === '/api/session' && method === 'POST') {
    const id = typeof data.id === 'string' ? data.id.trim().toLowerCase() : '';
    const password = typeof data.password === 'string' ? data.password : '';
    if (!idPattern.test(id) || !password || passwordTooLong(password)) return error('IDまたはパスワードが違います。',401);
    const row = await reservePasswordAttempt(db,id);
    if (!row && await db.prepare('SELECT id FROM students WHERE id = ?').bind(id).first()) return retryPasswordLater();
    if (!row || !await matchesPassword(id,password,row.password_digest)) return error('IDまたはパスワードが違います。',401);
    const token = randomHex(32);
    const oldToken = tokenFrom(request);
    const statements = [
      db.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(Date.now()),
      db.prepare('INSERT INTO sessions (token_digest,student_id,expires_at) SELECT ?,id,? FROM students WHERE id = ? AND password_digest = ?')
        .bind(await digest(token),Date.now()+sessionAge*1000,id,row.password_digest),
      db.prepare('UPDATE students SET password_attempts = 0, password_window = 0 WHERE id = ? AND password_digest = ?')
        .bind(id,row.password_digest)
    ];
    if (oldToken) statements.push(db.prepare('DELETE FROM sessions WHERE token_digest = ?').bind(await digest(oldToken)));
    const results = await db.batch(statements);
    if (!results[1].meta.changes) return error('パスワードが変更されました。再度ログインしてください。',401);
    return json({student:{id,name:row.name}},200,{'Set-Cookie':cookie(token,sessionAge)});
  }
  if (path === '/api/logout' && method === 'POST') {
    const token = tokenFrom(request);
    const student = await getStudent(request,db);
    if (student && request.headers.get('X-Student-Id') !== student.id) return denied();
    if (token) await db.prepare('DELETE FROM sessions WHERE token_digest = ?').bind(await digest(token)).run();
    return json({ok:true},200,{'Set-Cookie':cookie('',0)});
  }
  const student = await getStudent(request,db);
  if (!student) return denied();
  if (path === '/api/session' && method === 'GET') return json({student});
  if (request.headers.get('X-Student-Id') !== student.id) return denied();
  if (path === '/api/password' && method === 'POST') {
    const {currentPassword,newPassword} = data;
    if (typeof currentPassword !== 'string' || !currentPassword || passwordTooLong(currentPassword) ||
        typeof newPassword !== 'string' || [...newPassword].length < passwordMinimum ||
        passwordTooLong(newPassword) || !newPassword.trim() || newPassword === currentPassword) {
      return error('現在のパスワードを入力し、新しいパスワードは現在と異なる15〜128文字にしてください。',400);
    }
    const row = await reservePasswordAttempt(db,student.id);
    if (!row) return retryPasswordLater();
    if (!await matchesPassword(student.id,currentPassword,row.password_digest)) return error('現在のパスワードが違います。',422);
    const passwordHash = await hashPassword(newPassword);
    const activeToken = await digest(tokenFrom(request));
    const newToken = randomHex(32);
    const expires = Date.now()+sessionAge*1000;
    const results = await db.batch([
      db.prepare('UPDATE students SET password_digest = ?, password_attempts = 0, password_window = 0 WHERE id = ? AND password_digest = ? AND EXISTS (SELECT 1 FROM sessions WHERE token_digest = ? AND student_id = students.id AND expires_at > ?)')
        .bind(passwordHash,student.id,row.password_digest,activeToken,Date.now()),
      db.prepare('DELETE FROM sessions WHERE student_id = ? AND EXISTS (SELECT 1 FROM students WHERE id = ? AND password_digest = ?)')
        .bind(student.id,student.id,passwordHash),
      db.prepare('INSERT INTO sessions (token_digest,student_id,expires_at) SELECT ?,id,? FROM students WHERE id = ? AND password_digest = ?')
        .bind(await digest(newToken),expires,student.id,passwordHash)
    ]);
    if (!results[0].meta.changes) return error('ログイン情報が更新されました。再度ログインしてください。',401);
    return json({ok:true},200,{'Set-Cookie':cookie(newToken,sessionAge)});
  }
  if (path === '/api/records' && method === 'GET') return json({records:await getRecords(db,student.id)});
  if (path === '/api/comments' && method === 'GET') return json({comments:await getComments(db,student.id)});
  if (path === '/api/records' && method === 'POST') {
    let records;
    if (!Array.isArray(data.upsert) || !Array.isArray(data.remove) || data.upsert.length+data.remove.length>40) {
      return error('一度に保存できる記録は40件です。',400);
    }
    try {
      records = validateRecords(data.upsert);
      if (records.some(record=>record.id.length>180) || data.remove.some(row=>typeof row?.id !== 'string' ||
          !row.id || row.id.length>180 || typeof row.updated !== 'string' || !Number.isFinite(Date.parse(row.updated)))) throw new Error('invalid');
    } catch { return error('記録の形式が異なります。',400); }
    const statements = records.map(record=>db.prepare(
      'INSERT INTO attempts (student_id,record_id,payload) VALUES (?,?,?) ON CONFLICT(student_id,record_id) DO UPDATE SET payload=excluded.payload WHERE json_extract(excluded.payload, \'$.updated\') >= json_extract(attempts.payload, \'$.updated\')'
    ).bind(student.id,record.id,JSON.stringify(record)));
    for (const row of data.remove) statements.push(db.prepare(
      'DELETE FROM attempts WHERE student_id = ? AND record_id = ? AND json_extract(payload, \'$.updated\') = ?'
    ).bind(student.id,row.id,new Date(row.updated).toISOString()));
    if (statements.length) {
      const results = await db.batch(statements);
      if (results.some(result=>result.meta.changes===0)) return json({error:'別の端末に新しい記録があります。最新の内容を確認してください。',records:await getRecords(db,student.id)},409);
    }
    return json({records:await getRecords(db,student.id)});
  }
  return error('ページが見つかりません。',404);
}
export default {
  async fetch(request,env) {
    const {pathname:path} = new URL(request.url);
    const method = request.method;
    if (method === 'GET' || method === 'HEAD') {
      const encoded = Object.hasOwn(siteIcons,path) ? siteIcons[path] : undefined;
      if (encoded) {
        return new Response(method === 'HEAD' ? null : Uint8Array.from(atob(encoded),character=>character.charCodeAt(0)),{headers:{
          ...headers,'Content-Type':'image/png','Cache-Control':'public, max-age=3600'
        }});
      }
      if (path === '/manifest.webmanifest') {
        return new Response(method === 'HEAD' ? null : JSON.stringify(webManifest),{headers:{
          ...headers,'Content-Type':'application/manifest+json; charset=utf-8'
        }});
      }
    }
    if ((path === '/' || path === '/admin') && (method === 'GET' || method === 'HEAD')) {
      return new Response(method === 'HEAD' ? null : page,{headers:{
        ...headers,'Content-Type':'text/html; charset=utf-8','Referrer-Policy':'strict-origin-when-cross-origin',
        'Content-Security-Policy':"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; manifest-src 'self'; form-action 'self'; base-uri 'none'; object-src 'none'"
      }});
    }
    if (!path.startsWith('/api/') || !['GET','POST'].includes(method)) return error('ページが見つかりません。',404);
    try {
      const data = method === 'POST' ? await readMutation(request) : null;
      if (method === 'POST' && !data) return error('リクエストの形式が異なります。',400);
      return await (path.startsWith('/api/teacher/') ? teacherApi(path,method,request,env,data) : studentApi(path,method,request,env,data));
    } catch (e) {
      console.error('Classroom API error',path,e?.name);
      return error('処理できませんでした。時間をおいて再試行してください。',503);
    }
  }
};
