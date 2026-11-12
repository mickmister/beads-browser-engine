import {createServer} from 'node:http';
import assert from 'node:assert/strict';

// Loopback S3 protocol double. Real HTTP exercises signing headers, gzip decoding,
// conditional creation, CORS merge, private readback and public delivery paths.
export async function mockS3(){
 const objects=new Map(),puts=[];let cors='<?xml version="1.0"?><CORSConfiguration><CORSRule><ID>another-app</ID><AllowedOrigin>https://another.invalid</AllowedOrigin><AllowedMethod>GET</AllowedMethod></CORSRule></CORSConfiguration>';
 let badCors=false,conditionalRace=false;
 const server=createServer(async(req,res)=>{
  try{
   const url=new URL(req.url,'http://localhost');
   if(url.pathname.startsWith('/bucket/')){
    assert.match(req.headers.authorization??'',/^AWS4-HMAC-SHA256 Credential=test-key\//);
    if(url.searchParams.has('cors')){
     if(req.method==='GET'){res.setHeader('content-type','application/xml');res.end(cors);return;}
     const body=[];for await(const chunk of req)body.push(chunk);cors=Buffer.concat(body).toString();res.statusCode=200;res.end();return;
    }
    const key=decodeURIComponent(url.pathname.slice('/bucket/'.length));
    if(req.method==='PUT'){
     assert.equal(req.headers['if-none-match'],'*');const body=[];for await(const chunk of req)body.push(chunk);
     if(objects.has(key)){res.statusCode=412;res.end();return;}
     objects.set(key,{bytes:Buffer.concat(body),headers:{...req.headers}});puts.push(key);res.statusCode=conditionalRace?412:200;conditionalRace=false;res.end();return;
    }
    const object=objects.get(key);if(!object){res.statusCode=404;res.end('missing');return;}
    for(const name of ['content-type','content-encoding','cache-control'])if(object.headers[name])res.setHeader(name,object.headers[name]);res.end(object.bytes);return;
   }
   const key='prefix'+url.pathname.slice('/public'.length),object=objects.get(key);
   if(!object){res.statusCode=404;res.end();return;}
   for(const name of ['content-type','content-encoding','cache-control'])if(object.headers[name])res.setHeader(name,object.headers[name]);
   if(!badCors)res.setHeader('access-control-allow-origin',req.headers.origin??'*');res.end(object.bytes);
  }catch(error){res.statusCode=500;res.end(error.message);}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin=`http://127.0.0.1:${server.address().port}`;
 const env={S3_ENDPOINT:origin,S3_REGION:'auto',S3_BUCKET:'bucket',S3_ACCESS_KEY_ID:'test-key',S3_SECRET_ACCESS_KEY:'test-secret',S3_KEY_PREFIX:'prefix',S3_PUBLIC_BASE_URL:origin+'/public/',S3_CORS_ALLOWED_ORIGINS:'["https://app.invalid"]'};
 return{objects,puts,env,get cors(){return cors},badCors(){badCors=true},race(){conditionalRace=true},async close(){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
}
