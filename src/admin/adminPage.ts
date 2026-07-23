export function renderAdminPage(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>App Data MCP 管理后台</title>
  <style>
    :root { color-scheme: light; --blue:#2563eb; --line:#e2e8f0; --muted:#64748b; --bg:#f8fafc; --danger:#b91c1c; }
    * { box-sizing:border-box; }
    body { margin:0; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; color:#0f172a; background:var(--bg); }
    button,input,textarea,select { font:inherit; }
    button { cursor:pointer; }
    .hidden { display:none !important; }
    .login { max-width:420px; margin:10vh auto; padding:32px; background:white; border:1px solid var(--line); border-radius:16px; box-shadow:0 12px 35px #0f172a12; }
    .login h1 { margin-top:0; }
    label { display:block; margin:14px 0 6px; font-size:13px; font-weight:650; }
    input,textarea,select { width:100%; padding:10px 12px; border:1px solid #cbd5e1; border-radius:8px; background:white; }
    .primary { border:0; border-radius:8px; padding:10px 16px; color:white; background:var(--blue); font-weight:650; }
    .login .primary { width:100%; margin-top:20px; }
    .error { color:var(--danger); min-height:22px; font-size:13px; }
    header { height:64px; padding:0 24px; display:flex; align-items:center; justify-content:space-between; color:white; background:#0f172a; }
    header h1 { font-size:18px; margin:0; }
    header button { color:#cbd5e1; background:transparent; border:1px solid #475569; border-radius:7px; padding:7px 10px; }
    .layout { display:grid; grid-template-columns:220px minmax(0,1fr); min-height:calc(100vh - 64px); }
    nav { padding:20px 12px; border-right:1px solid var(--line); background:white; }
    nav button { display:block; width:100%; padding:11px 14px; margin-bottom:6px; text-align:left; border:0; border-radius:8px; background:transparent; }
    nav button.active { color:#1d4ed8; background:#eff6ff; font-weight:700; }
    main { min-width:0; padding:24px; }
    .toolbar { display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-bottom:16px; }
    .toolbar input { max-width:360px; }
    .toolbar #domain-filter { max-width:240px; }
    .toolbar select { width:auto; min-width:180px; }
    .card { width:100%; overflow:auto; border:1px solid var(--line); border-radius:12px; background:white; }
    table { min-width:100%; table-layout:fixed; border-collapse:collapse; font-size:13px; }
    th,td { overflow:hidden; padding:11px 12px; border-bottom:1px solid var(--line); text-align:left; text-overflow:ellipsis; vertical-align:top; }
    th { white-space:nowrap; color:#475569; background:#f8fafc; }
    th { position:relative; }
    th.sortable { cursor:pointer; user-select:none; }
    th.sortable:hover { color:#1d4ed8; background:#eff6ff; }
    .resize-handle { position:absolute; z-index:2; top:0; right:-4px; width:9px; height:100%; cursor:col-resize; touch-action:none; }
    .resize-handle::after { content:""; position:absolute; top:20%; bottom:20%; left:4px; width:1px; background:#cbd5e1; }
    .resize-handle:hover::after,body.resizing .resize-handle::after { background:#2563eb; }
    body.resizing { cursor:col-resize; user-select:none; }
    td.title { min-width:240px; font-weight:600; }
    .muted { color:var(--muted); font-size:12px; font-weight:400; }
    .pill { display:inline-block; padding:3px 7px; border-radius:999px; color:#166534; background:#dcfce7; font-size:11px; }
    .pill.off { color:#475569; background:#e2e8f0; }
    .link-button { border:0; color:#2563eb; background:transparent; padding:2px 4px; }
    .secondary { border:1px solid var(--line); border-radius:8px; padding:9px 12px; background:white; }
    .secondary:disabled { cursor:not-allowed; opacity:.5; }
    .selected-count { color:var(--muted); font-size:13px; }
    .instructions-panel { margin-bottom:16px; padding:18px; border:1px solid var(--line); border-radius:12px; background:white; }
    .instructions-panel h2 { margin:0 0 6px; font-size:17px; }
    .instructions-panel textarea { margin-top:12px; font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace; }
    .instructions-footer { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-top:10px; }
    .pager { display:flex; justify-content:space-between; padding:12px; color:var(--muted); font-size:13px; }
    .pager button { border:1px solid var(--line); border-radius:7px; padding:6px 10px; background:white; }
    dialog { width:min(620px,calc(100vw - 32px)); border:0; border-radius:14px; padding:0; box-shadow:0 20px 60px #0f172a40; }
    dialog::backdrop { background:#0f172a80; }
    .modal { padding:24px; }
    .modal h2 { margin-top:0; }
    .actions { display:flex; justify-content:flex-end; gap:10px; margin-top:20px; }
    .actions button { padding:9px 14px; border:1px solid var(--line); border-radius:8px; background:white; }
    .actions .primary { color:white; background:var(--blue); border-color:var(--blue); }
    .detail-head { display:flex; justify-content:space-between; gap:16px; align-items:flex-start; }
    .detail-head h2 { margin-bottom:4px; }
    .detail-body { max-height:70vh; overflow:auto; padding-right:4px; }
    .detail-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px; margin:16px 0; }
    .detail-grid div { padding:10px; border:1px solid var(--line); border-radius:8px; }
    details { margin:10px 0; border:1px solid var(--line); border-radius:8px; background:#fff; }
    summary { cursor:pointer; padding:10px 12px; font-weight:650; background:#f8fafc; }
    pre { max-height:360px; overflow:auto; margin:0; padding:12px; white-space:pre-wrap; overflow-wrap:anywhere; font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace; }
    @media (max-width:760px) { .layout{grid-template-columns:1fr} nav{display:flex;gap:6px;overflow:auto;border-right:0;border-bottom:1px solid var(--line)} nav button{min-width:max-content;margin:0} main{padding:14px}.card{overflow:auto} }
  </style>
</head>
<body>
  <section id="login" class="login hidden">
    <h1>MCP 管理后台</h1>
    <p class="muted">使用 Metabase 管理员账号登录。普通用户无法进入后台。</p>
    <form id="login-form">
      <label for="username">Metabase 账号</label><input id="username" name="username" type="email" autocomplete="username" required />
      <label for="password">密码</label><input id="password" name="password" type="password" autocomplete="current-password" required />
      <button class="primary" type="submit">登录</button>
      <p id="login-error" class="error"></p>
    </form>
  </section>
  <section id="app" class="hidden">
    <header><h1>App Data MCP 管理后台</h1><div><span id="admin-user"></span>　<button id="logout">退出</button></div></header>
    <div class="layout">
      <nav>
        <button data-tab="metabase" class="active">Metabase 元信息</button>
        <button data-tab="posthog">PostHog 元信息</button>
        <button data-tab="tools">MCP 工具管理</button>
        <button data-tab="audit">审计日志</button>
      </nav>
      <main>
        <div class="toolbar"><input id="search" placeholder="按标题或资产 ID 搜索" /><input id="domain-filter" list="domain-options" placeholder="搜索或选择业务域" aria-label="业务域筛选" autocomplete="off" /><datalist id="domain-options"></datalist><select id="type-filter" aria-label="类型筛选"><option value="">全部类型</option></select><select id="published-filter" aria-label="开放状态筛选"><option value="">全部开放状态</option><option value="true">已开放</option><option value="false">未开放</option></select><button id="bulk-open" class="secondary" disabled>批量开放</button><button id="bulk-close" class="secondary" disabled>批量关闭</button><span id="selected-count" class="selected-count"></span></div>
        <section id="tool-instructions-panel" class="instructions-panel hidden"><h2>MCP 全局说明 instructions</h2><p class="muted">AI 客户端连接 MCP 时会收到这段全局说明。关键权限和安全限制仍由服务端代码强制执行。</p><textarea id="global-instructions" rows="7" maxlength="20000" aria-label="MCP 全局说明"></textarea><div class="instructions-footer"><span id="instructions-status" class="muted"></span><button id="save-instructions" class="primary">保存全局说明</button></div><details open><summary>当前实际发送给 AI 的说明（包含工具开关状态）</summary><pre id="effective-instructions"></pre></details></section>
        <div class="card"><table id="data-table"><colgroup id="table-columns"></colgroup><thead id="thead"></thead><tbody id="tbody"></tbody></table><div class="pager"><span id="summary"></span><span><button id="prev">上一页</button> <button id="next">下一页</button></span></div></div>
      </main>
    </div>
  </section>
  <dialog id="editor"><form method="dialog" class="modal" id="edit-form"><h2>编辑元信息</h2><input id="edit-id" type="hidden" />
    <label for="edit-title">标题</label><input id="edit-title" required />
    <label for="edit-description">描述</label><textarea id="edit-description" rows="4"></textarea>
    <label for="edit-domain">业务域</label><input id="edit-domain" />
    <label for="edit-tags">标签（逗号分隔）</label><input id="edit-tags" />
    <div class="actions"><button value="cancel">取消</button><button id="save" value="default" class="primary">保存</button></div>
  </form></dialog>
  <dialog id="detail"><div class="modal"><div class="detail-head"><div><h2 id="detail-title">元信息详情</h2><div id="detail-id" class="muted"></div></div><button id="detail-close" class="secondary">关闭</button></div><div id="detail-body" class="detail-body"></div></div></dialog>
  <script>
    const state={csrf:'',tab:'metabase',offset:0,limit:50,total:0,items:[],sort:'updated_at',order:'desc',toolSort:'category',toolOrder:'asc',selected:new Set()};
    const $=id=>document.getElementById(id);
    async function api(url,options={}){const headers={...(options.headers||{})};if(state.csrf)headers['x-csrf-token']=state.csrf;if(options.body)headers['content-type']='application/json';const response=await fetch(url,{...options,headers});const body=await response.json().catch(()=>({error:'请求失败'}));if(!response.ok)throw new Error(body.error||body.message||'请求失败');return body;}
    async function boot(){try{const session=await api('/admin/api/session');state.csrf=session.csrfToken;showApp(session.user);await loadFilters();await load();}catch{$('login').classList.remove('hidden');}}
    function showApp(user){$('login').classList.add('hidden');$('app').classList.remove('hidden');$('admin-user').textContent=user;}
    $('login-form').addEventListener('submit',async event=>{event.preventDefault();$('login-error').textContent='';try{const data=await api('/admin/api/login',{method:'POST',body:JSON.stringify({username:$('username').value,password:$('password').value})});state.csrf=data.csrfToken;showApp(data.user);await loadFilters();await load();}catch(error){$('login-error').textContent=error.message;}});
    $('logout').addEventListener('click',async()=>{await api('/admin/api/logout',{method:'POST'}).catch(()=>{});location.reload();});
    document.querySelectorAll('nav button').forEach(button=>button.addEventListener('click',async()=>{document.querySelectorAll('nav button').forEach(item=>item.classList.remove('active'));button.classList.add('active');state.tab=button.dataset.tab;state.offset=0;state.selected.clear();const assetTab=state.tab==='metabase'||state.tab==='posthog';$('search').placeholder=state.tab==='audit'?'按用户邮箱搜索':state.tab==='tools'?'按工具名称、标题或描述搜索':'按标题或资产 ID 搜索';$('domain-filter').classList.toggle('hidden',!assetTab);$('type-filter').classList.toggle('hidden',!assetTab);$('published-filter').classList.toggle('hidden',!assetTab);$('tool-instructions-panel').classList.toggle('hidden',state.tab!=='tools');updateBulkActions();if(assetTab)await loadFilters();await load();}));
    let filterTimer;
    function scheduleFilterLoad(delay=0){clearTimeout(filterTimer);filterTimer=setTimeout(()=>{state.offset=0;if(state.tab==='metabase'||state.tab==='posthog'){state.selected.clear();updateBulkActions();}load();},delay);}
    $('search').addEventListener('input',()=>scheduleFilterLoad(300));
    $('search').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();scheduleFilterLoad();}});
    $('domain-filter').addEventListener('input',()=>scheduleFilterLoad(300));
    $('domain-filter').addEventListener('change',()=>scheduleFilterLoad());
    $('domain-filter').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();scheduleFilterLoad();}});
    $('type-filter').addEventListener('change',()=>scheduleFilterLoad());
    $('published-filter').addEventListener('change',()=>scheduleFilterLoad());
    $('prev').addEventListener('click',()=>{state.offset=Math.max(0,state.offset-state.limit);load();});
    $('next').addEventListener('click',()=>{if(state.offset+state.limit<state.total){state.offset+=state.limit;load();}});
    async function load(){if(state.tab==='audit')await loadAudit();else if(state.tab==='tools')await loadTools();else await loadAssets();}
    async function loadAssets(){const params=new URLSearchParams({platform:state.tab,type:$('type-filter').value,businessDomain:$('domain-filter').value,published:$('published-filter').value,query:$('search').value,limit:String(state.limit),offset:String(state.offset),sort:state.sort,order:state.order});const data=await api('/admin/api/assets?'+params);state.total=data.total;state.items=data.assets;$('thead').innerHTML='<tr><th><input id="select-all" type="checkbox" aria-label="选择当前页" /></th><th class="sortable" data-sort="published">开放</th><th class="sortable" data-sort="title">元信息</th><th class="sortable" data-sort="type">类型</th><th class="sortable" data-sort="business_domain">业务域</th><th class="sortable" data-sort="active">状态</th><th class="sortable" data-sort="last_synced_at">同步时间</th><th>操作</th></tr>';bindSortHeaders();setupResizableColumns('assets',[48,82,320,120,190,100,190,110]);bindSelectAll();$('tbody').replaceChildren(...data.assets.map(renderAssetRow));updatePager();updateBulkActions();}
    async function loadDomains(){const current=$('domain-filter').value;const data=await api('/admin/api/domains?platform='+encodeURIComponent(state.tab));const options=$('domain-options');options.replaceChildren(...data.domains.map(domain=>{const option=document.createElement('option');option.value=domain;return option;}));$('domain-filter').value=data.domains.includes(current)?current:'';}
    async function loadTypes(){const current=$('type-filter').value;const data=await api('/admin/api/types?platform='+encodeURIComponent(state.tab));const select=$('type-filter');select.replaceChildren(new Option('全部类型',''),...data.types.map(type=>new Option(type,type)));select.value=data.types.includes(current)?current:'';}
    async function loadFilters(){await Promise.all([loadDomains(),loadTypes()]);}
    function renderAssetRow(item,index){const row=document.createElement('tr');const select=document.createElement('input');select.type='checkbox';select.checked=state.selected.has(item.asset.id);select.disabled=!item.active;select.setAttribute('aria-label','选择 '+item.asset.title);select.addEventListener('change',()=>{if(select.checked)state.selected.add(item.asset.id);else state.selected.delete(item.asset.id);syncSelectAll();updateBulkActions();});const selectCell=document.createElement('td');selectCell.append(select);const publish=document.createElement('input');publish.type='checkbox';publish.checked=item.published;publish.disabled=!item.active;publish.addEventListener('change',async()=>{publish.disabled=true;try{await api('/admin/api/assets/'+encodeURIComponent(item.asset.id),{method:'PATCH',body:JSON.stringify({published:publish.checked})});item.published=publish.checked;}catch(error){publish.checked=!publish.checked;alert(error.message);}finally{publish.disabled=!item.active;}});const c0=document.createElement('td');c0.append(publish);const c1=document.createElement('td');c1.className='title';c1.textContent=item.asset.title;const id=document.createElement('div');id.className='muted';id.textContent=item.asset.id;c1.append(id);const cells=[selectCell,c0,c1,textCell(item.asset.type),textCell(item.asset.businessDomain||'—'),statusCell(item.active),textCell(formatDate(item.lastSyncedAt))];const detail=document.createElement('button');detail.className='link-button';detail.textContent='查看';detail.addEventListener('click',()=>openDetail(index));const edit=document.createElement('button');edit.className='link-button';edit.textContent='编辑';edit.addEventListener('click',()=>openEditor(index));const action=document.createElement('td');action.append(detail,edit);cells.push(action);row.append(...cells);return row;}
    async function loadAudit(){const params=new URLSearchParams({user:$('search').value,limit:String(state.limit),offset:String(state.offset)});const data=await api('/admin/api/audit?'+params);state.total=data.total;$('thead').innerHTML='<tr><th>时间</th><th>用户</th><th>客户端</th><th>工具</th><th>资产</th><th>状态</th><th>行数</th><th>耗时</th></tr>';setupResizableColumns('audit',[190,220,130,170,260,110,80,110]);$('tbody').replaceChildren(...data.logs.map(log=>{const row=document.createElement('tr');[formatDate(log.createdAt),log.userEmail||'—',log.aiClient||'—',log.toolName,log.assetId||'—',log.status,log.rowCount??'—',(log.durationMs??'—')+(log.durationMs===undefined?'':' ms')].forEach(value=>row.append(textCell(String(value))));return row;}));updatePager();}
    async function loadTools(){const data=await api('/admin/api/tools');$('global-instructions').value=data.globalInstructions;$('effective-instructions').textContent=data.effectiveInstructions;$('instructions-status').textContent=data.globalInstructions.length+' 个字符';const query=$('search').value.trim().toLowerCase();const tools=data.tools.filter(tool=>!query||[tool.name,tool.title,tool.description,tool.category,tool.usageNotes].join(' ').toLowerCase().includes(query));tools.sort((left,right)=>compareToolValues(left,right,state.toolSort)*(state.toolOrder==='asc'?1:-1));state.total=tools.length;state.items=tools;const page=tools.slice(state.offset,state.offset+state.limit);$('thead').innerHTML='<tr><th class="sortable" data-tool-sort="enabled">开放</th><th class="sortable" data-tool-sort="title">工具</th><th class="sortable" data-tool-sort="category">分类</th><th class="sortable" data-tool-sort="riskLevel">风险</th><th class="sortable" data-tool-sort="description">详情描述</th><th class="sortable" data-tool-sort="updatedAt">更新时间</th><th class="sortable" data-tool-sort="updatedBy">更新人</th><th>操作</th></tr>';bindToolSortHeaders();setupResizableColumns('tools',[82,240,130,90,420,180,200,90]);$('tbody').replaceChildren(...page.map(renderToolRow));updatePager();updateBulkActions();}
    function renderToolRow(tool){const row=document.createElement('tr');const enabled=document.createElement('input');enabled.type='checkbox';enabled.checked=tool.enabled;enabled.setAttribute('aria-label',(tool.enabled?'关闭 ':'开放 ')+tool.name);enabled.addEventListener('change',async()=>{const next=enabled.checked;if(!confirm('确认'+(next?'开放':'关闭')+' MCP 工具 '+tool.name+'？')){enabled.checked=!next;return;}enabled.disabled=true;try{const updated=await api('/admin/api/tools/'+encodeURIComponent(tool.name),{method:'PATCH',body:JSON.stringify({enabled:next})});tool.enabled=updated.enabled;await loadTools();}catch(error){enabled.checked=!next;alert(error.message);}finally{enabled.disabled=false;}});const openCell=document.createElement('td');openCell.append(enabled);const toolCell=document.createElement('td');toolCell.className='title';toolCell.textContent=tool.title;const name=document.createElement('div');name.className='muted';name.textContent=tool.name;toolCell.append(name);const risk=document.createElement('td');const badge=document.createElement('span');badge.className='pill'+(tool.riskLevel==='high'?' off':'');badge.textContent=tool.riskLevel;risk.append(badge);const detail=document.createElement('button');detail.className='link-button';detail.textContent='查看';detail.addEventListener('click',()=>openToolDetail(tool));const action=document.createElement('td');action.append(detail);row.append(openCell,toolCell,textCell(tool.category),risk,textCell(tool.description),textCell(formatDate(tool.updatedAt)),textCell(tool.updatedBy||'—'),action);return row;}
    function textCell(value){const cell=document.createElement('td');cell.textContent=value;return cell;}
    function statusCell(active){const cell=document.createElement('td');const badge=document.createElement('span');badge.className='pill'+(active?'':' off');badge.textContent=active?'有效':'已下线';cell.append(badge);return cell;}
    function updatePager(){$('summary').textContent='共 '+state.total+' 条，当前 '+(state.total?state.offset+1:0)+'-'+Math.min(state.offset+state.limit,state.total);$('prev').disabled=state.offset===0;$('next').disabled=state.offset+state.limit>=state.total;}
    function formatDate(value){return value?new Date(value).toLocaleString('zh-CN'):'—';}
    function openEditor(index){const item=state.items[index];$('edit-id').value=item.asset.id;$('edit-title').value=item.asset.title;$('edit-description').value=item.asset.description||'';$('edit-domain').value=item.asset.businessDomain||'';$('edit-tags').value=(item.asset.tags||[]).join(', ');$('editor').showModal();}
    function bindSortHeaders(){document.querySelectorAll('#thead th[data-sort]').forEach(header=>{const field=header.dataset.sort;if(field===state.sort)header.textContent+=' '+(state.order==='asc'?'▲':'▼');header.addEventListener('click',()=>{if(state.sort===field)state.order=state.order==='asc'?'desc':'asc';else{state.sort=field;state.order=field==='title'||field==='type'||field==='business_domain'?'asc':'desc';}state.offset=0;loadAssets();});});}
    function bindToolSortHeaders(){document.querySelectorAll('#thead th[data-tool-sort]').forEach(header=>{const field=header.dataset.toolSort;if(field===state.toolSort)header.textContent+=' '+(state.toolOrder==='asc'?'▲':'▼');header.addEventListener('click',()=>{if(state.toolSort===field)state.toolOrder=state.toolOrder==='asc'?'desc':'asc';else{state.toolSort=field;state.toolOrder='asc';}state.offset=0;loadTools();});});}
    function compareToolValues(left,right,field){const a=left[field]??'';const b=right[field]??'';if(typeof a==='boolean'&&typeof b==='boolean')return Number(a)-Number(b);return String(a).localeCompare(String(b),'zh-CN');}
    function setupResizableColumns(key,defaults){const storageKey='app-data-mcp-column-widths-'+key;let widths=[...defaults];try{const saved=JSON.parse(localStorage.getItem(storageKey)||'null');if(Array.isArray(saved)&&saved.length===defaults.length)widths=saved.map((value,index)=>Number.isFinite(value)?clampWidth(value):defaults[index]);}catch{}const group=$('table-columns');group.replaceChildren(...widths.map(width=>{const col=document.createElement('col');col.style.width=width+'px';return col;}));const table=$('data-table');const updateTableWidth=()=>{table.style.width=widths.reduce((sum,width)=>sum+width,0)+'px';};updateTableWidth();const headers=Array.from($('thead').querySelectorAll('th'));headers.forEach((header,index)=>{const handle=document.createElement('span');handle.className='resize-handle';handle.setAttribute('aria-label','调整列宽');handle.addEventListener('click',event=>event.stopPropagation());handle.addEventListener('pointerdown',event=>{event.preventDefault();event.stopPropagation();const startX=event.clientX;const startWidth=widths[index];document.body.classList.add('resizing');const move=moveEvent=>{widths[index]=clampWidth(startWidth+moveEvent.clientX-startX);group.children[index].style.width=widths[index]+'px';updateTableWidth();};const stop=()=>{document.body.classList.remove('resizing');document.removeEventListener('pointermove',move);document.removeEventListener('pointerup',stop);try{localStorage.setItem(storageKey,JSON.stringify(widths));}catch{}};document.addEventListener('pointermove',move);document.addEventListener('pointerup',stop);});header.append(handle);});}
    function clampWidth(value){return Math.min(Math.max(Math.round(value),48),640);}
    function bindSelectAll(){const checkbox=$('select-all');checkbox.addEventListener('change',()=>{state.items.filter(item=>item.active).forEach(item=>{if(checkbox.checked)state.selected.add(item.asset.id);else state.selected.delete(item.asset.id);});loadAssets();});syncSelectAll();}
    function syncSelectAll(){const checkbox=$('select-all');if(!checkbox)return;const selectable=state.items.filter(item=>item.active);const selectedCount=selectable.filter(item=>state.selected.has(item.asset.id)).length;checkbox.checked=selectable.length>0&&selectedCount===selectable.length;checkbox.indeterminate=selectedCount>0&&selectedCount<selectable.length;}
    function updateBulkActions(){const count=state.selected.size;const assetTab=state.tab==='metabase'||state.tab==='posthog';$('bulk-open').disabled=count===0;$('bulk-close').disabled=count===0;$('selected-count').textContent=count?'已选择 '+count+' 条':'';$('bulk-open').classList.toggle('hidden',!assetTab);$('bulk-close').classList.toggle('hidden',!assetTab);$('selected-count').classList.toggle('hidden',!assetTab);}
    async function bulkPublish(published){const ids=Array.from(state.selected);if(!ids.length)return;if(!confirm('确认'+(published?'开放':'关闭')+'所选 '+ids.length+' 条元信息？'))return;try{const result=await api('/admin/api/assets',{method:'PATCH',body:JSON.stringify({assetIds:ids,published})});state.selected.clear();alert('已更新 '+result.updated+' 条');await loadAssets();}catch(error){alert(error.message);}}
    $('bulk-open').addEventListener('click',()=>bulkPublish(true));$('bulk-close').addEventListener('click',()=>bulkPublish(false));
    function openDetail(index){const item=state.items[index];const asset=item.asset;$('detail-title').textContent=asset.title;$('detail-id').textContent=asset.id;const body=$('detail-body');body.replaceChildren();const grid=document.createElement('div');grid.className='detail-grid';[['平台',asset.platform],['类型',asset.type],['业务域',asset.businessDomain||'—'],['负责人',asset.owner||'—'],['是否开放',item.published?'是':'否'],['状态',item.active?'有效':'已下线'],['源更新时间',asset.updatedAt||'—'],['同步时间',item.lastSyncedAt||'—']].forEach(pair=>{const cell=document.createElement('div');const label=document.createElement('div');label.className='muted';label.textContent=pair[0];const value=document.createElement('div');value.textContent=pair[1];cell.append(label,value);grid.append(cell);});body.append(grid);if(asset.url){const link=document.createElement('a');link.href=asset.url;link.target='_blank';link.rel='noopener noreferrer';link.textContent=asset.url;const wrapper=document.createElement('p');wrapper.append('来源链接：',link);body.append(wrapper);}appendDetailSection(body,'描述',asset.description);appendDetailSection(body,'标签',asset.tags);appendDetailSection(body,'查询定义 / SQL',asset.queryText);appendDetailSection(body,'字段 columns',asset.columns);appendDetailSection(body,'参数 parameters',asset.parameters);appendDetailSection(body,'Dashboard 参数映射',asset.dashboardParameterMappings);appendDetailSection(body,'子资产 children',asset.children);appendDetailSection(body,'来源与血缘 sourceRefs',asset.sourceRefs);appendDetailSection(body,'权限快照 access',asset.access);appendDetailSection(body,'警告 warnings',asset.warnings);appendDetailSection(body,'样例数据 sampleData',asset.sampleData);appendDetailSection(body,'完整原始 JSON',asset,true);$('detail').showModal();}
    function openToolDetail(tool){$('detail-title').textContent=tool.title;$('detail-id').textContent=tool.name;const body=$('detail-body');body.replaceChildren();const grid=document.createElement('div');grid.className='detail-grid';[['分类',tool.category],['风险等级',tool.riskLevel],['开放状态',tool.enabled?'已开放':'已关闭'],['更新时间',formatDate(tool.updatedAt)],['更新人',tool.updatedBy||'—']].forEach(pair=>{const cell=document.createElement('div');const label=document.createElement('div');label.className='muted';label.textContent=pair[0];const value=document.createElement('div');value.textContent=pair[1];cell.append(label,value);grid.append(cell);});body.append(grid);appendDetailSection(body,'工具详情描述',tool.description,true);appendDetailSection(body,'调用时机与注意事项',tool.usageNotes,true);appendDetailSection(body,'调用参数',tool.inputSchema,true);appendDetailSection(body,'生效说明','HTTP 模式下，新建的 MCP 请求会立即使用最新工具清单；stdio 或已经建立的长连接需要重新连接后生效。',true);appendDetailSection(body,'完整配置',tool);$('detail').showModal();}
    function appendDetailSection(parent,title,value,open=false){if(title==='完整原始 JSON'&&value?.type==='metric'&&value.metric)appendDetailSection(parent,'Metric 指标定义',value.metric,true);if(value===undefined||value===null||value===''||(Array.isArray(value)&&value.length===0))return;const details=document.createElement('details');details.open=open;const summary=document.createElement('summary');summary.textContent=title;const pre=document.createElement('pre');pre.textContent=typeof value==='string'?value:JSON.stringify(value,null,2);details.append(summary,pre);parent.append(details);}
    $('detail-close').addEventListener('click',()=>$('detail').close());
    $('global-instructions').addEventListener('input',()=>{$('instructions-status').textContent=$('global-instructions').value.length+' 个字符（未保存）';});
    $('save-instructions').addEventListener('click',async()=>{const button=$('save-instructions');button.disabled=true;try{const data=await api('/admin/api/tool-settings',{method:'PATCH',body:JSON.stringify({globalInstructions:$('global-instructions').value})});$('global-instructions').value=data.globalInstructions;$('effective-instructions').textContent=data.effectiveInstructions;$('instructions-status').textContent='已保存，'+data.globalInstructions.length+' 个字符';}catch(error){alert(error.message);}finally{button.disabled=false;}});
    $('edit-form').addEventListener('submit',async event=>{if(event.submitter?.value==='cancel')return;event.preventDefault();try{await api('/admin/api/assets/'+encodeURIComponent($('edit-id').value),{method:'PATCH',body:JSON.stringify({title:$('edit-title').value.trim(),description:$('edit-description').value.trim()||null,businessDomain:$('edit-domain').value.trim()||null,tags:$('edit-tags').value.split(',').map(value=>value.trim()).filter(Boolean)})});$('editor').close();await load();}catch(error){alert(error.message);}});
    boot();
  </script>
</body>
</html>`;
}
