const classroomRoot = node('main');
const exerciseRoot = document.querySelector('body > main');
const exerciseNav = document.querySelector('header nav');
exerciseRoot.before(classroomRoot);
const teacherView = location.pathname === '/admin';
const labelDate = new Intl.DateTimeFormat('ja-JP',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Tokyo'});
const formFields = '<style>.classroom{display:grid;gap:16px}.classroom form{display:grid;gap:10px}.classroom input,.classroom textarea{display:block;width:100%;padding:10px;min-height:44px;border-radius:9px;border:1px solid var(--line);font:inherit;font-size:16px;color:var(--ink);background:white}.classroom input{margin-top:4px}.classroom textarea{resize:vertical}.classroom form button{justify-self:start}.classroom .feedback{margin:0}.classroom-login{max-width:480px;margin:0 auto}.classroom-login h1{margin:0 0 14px}.classroom .comment{white-space:pre-wrap;overflow-wrap:anywhere}.classroom .credential{font-family:monospace;overflow-wrap:anywhere}.classroom .actions a{margin:6px 0}.classroom-strip{margin-bottom:15px}</style>';
classroomRoot.className = 'classroom';
classroomRoot.innerHTML = formFields;

async function api(path,body,studentId) {
  const headers = studentId ? {'X-Student-Id':studentId} : {};
  const result = await fetch(path,body === undefined ? {headers} : {
    method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify(body)
  });
  const data = await result.json().catch(()=>({}));
  if (!result.ok) {
    const failure = new Error(data.error || '通信できませんでした。');
    failure.status = result.status;
    failure.data = data;
    throw failure;
  }
  return data;
}
function feedback(element, message, failed = false) {
  element.textContent = message;
  element.classList.toggle('error',failed);
}
function renderComments(element, comments, empty) {
  element.replaceChildren();
  if (!comments.length) element.append(node('p',empty,'muted'));
  for (const comment of comments) {
    const item = node('div',undefined,'block');
    item.append(node('small',labelDate.format(new Date(comment.created_at))),
      node('p',comment.body,'comment'));
    element.append(item);
  }
}
let currentStudentId;
const legacyButtonId = 'importDeviceRecords';
function showStudentLogin(message = '') {
  currentStudentId = undefined;
  $(legacyButtonId)?.remove();
  exerciseRoot.hidden = true;
  exerciseNav.hidden = true;
  records = [];
  loadForm();
  refresh();
  classroomRoot.hidden = false;
  classroomRoot.innerHTML = formFields + `
    <section class="card classroom-login">
      <h1>生徒ログイン</h1>
      <form id="studentLogin">
        <label>生徒ID<input name="id" required maxlength="32" autocomplete="username" autocapitalize="none" spellcheck="false"></label>
        <label>パスワード<input name="password" type="password" required maxlength="128" autocomplete="current-password"></label>
        <button class="primary">ログイン</button>
        <p id="loginStatus" class="feedback" role="status"></p>
      </form>
      <p><a href="/admin">講師用の管理画面</a></p>
    </section>`;
  feedback($('loginStatus'),message,Boolean(message));
  $('studentLogin').addEventListener('submit',async event=>{
    event.preventDefault();
    const current = event.currentTarget;
    const submit = current.querySelector('button');
    submit.disabled = true;
    try {
      const data = new FormData(current);
      const {student} = await api('/api/session',{id:data.get('id'),password:data.get('password')});
      await showStudent(student);
    } catch (failure) {
      feedback($('loginStatus'),failure.message,true);
    } finally { submit.disabled = false; }
  });
}
let saving = false;
globalThis.classroomSave = async function(next) {
  if (saving) {
    notify('保存中です。完了してからもう一度操作してください。',true);
    return false;
  }
  const previous = new Map(records.map(record=>[record.id,record]));
  const keep = new Set(next.map(record=>record.id));
  const writes = [
    ...next.filter(record=>previous.get(record.id)!==record).map(record=>({upsert:record})),
    ...records.filter(record=>!keep.has(record.id)).map(record=>({remove:{id:record.id,updated:record.updated}}))
  ];
  if (!writes.length) return true;
  saving = true;
  $('save').disabled = true;
  notify('保存中…');
  try {
    for (let i=0;i<writes.length;i+=10) {
      const part = writes.slice(i,i+10);
      const result = await api('/api/records',{
        upsert:part.flatMap(row=>row.upsert ? [row.upsert] : []),
        remove:part.flatMap(row=>row.remove ? [row.remove] : [])
      },currentStudentId);
      records = validate(result.records);
    }
    refresh();
    return true;
  } catch (failure) {
    if (failure.status === 401) showStudentLogin('ログインの有効期限が切れました。もう一度ログインしてください。');
    else {
      if (failure.status === 409 && failure.data.records) records = validate(failure.data.records);
      refresh();
      notify(failure.message,true);
    }
    return false;
  } finally {
    saving = false;
    $('save').disabled = false;
  }
};
async function showStudent(student) {
  const [{records: stored},{comments}] = await Promise.all([
    api('/api/records',undefined,student.id),api('/api/comments',undefined,student.id)
  ]);
  currentStudentId = student.id;
  records = validate(stored);
  classroomRoot.hidden = true;
  exerciseRoot.hidden = false;
  exerciseNav.hidden = false;
  const bar = node('section',undefined,'card classroom-strip');
  const actions = node('div',undefined,'actions');
  actions.append(node('strong',student.name+' さん'),button('ログアウト',async ()=>{
    if (saving) return;
    try { await api('/api/logout',{},student.id); bar.remove(); showStudentLogin(); }
    catch (failure) { notify(failure.message,true); }
  }));
  bar.append(actions);
  bar.append(passwordSettings(student));
  const thread = node('details');
  thread.open = comments.length > 0;
  thread.append(node('summary','講師からのコメント'+(comments.length ? '（'+comments.length+'件）' : '')));
  const threadItems = node('div');
  threadItems.style.whiteSpace = 'pre-wrap';
  renderComments(threadItems,comments,'コメントはまだありません。');
  thread.append(threadItems);
  bar.append(thread);
  const oldBar = exerciseRoot.querySelector('.classroom-strip');
  if (oldBar) oldBar.remove();
  exerciseRoot.prepend(bar);
  show('record');
  loadForm();
  refresh();
  $('export').parentElement.previousElementSibling.textContent =
    '記録はこのアカウントに保存され、PCやiPhoneで閲覧できます。JSONでのバックアップもできます。';
  try {
    $(legacyButtonId)?.remove();
    if (validate(JSON.parse(localStorage.getItem(storageKey) || '[]')).length) {
      const migration = button('この端末の旧記録を取り込む',()=>{
        if (!confirm('このブラウザに保存されている旧記録を、'+student.name+'さんのアカウントに取り込みますか？')) return;
        try {
          const localRecords = validate(JSON.parse(localStorage.getItem(storageKey) || '[]'));
          const existing = new Set(records.map(record=>record.id));
          onPersist(persist([...records,...localRecords.filter(record=>!existing.has(record.id))]),()=>{
            migration.remove();
            notify('この端末の旧記録を取り込みました。');
          });
        } catch { notify('旧記録を読み込めませんでした。',true); }
      });
      migration.id = legacyButtonId;
      $('export').parentElement.append(migration);
    }
  } catch {}
}
function passwordSettings(student) {
  const details = node('details',undefined,'classroom');
  details.innerHTML = `
    <summary>パスワードを変更</summary>
    <form>
      <input name="username" autocomplete="username" hidden>
      <label>現在のパスワード<input name="currentPassword" type="password" autocomplete="current-password" maxlength="128" required></label>
      <label>新しいパスワード<input name="newPassword" type="password" autocomplete="new-password" minlength="15" maxlength="128" required></label>
      <label>新しいパスワード（確認）<input name="confirmation" type="password" autocomplete="new-password" minlength="15" maxlength="128" required></label>
      <p class="muted">新しいパスワードは15文字以上にしてください。変更すると、ほかの端末では再ログインが必要になります。</p>
      <button class="primary">変更する</button>
      <p class="feedback" role="status"></p>
    </form>`;
  const form = details.querySelector('form');
  form.elements.username.value = student.id;
  const status = details.querySelector('[role="status"]');
  form.addEventListener('submit',async event=>{
    event.preventDefault();
    const values = new FormData(form);
    const currentPassword = values.get('currentPassword');
    const newPassword = values.get('newPassword');
    if (newPassword !== values.get('confirmation')) {
      feedback(status,'新しいパスワードと確認欄が一致していません。',true);
      return;
    }
    const submit = form.querySelector('button');
    submit.disabled = true;
    feedback(status,'変更中…');
    try {
      await api('/api/password',{currentPassword,newPassword},student.id);
      for (const input of form.querySelectorAll('input[type="password"]')) input.value = '';
      feedback(status,'パスワードを変更しました。');
    } catch (failure) {
      feedback(status,failure.message,true);
    } finally { submit.disabled = false; }
  });
  return details;
}
async function showTeacher() {
  const signIn = '/signin-with-chatgpt?return_to=%2Fadmin';
  classroomRoot.innerHTML = formFields + '<section class="card"><h1>講師用の管理画面</h1><p>アカウントを確認しています…</p></section>';
  let students;
  try { ({students} = await api('/api/teacher/students')); }
  catch (failure) {
    classroomRoot.innerHTML = formFields + '<section class="card classroom-login"><h1>講師用の管理画面</h1><p id="teacherLoginStatus"></p><div class="actions"><a class="action primary" href="'+signIn+'" target="_top">ChatGPTで講師ログイン</a><a href="/">生徒ログインへ</a></div></section>';
    $('teacherLoginStatus').textContent = failure.status===403 ? 'サイト所有者のChatGPTアカウントでログインしてください。' : failure.message;
    return;
  }
  classroomRoot.innerHTML = formFields + `
    <section class="hero"><h1>講師用の管理画面</h1><p>生徒の演習結果を確認し、コメントを送れます。</p></section>
    <div class="layout">
      <section class="card checklist-card">
        <h2>生徒の演習状況</h2>
        <div class="fields"><label>生徒<select id="studentList"></select></label></div>
        <p id="teacherStatus" class="feedback" role="status"></p>
        <div id="studentResult" hidden>
          <p id="studentTotal"></p>
          <h2>演習チェック</h2><div id="studentChecklist"></div>
          <h2>演習履歴</h2><div id="studentAttempts"></div>
          <h2>コメント</h2><div id="studentComments"></div>
          <form id="teacherComment">
            <label>生徒に送るコメント<textarea name="body" required maxlength="2000" rows="4"></textarea></label>
            <button class="primary">送信</button>
          </form>
        </div>
      </section>
      <aside class="card">
        <h2>生徒アカウントを追加</h2>
        <form id="issueStudent">
          <label>表示名<input name="name" required maxlength="60"></label>
          <label>生徒ID<input name="id" required minlength="3" maxlength="32" pattern="[a-zA-Z0-9_\\-]{3,32}" placeholder="例 student01" autocapitalize="none" spellcheck="false"></label>
          <button class="primary">ID・パスワードを発行</button>
        </form>
        <p id="issueStatus" class="feedback" role="status"></p>
        <div id="issued" hidden></div>
        <div class="actions"><a href="/">生徒ログインへ</a><a href="/signout-with-chatgpt?return_to=%2F" target="_top">講師ログアウト</a></div>
      </aside>
    </div>`;
  const select = $('studentList');
  let selected = '';
  let requestNumber = 0;
  function refreshStudents() {
    options(select,[['','生徒を選択'],...students.map(student=>[student.id,student.name+'（'+student.id+'）'])]);
    select.value = selected;
  }
  async function openStudent(id, message = '') {
    const number = ++requestNumber;
    selected = id;
    select.value = id;
    $('studentResult').hidden = true;
    feedback($('teacherStatus'),id ? '読み込み中…' : '');
    if (!id) return;
    try {
      const info = await api('/api/teacher/students/'+id);
      if (number !== requestNumber) return;
      const attempts = validate(info.records);
      const total = attempts.map(countRecord).reduce((sum,row)=>({
        right:sum.right+row.right,total:sum.total+row.total
      }),{right:0,total:0});
      $('studentTotal').textContent = attempts.length+'回の演習 · '+total.right+' / '+total.total+' 正解（'+percentage(total.right,total.total)+'）';
      renderChecklist($('studentChecklist'),attempts);
      renderEntries($('studentAttempts'),attempts,true,true);
      renderComments($('studentComments'),info.comments,'コメントはまだありません。');
      $('teacherComment').reset();
      $('studentResult').hidden = false;
      feedback($('teacherStatus'),message);
    } catch (failure) {
      if (number === requestNumber) feedback($('teacherStatus'),failure.message,true);
    }
  }
  refreshStudents();
  select.addEventListener('change',()=>openStudent(select.value));
  $('issueStudent').addEventListener('submit',async event=>{
    event.preventDefault();
    const form = event.currentTarget;
    const submit = form.querySelector('button');
    submit.disabled = true;
    $('issued').hidden = true;
    $('issued').replaceChildren();
    feedback($('issueStatus'),'発行中…');
    try {
      const values = new FormData(form);
      const issued = await api('/api/teacher/students',{id:values.get('id'),name:values.get('name')});
      const copy = '生徒ログイン '+location.origin+'/\nID '+issued.id+'\nパスワード '+issued.password;
      const details = $('issued');
      details.append(node('p','このパスワードは発行時にだけ表示されます。'),
        node('p','ID '+issued.id,'credential'),node('p','パスワード '+issued.password,'credential'),
        button('ログイン情報をコピー',async ()=>{
          try { await navigator.clipboard.writeText(copy); feedback($('issueStatus'),'コピーしました。'); }
          catch { feedback($('issueStatus'),'画面に表示されたIDとパスワードを選択してコピーしてください。',true); }
        }));
      details.hidden = false;
      feedback($('issueStatus'),'アカウントを発行しました。');
      students.push({id:issued.id,name:issued.name});
      students.sort((first,second)=>first.name.localeCompare(second.name,'ja'));
      form.reset();
      refreshStudents();
      await openStudent(issued.id);
    } catch (failure) { feedback($('issueStatus'),failure.message,true); }
    finally { submit.disabled = false; }
  });
  $('teacherComment').addEventListener('submit',async event=>{
    event.preventDefault();
    const form = event.currentTarget;
    const submit = form.querySelector('button');
    const id = selected;
    submit.disabled = true;
    try {
      await api('/api/teacher/students/'+id+'/comments',{body:new FormData(form).get('body')});
      if (selected===id) await openStudent(id,'コメントを送りました。');
    } catch (failure) {
      if (selected===id) feedback($('teacherStatus'),failure.message,true);
    } finally { submit.disabled = false; }
  });
}
if (teacherView) showTeacher();
else {
  classroomRoot.append(node('p','ログインを確認しています…','muted'));
  api('/api/session').then(({student})=>showStudent(student))
    .catch(failure=>showStudentLogin(failure.status===401 ? '' : failure.message));
}
