import {mockS3} from '../tests/support/s3.mjs';
import {publish} from './publish.mjs';
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const service=await mockS3();
try{
 const manifest=JSON.parse(await readFile('dist/manifest.json','utf8'));
 const options={env:{...service.env,ENGINE_EXPECTED_SHA:manifest.sourceCommit},receiptPath:'build/publication-selftest.json'};
 const receipt=await publish(options),count=service.puts.length;
 await publish(options);assert.equal(service.puts.length,count,'Replay overwrote immutable objects');
 console.log(JSON.stringify({scope:'Real release bytes through loopback S3 protocol double, not Cloudflare acceptance',...receipt,replayWithoutOverwrite:true}));
}finally{await service.close();}
