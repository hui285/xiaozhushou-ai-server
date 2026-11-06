import test from 'node:test';
import assert from 'node:assert/strict';
process.env.APP_ACCESS_TOKEN = 'test-long-secret';
process.env.ALLOWED_ORIGINS = 'https://appassets.androidplatform.net';
const {server} = await import('./server.mjs');
test('backend requires access token and enforces CORS before accepting photos',async ()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const url=`http://127.0.0.1:${server.address().port}`;
 try{
  const health = await fetch(url+'/health',{headers:{
   Origin:'https://appassets.androidplatform.net',
   'X-App-Access-Token':'test-long-secret'}});
  assert.equal(health.status,200);
  assert.equal((await health.json()).status,'ok');
  const badKey=await fetch(url+'/health',{headers:{'X-App-Access-Token':'wrong'}});
  assert.equal(badKey.status,401);
  const badOrigin=await fetch(url+'/health',{headers:{
   Origin:'https://attacker.example','X-App-Access-Token':'test-long-secret'}});
  assert.equal(badOrigin.status,403);
  const options=await fetch(url+'/api/recognize',{method:'OPTIONS',headers:{
   Origin:'https://appassets.androidplatform.net'}});
  assert.equal(options.status,204);
  assert.match(options.headers.get('access-control-allow-headers'),/X-App-Access-Token/);
 }finally{
  await new Promise(resolve=>server.close(resolve));
 }
});
