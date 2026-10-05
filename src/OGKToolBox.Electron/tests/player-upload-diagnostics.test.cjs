const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const file = path.resolve(__dirname, '../electron/player-upload-diagnostics.ts');
const loaded = new Module(file, module); loaded.filename = file; loaded.paths = module.paths;
loaded._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText, file);
const {PlayerUploadError,playerUploadResponseDiagnostic,safePlayerUploadDiagnostic} = loaded.exports;
const traceId = 'c31b0778-947f-4a76-801a-bd382c958914';

test('structured server diagnostics expose only whitelisted categories and field names, never echoed secrets or stack',()=>{
  const secrets=['12345678901234567890','A1234567890','PLAYER_PRIVATE_NAME','https://private.invalid/secret-session/','abcdefabcdefabcdefabcdefabcdefab#42'];
  const body={returnCode:0,error:'Cannot read properties of undefined',message:`Missing required field userOption; userId=42 card=${secrets[0]} user=${secrets[2]} ${secrets[3]} ${secrets[4]}`,traceId,
    request:{accessCode:secrets[0]},stack:`PrivateStack ${secrets.join(' ')} userData.secret`,errors:[{field:'userData[0].medalCount',message:'must be an integer'}, {field:`secret_${secrets[0]}`,message:'bad value'}]};
  const diagnostic=playerUploadResponseDiagnostic(500,body,{},secrets);
  assert.equal(diagnostic.category,'missing_field');assert.equal(diagnostic.stage,'http');assert.equal(diagnostic.status,500);assert.equal(diagnostic.returnCode,0);assert.equal(diagnostic.traceId,traceId);
  assert.ok(diagnostic.fields.includes('userOption'));assert.ok(diagnostic.fields.includes('userData.medalCount'));
  const error=new PlayerUploadError(diagnostic),serialized=JSON.stringify(error);
  assert.equal(error.stack,undefined);assert.ok(!('cause' in error));assert.ok(Object.isFrozen(error.diagnostic));
  for(const secret of secrets)assert.ok(!error.message.includes(secret)&&!serialized.includes(secret));
  assert.ok(!serialized.includes('PrivateStack'));assert.ok(!serialized.includes('Missing required'));
  assert.match(error.message,/存档上传/);assert.ok(!error.message.includes('合并成绩'));
});

test('known response signatures classify types, session, constraints and authentication without asserting an unknown null-pointer cause',()=>{
  for(const [message,expected] of [['Cannot deserialize value of type integer from Array value','type_mismatch'],['GameLogin is required: session missing','session_required'],['Foreign key constraint violation','database_constraint'],['Authentication failed','authentication'],['Value out of range','value_out_of_range'],['java.lang.NullPointerException','server_error']])assert.equal(playerUploadResponseDiagnostic(500,{message}).category,expected);
  assert.equal(playerUploadResponseDiagnostic(200,{returnCode:0}).category,'server_rejected');
  assert.equal(playerUploadResponseDiagnostic(403,{}).category,'authentication');
  assert.equal(playerUploadResponseDiagnostic(429,{}).category,'rate_limited');
  assert.equal(playerUploadResponseDiagnostic(501,{}).category,'unsupported_api');
});

test('trace extraction accepts standard IDs only and rejects cards, player IDs, UA hashes, URLs and private values disguised as IDs',()=>{
  const hash='abcdefabcdefabcdefabcdefabcdefab';
  for(const value of ['42','12345678901234567890',`${hash}#42`,'https://private.invalid/trace','00000000000000000000000000000000',hash])assert.equal(playerUploadResponseDiagnostic(500,{}, {'x-request-id':value}, [hash]).traceId,undefined);
  assert.equal(playerUploadResponseDiagnostic(500,{}, {'x-request-id':traceId}, [traceId]).traceId,undefined);
  assert.equal(playerUploadResponseDiagnostic(500,{}, {traceparent:'00-c31b0778947f4a76801abd382c958914-0123456789abcdef-01'}).traceId,'c31b0778947f4a76801abd382c958914');
  assert.equal(playerUploadResponseDiagnostic(500,{requestId:traceId}).traceId,traceId);
  assert.equal(playerUploadResponseDiagnostic(200,{returnCode:42},{},['42']).returnCode,undefined);
});

test('plain HTML and unexpected JSON cannot be copied into diagnostic properties',()=>{
  for(const body of ['<html><body>Private card 12345678901234567890 userOption</body></html>',{payload:'private card 12345678901234567890',stack:'private-stack'},null,[],{errors:Array.from({length:10000},()=>({field:'privateField',message:'private value'}))}]){
    const diagnostic=playerUploadResponseDiagnostic(500,body);
    assert.deepEqual(Object.keys(diagnostic).sort(),['category','stage','status']);
  }
  const safe=safePlayerUploadDiagnostic({stage:'http',category:'server_error',status:500,raw:'secret',stack:'secret',fields:['userData[0].medalCount','custom.secret','userData.12345678901234567890'],traceId:'private',returnCode:123456789});
  assert.deepEqual(safe,{stage:'http',category:'server_error',status:500,fields:['userData.medalCount']});
  assert.equal(safePlayerUploadDiagnostic({stage:'http',category:'arbitrary secret'}),undefined);
});
