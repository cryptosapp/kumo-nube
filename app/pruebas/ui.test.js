const {JSDOM}=require('jsdom');const fs=require('fs');const nodeCrypto=require('crypto');
const WWW=require('path').join(__dirname,'../android/app/src/main/assets/www/');
const html=fs.readFileSync(WWW+'index.html','utf8').replace('<script src="sellar.js"></script>','<script>'+fs.readFileSync(WWW+'sellar.js','utf8')+'</script>');
const espera=ms=>new Promise(r=>setTimeout(r,ms));
let fallos=0;const ok=(c,m)=>{console.log((c?'OK  ':'FALLO ')+m);if(!c)fallos++};
function crear(fetchMock,nativo){
  const errores=[];
  const dom=new JSDOM(html,{runScripts:'dangerously',pretendToBeVisual:true,url:'https://localhost/',beforeParse(w){
    w.fetch=fetchMock;if(nativo)w.KumoNative=nativo(w);
    Object.defineProperty(w,'crypto',{value:nodeCrypto.webcrypto});w.TextEncoder=TextEncoder;w.scrollTo=()=>{};w.Element.prototype.scrollIntoView=()=>{};
    w.addEventListener('error',e=>errores.push(e.message));
  }});
  dom.window.console.error=(...a)=>errores.push(a.join(' '));
  return {w:dom.window,d:dom.window.document,errores};
}
const click=(d,sel)=>{const e=typeof sel==='string'?d.querySelector(sel):sel;if(!e)throw new Error('no existe '+sel);e.click()};
const R=(status,data,headers)=>Promise.resolve({ok:status<400,status,json:()=>Promise.resolve(data),text:()=>Promise.resolve(data==null?'':JSON.stringify(data)),headers:{get:k=>(headers||{})[k.toLowerCase()]||null}});

