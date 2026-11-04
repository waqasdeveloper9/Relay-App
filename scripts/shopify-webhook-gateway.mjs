import http from 'node:http';
// Only provider webhooks are public. The application verifies signatures and handshake tokens.
http.createServer((req,res)=>{
 const u=new URL(req.url??'/', 'http://127.0.0.1');
 const meta=/^\/api\/webhooks\/meta\/[0-9a-f-]{36}$/i.test(u.pathname);
 const shop=u.pathname==='/api/webhooks/shopify';
 if(!((meta&&['GET','POST'].includes(req.method))||(shop&&req.method==='POST'))){res.writeHead(404);res.end();return;}
 if(req.method==='POST'&&!(meta?req.headers['x-hub-signature-256']:req.headers['x-shopify-hmac-sha256'])){res.writeHead(401);res.end();return;}
 const upstream=http.request({hostname:'127.0.0.1',port:3001,path:u.pathname+u.search,method:req.method,headers:{...req.headers,host:'127.0.0.1:3001'}},r=>{res.writeHead(r.statusCode??502,{'content-type':r.headers['content-type']??'application/json'});r.pipe(res);});
 upstream.setTimeout(20000,()=>upstream.destroy());upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});req.pipe(upstream);
}).listen(3002,'127.0.0.1',()=>console.log('Webhook-only gateway: 127.0.0.1:3002'));