(async()=>{
 // ---------- 1) Primera vez + demo
 {
  const barras=[],copias=[],billeteras=[];
  const {w,d,errores}=crear(()=>R(500,{}),w=>({estado:()=>JSON.stringify({enabled:false,permiso:'denied'}),barras:(c,l)=>barras.push(c),abrirUrl(){},http(){},copiar:t=>copias.push(t),abrirBilletera:u=>{billeteras.push(u);return u.startsWith('bitcoin:')}}));
  await espera(50);
  ok(d.getElementById('tuto').classList.contains('open'),'tutorial emergente al abrir por primera vez');
  ok(/vacía/.test(d.getElementById('tutoCuerpo').textContent),'el tutorial avisa que la app viene vacía');
  for(let i=0;i<5;i++)click(d,'#tutoSig');
  ok(d.getElementById('tutoN').textContent==='6'&&d.getElementById('tutoSig').disabled,'último paso bloqueado hasta marcar «Entendí»');
  ok(w.appBack()===true&&d.getElementById('tutoN').textContent==='5','atrás de Android retrocede en el tutorial');
  click(d,'#tutoSig');d.getElementById('tutoOk').checked=true;d.getElementById('tutoOk').dispatchEvent(new w.Event('change'));click(d,'#tutoSig');
  ok(!d.getElementById('tuto').classList.contains('open')&&w.__kumo.S.tuto===true,'tutorial completado y recordado');
  ok(d.getElementById('onb').classList.contains('open'),'bienvenida abierta en la primera ejecución');
  ok(d.querySelector('.paso.activo').dataset.paso==='hola','empieza en el saludo');
  click(d,'[data-paso="hola"] [data-ir="tema"]');
  ok(d.documentElement.dataset.tema==='pro'&&d.documentElement.dataset.estilo==='pro','tema Pro Grafito por defecto');
  ok(d.querySelector('#temas [data-tema="pro"]').classList.contains('sel'),'Pro marcado en el selector');
  click(d,'#temas [data-tema="pro-claro"]');ok(d.documentElement.dataset.estilo==='pro'&&barras.includes('#f5f6fa'),'Pro Porcelana aplicado con barras claras');
  click(d,'#temas [data-tema="dia"]');
  ok(d.documentElement.dataset.tema==='dia'&&d.documentElement.dataset.estilo==='manga','tema Neón Día aplicado');
  ok(barras.includes('#fff7ea'),'barras del sistema coloreadas por el tema');
  click(d,'#temas [data-tema="clasica"]');ok(d.documentElement.dataset.estilo==='clasica','tema Clásica sin estilo manga');
  click(d,'#temas [data-tema="noche"]');
  click(d,'[data-paso="tema"] [data-ir="inicio"]');
  click(d,'#onbDemo');await espera(50);
  ok(!d.getElementById('onb').classList.contains('open'),'demo cierra la bienvenida');
  ok(!d.getElementById('demoBanda').classList.contains('oculto'),'banda de demo visible');
  ok(/1.*034/.test(d.getElementById('total').textContent),'valor total demo: '+d.getElementById('total').textContent);
  ok(d.querySelectorAll('#decisiones .row').length>=1,'decisiones del último ciclo');
  ok(d.getElementById('modoPill').textContent==='SIMULACIÓN','pill de simulación');
  ok(d.getElementById('chLinea').getAttribute('d').length>100,'gráfico dibujado');
  click(d,'.nav [data-target="radar"]');await espera(30);
  ok(d.querySelectorAll('#radarLista .card').length===8,'radar con 8 monedas');
  click(d,'#radarFiltro [data-f="baratas"]');ok(d.querySelectorAll('#radarLista .card').length===2,'filtro RSI bajo (≤40) = SOL y PEPE');
  click(d,'#radarFiltro [data-f="todas"]');
  click(d,'#radarLista [data-analizar="SOL"]');await espera(30);
  ok(/INCORPORAR/.test(d.querySelector('#radarLista .analisis').textContent),'análisis IA con veredicto');
  click(d,'#radarLista [data-incluir="SOL"]');await espera(30);
  ok(d.getElementById('modal').classList.contains('open'),'modal de inclusión');
  d.getElementById('incPct').value='5';click(d,'#mSi');await espera(30);
  ok(w.__kumo.datos.config.objetivo.SOL===5,'SOL incluida con 5%');
  d.getElementById('radarQ').value='ADA';d.getElementById('radarForm').dispatchEvent(new w.Event('submit',{cancelable:true}));
  ok(/PEDIR DATOS DE ADA/.test(d.getElementById('radarAnalisis').textContent),'búsqueda sin datos ofrece pedirlos');
  click(d,'#radarLista [data-incluir="PEPE"]');await espera(30);
  ok(/NO INCORPORAR/.test(d.getElementById('mTexto').textContent),'advierte al incluir con veredicto negativo');click(d,'#mNo');
  click(d,'.nav [data-target="estrategia"]');await espera(20);
  ok(d.querySelectorAll('#reparto .alloc').length===3,'reparto con 3 monedas');
  click(d,'#perfiles [data-p="prudente"]');ok(d.querySelector('[data-p="monto_max"]').value==='10','perfil prudente aplicado');
  d.getElementById('repNuevo').value='link';click(d,'#repAgregar');ok(d.querySelectorAll('#reparto .alloc').length===4,'agregar LINK');
  click(d,'#estGuardar');await espera(30);ok(w.__kumo.datos.config.objetivo.LINK===5&&w.__kumo.datos.config.monto_max===10,'estrategia guardada');
  click(d,'.nav [data-target="cartera"]');await espera(30);
  ok(d.querySelectorAll('#activos .row').length===4&&d.querySelectorAll('#operaciones .row').length===2,'cartera y operaciones');
  click(d,'.nav [data-target="ia"]');await espera(30);ok(/Rebote/.test(d.getElementById('opiniones').textContent),'opiniones de la IA');
  click(d,'.nav [data-target="config"]');await espera(20);
  click(d,'#modoBtn');await espera(10);click(d,'#mSi');await espera(10);
  d.getElementById('confReal').value='real';click(d,'#mSi');await espera(30);
  ok(w.__kumo.datos.config.modo==='real','dinero real tras doble confirmación con «REAL»');
  const BTC='bc1qd9j45f4t0jwyhjhqh2kvz2cr7k8xye460rr2y7',XMR='447gTj6Hg6gaAEAUmjqfhqDZr1PziUTvbT4LYLpmLVnTNVFK6cqeqPfh6P4neMKLWX5jDXAr94fWHacJwDvjmCzBBH8wPBt';
  ok(d.getElementById('dirBtc').textContent===BTC&&d.getElementById('dirXmr').textContent===XMR,'direcciones de donación exactas');
  ok([...d.querySelectorAll('#donar img')].every(i=>require('fs').existsSync(WWW+i.getAttribute('src'))),'logos y QR de donación existen en la APK');
  click(d,'[data-copiar="dirXmr"]');ok(copias[0]===XMR&&/copiada/.test(d.getElementById('toast').textContent),'copiar dirección Monero');
  click(d,'[data-billetera^="bitcoin:"]');ok(billeteras[0]==='bitcoin:'+BTC,'abre billetera Bitcoin');
  click(d,'[data-billetera^="monero:"]');ok(/No hay billetera de Monero/.test(d.getElementById('toast').textContent),'avisa si no hay billetera Monero');
  click(d,'#temaChips [data-tema="dia"]');ok(d.documentElement.dataset.tema==='dia','cambio de tema desde Config');
  ok(w.appBack()===true&&d.querySelector('.screen.active').id==='panel','botón atrás vuelve al panel');
  ok(errores.length===0,'sin errores JS: '+errores.join(' | '));
 }
 // ---------- 2) Asistente: crear la nube
 {
  const nacl=require('tweetnacl');const kp=nacl.box.keyPair();const pk=Buffer.from(kp.publicKey).toString('base64');
  const secretos={},llamadas=[],sinToken=[],git=[];let creado=false,despachos=[];
  const appUrl='https://kumo-bot.amigo.workers.dev';
  const fetchMock=(url,o={})=>{
    const m=(o.method||'GET');llamadas.push(m+' '+url);
    const u=new URL(url);const p=u.pathname;
    if(u.host==='api.github.com'){
      if(p==='/repos/tradiabot/kumo-bot/releases/latest')return R(200,{tag_name:'v9.9.9',body:'Novedades de prueba',html_url:'https://github.com/tradiabot/kumo-bot/releases/tag/v9.9.9',assets:[{name:'KumoBot-v9.9.9.apk',browser_download_url:'https://github.com/tradiabot/kumo-bot/releases/download/v9.9.9/KumoBot-v9.9.9.apk'}]});
      const auth=(o.headers||{}).Authorization||'';if(!/^Bearer [A-Za-z0-9_-]{3,}$/.test(auth)||/undefined|null/.test(auth)){sinToken.push(m+' '+p);return R(p.startsWith('/repos/amigo/')?404:401,{message:'Not Found'})}
      if(p==='/repos/tradiabot/kumo-bot'&&m==='GET')return R(200,{default_branch:'main'});
      if(p==='/repos/tradiabot/kumo-bot/git/trees/main')return R(200,{tree:[{path:'runner',type:'tree',sha:'d1'},{path:'runner/exchanges.py',type:'blob',mode:'100644',sha:'nuevo1'},{path:'worker/src/index.ts',type:'blob',mode:'100644',sha:'igual2'},{path:'README.md',type:'blob',mode:'100644',sha:'readme'}]});
      if(p==='/repos/tradiabot/kumo-bot/git/blobs/nuevo1')return R(200,{content:'cHJp\nbnQoMSk=',encoding:'base64'});
      if(p==='/repos/amigo/kumo-nube/git/ref/heads/main')return R(200,{object:{sha:'base1'}});
      if(p==='/repos/amigo/kumo-nube/git/trees/base1')return R(200,{tree:[{path:'runner/exchanges.py',type:'blob',sha:'viejo1'},{path:'worker/src/index.ts',type:'blob',sha:'igual2'},{path:'kumo.json',type:'blob',sha:'k'}]});
      if(p==='/repos/amigo/kumo-nube/git/blobs'&&m==='POST'){git.push('blob:'+JSON.parse(o.body).content);return R(201,{sha:'blobN'})}
      if(p==='/repos/amigo/kumo-nube/git/trees'&&m==='POST'){const b=JSON.parse(o.body);git.push('tree:'+b.base_tree+':'+b.tree.map(x=>x.path+'='+x.sha).join(','));return R(201,{sha:'treeN'})}
      if(p==='/repos/amigo/kumo-nube/git/commits'&&m==='POST'){git.push('commit:'+JSON.parse(o.body).parents);return R(201,{sha:'comN'})}
      if(p==='/repos/amigo/kumo-nube/git/refs/heads/main'&&m==='PATCH'){git.push('ref:'+JSON.parse(o.body).sha);return R(200,{})}
      if(p==='/user')return R(200,{login:'amigo'},{'x-oauth-scopes':'repo, workflow'});
      if(p==='/repos/amigo/kumo-nube'&&m==='GET')return R(creado?200:404,creado?{default_branch:'main'}:{message:'Not Found'});
      if(p==='/repos/tradiabot/kumo-bot/generate'){creado=true;const b=JSON.parse(o.body);return R(b.private===true&&b.owner==='amigo'?201:400,{default_branch:'main'})}
      if(p.endsWith('/contents/.github/workflows/instalar.yml'))return R(200,{});
      if(p.endsWith('/actions/secrets/public-key'))return R(200,{key:pk,key_id:'k1'});
      if(p.includes('/actions/secrets/')&&m==='PUT'){const b=JSON.parse(o.body);const c=Buffer.from(b.encrypted_value,'base64');
        // abrir el sealed box como lo haría GitHub (libsodium)
        const epk=c.subarray(0,32),blake=require('blakejs');const nonce=blake.blake2b(Buffer.concat([epk,Buffer.from(kp.publicKey)]),null,24);
        const abierto=nacl.box.open(new Uint8Array(c.subarray(32)),nonce,new Uint8Array(epk),kp.secretKey);
        secretos[p.split('/').pop()]=abierto?Buffer.from(abierto).toString():'<<ilegible>>';return R(201,null)}
      if(p.includes('/actions/secrets/')&&m==='DELETE'){secretos[p.split('/').pop()]='<<borrado>>';return R(204,null)}
      if(p.endsWith('/dispatches')){despachos.push(p.split('/')[6]);return R(204,null)}
      if(p.endsWith('/instalar.yml/runs'))return R(200,{workflow_runs:[{status:'completed',conclusion:'success',created_at:new Date().toISOString(),html_url:'https://github.com/x'}]});
      if(p.endsWith('/contents/kumo.json'))return R(200,{content:Buffer.from(JSON.stringify({url:appUrl})).toString('base64')});
    }
    if(url.startsWith(appUrl)){
      const tok=(o.headers||{}).Authorization;
      if(tok!=='Bearer '+secretos.KUMO_APP_TOKEN)return R(401,{error:'Token inválido'});
      if(p==='/api/estado')return R(200,{config:{modo:'simulacion',quote:'USD',objetivo:{}},ciclo:0});
      if(p==='/api/config')return R(200,{ok:true,config:{quote:JSON.parse(o.body||'{}').quote}});
    }
    return R(404,{message:'no mock '+url});
  };
  const abiertos=[];
  const nativo=w=>({estado:()=>'{}',barras(){},abrirUrl(u){abiertos.push(u)},config(){},
    http(id,met,url,cab,cuerpo){const h=JSON.parse(cab);let st=200,dat={};
      if(url.includes('/accounts'))dat=h.Authorization==='Bearer cf-bueno'?{success:true,result:[{id:'acc123456789',name:'Cuenta de Amigo'}]}:{success:false,result:null};
      else if(url.includes('groq.com'))dat={data:[{id:'m1'},{id:'m2'}]};
      setTimeout(()=>w.kumoHttp(id,st,JSON.stringify(dat)),5)}});
  const {w,d,errores}=crear(fetchMock,nativo);
  await espera(30);
  click(d,'#tutoCerrar');w.__kumo.irPaso('inicio');click(d,'[data-paso="inicio"] [data-ir="gh"]');
  ok(d.getElementById('tuto').classList.contains('open')&&d.querySelector('.paso.activo').dataset.paso==='inicio','«Crear mi nube» exige ver el tutorial');
  for(let i=0;i<5;i++)click(d,'#tutoSig');d.getElementById('tutoOk').checked=true;d.getElementById('tutoOk').dispatchEvent(new w.Event('change'));click(d,'#tutoSig');
  ok(d.querySelector('.paso.activo').dataset.paso==='gh','tras el tutorial continúa al paso de GitHub');
  d.getElementById('ghToken').value='ghp_prueba';click(d,'#ghSig');await espera(600);
  ok(d.querySelector('.paso.activo').dataset.paso==='cf','GitHub validado → Cloudflare ('+d.getElementById('ghValida').textContent+')');
  d.getElementById('cfToken').value='cf-malo';click(d,'#cfSig');await espera(60);
  ok(/rechazó/.test(d.getElementById('cfValida').textContent),'token de Cloudflare inválido detectado');
  d.getElementById('cfToken').value='cf-bueno';click(d,'#cfSig');await espera(600);
  ok(d.querySelector('.paso.activo').dataset.paso==='groq','Cloudflare validado y cuenta detectada');
  d.getElementById('groqKey').value='gsk_prueba';click(d,'#groqSig');await espera(600);
  ok(d.querySelector('.paso.activo').dataset.paso==='ex','Groq validado');
  d.getElementById('exId').value='kraken';d.getElementById('exId').dispatchEvent(new w.Event('change'));
  ok(d.getElementById('exQuote').options.length===3,'monedas base de Kraken');
  click(d,'#exSig');ok(/Falta la API key/.test(d.getElementById('exValida').textContent),'pide claves del exchange');
  d.getElementById('exKey').value='kk';click(d,'#exSig');ok(/Falta el secret/.test(d.getElementById('exValida').textContent),'secret obligatorio, con explicación');
  d.getElementById('exSecret').value='kk';click(d,'#exSig');ok(/iguales/.test(d.getElementById('exValida').textContent),'detecta API key pegada como secret');
  ok(![...d.querySelectorAll('#exId option')].some(o=>/binance|bybit|okx|kucoin|bitget/.test(o.value)),'sin exchanges que bloquean EE. UU.');
  d.getElementById('exId').value='hyperliquid';d.getElementById('exId').dispatchEvent(new w.Event('change'));
  ok(/Dirección/.test(d.getElementById('exKeyT').textContent)&&/sin KYC|Sin KYC/.test(d.getElementById('exNota').textContent),'Hyperliquid sin KYC con campos de billetera');
  d.getElementById('exKey').value='0x123';d.getElementById('exSecret').value='abc';click(d,'#exSig');ok(/0x \+ 40/.test(d.getElementById('exValida').textContent),'valida formato de billetera');
  d.getElementById('exId').value='kraken';d.getElementById('exId').dispatchEvent(new w.Event('change'));d.getElementById('exKey').value='';d.getElementById('exSecret').value='';
  d.getElementById('exKey').value='kk';d.getElementById('exSecret').value='ss';d.getElementById('exQuote').value='USD';click(d,'#exSig');
  ok(d.querySelector('.paso.activo').dataset.paso==='resumen','resumen');
  ok(d.querySelectorAll('#resumen .badge.buy').length===4,'resumen con 4 OK');
  click(d,'#instalar');
  for(let i=0;i<40&&d.querySelector('.paso.activo').dataset.paso!=='fin';i++)await espera(200);
  console.log('   log:',[...d.querySelectorAll('#instLog div')].map(x=>x.textContent).join(' | '));
  ok(d.querySelector('.paso.activo').dataset.paso==='fin','instalación completa → ¡NUBE ONLINE!');
  const S=w.__kumo.S;
  ok(sinToken.length===0,"todas las llamadas a GitHub llevan token: "+sinToken.join(", "));
  ok(S.url===appUrl&&S.token===secretos.KUMO_APP_TOKEN&&S.token.length===48,'app conectada con el token generado');
  ok(secretos.CLOUDFLARE_API_TOKEN==='cf-bueno'&&secretos.CLOUDFLARE_ACCOUNT_ID==='acc123456789'&&secretos.GROQ_API_KEY==='gsk_prueba','secretos de nube descifrables por GitHub');
  ok(secretos.EXCHANGE_ID==='kraken'&&secretos.EXCHANGE_API_KEY==='kk'&&secretos.EXCHANGE_SECRET==='ss'&&secretos.EXCHANGE_PASSWORD==='<<borrado>>','secretos del exchange');
  ok(secretos.KUMO_RUNNER_TOKEN&&secretos.KUMO_RUNNER_TOKEN!==S.token,'token del runner distinto');
  ok(despachos.join()==='instalar.yml,ciclo.yml','lanzó instalar y luego el primer ciclo');
  ok(!JSON.stringify(S).includes('cf-bueno')&&!JSON.stringify(S).includes('gsk_')&&!JSON.stringify(S).includes('"kk"'),'claves de Cloudflare/Groq/exchange NO quedan en el teléfono');
  ok(d.getElementById('exKey').value===''&&d.getElementById('cfToken').value==='','campos de claves vaciados');
  click(d,'#finEntrar');await espera(50);
  ok(d.getElementById('conn').textContent.includes('EN LÍNEA'),'app en línea con la nube nueva');
  await espera(300);
  ok(!d.getElementById('updBanda').classList.contains('oculto')&&/v9\.9\.9/.test(d.getElementById('updBanda').textContent),'banda de nueva versión visible');
  ok(d.getElementById('modal').classList.contains('open')&&/v9\.9\.9/.test(d.getElementById('mTitulo').textContent)&&/Novedades de prueba/.test(d.getElementById('mExtra').textContent),'aviso de actualización al entrar a la app (no durante el asistente)');
  click(d,'#mSi');await espera(20);
  ok(abiertos.some(u=>/KumoBot-v9\.9\.9\.apk$/.test(u)),'DESCARGAR abre la APK nueva');
  ok(w.__kumo.S.updVisto==='v9.9.9','no vuelve a saltar el mismo aviso');
  click(d,'#buscarUpd');await espera(50);
  ok(d.getElementById('modal').classList.contains('open'),'BUSCAR ACTUALIZACIÓN vuelve a ofrecerla');click(d,'#mNo');
  await espera(20);click(d,'#actualizarNube');await espera(20);click(d,'#mSi');
  for(let i=0;i<30&&!git.some(x=>x.startsWith('ref:'));i++)await espera(50);await espera(100);
  ok(git.join('|')==='blob:cHJpbnQoMSk=|tree:base1:runner/exchanges.py=blobN|commit:base1|ref:comN','ACTUALIZAR NUBE copia solo lo que cambió: '+git.join('|'));
  ok(despachos.slice(-1)[0]==='instalar.yml','y vuelve a desplegar la nube');
  ok(sinToken.length===0,'actualizar nube con token');
  ok(errores.length===0,'sin errores JS: '+errores.join(' | '));
 }
 console.log(fallos?`\n${fallos} FALLOS`:'\nTODO OK');process.exit(fallos?1:0);
})().catch(e=>{console.error(e);process.exit(1)});
